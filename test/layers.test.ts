import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildLayers, classifyDepth, delegatedCalls, hollowFunctions, isEntryPoint, isStub, joinLayers, mountRoutes, scanFileLayer } from "../src/layers-core.ts";
import type { CommitLayer, LayerCommit } from "../src/layers-core.ts";
import { runFile, runLaminae, TestRepo, writeClaims } from "./helpers.ts";
import type { LayerReport } from "../src/layers-core.ts";

test("isStub：只有注释、空文件、写着没实现的是空壳；有实际代码的不是", () => {
  assert.equal(isStub(""), true);
  assert.equal(isStub("// 只有注释\n\n/* 块注释 */\n"), true);
  assert.equal(isStub("throw new Error('not implemented')\n"), true);
  assert.equal(isStub("raise NotImplementedError\n"), true);
  assert.equal(isStub("// 未实现\n"), true);
  assert.equal(isStub("export { a } from './a'\n"), false, "重新导出是实际代码");
  assert.equal(isStub("export function run() {\n  return 1\n}\n"), false);
});

test("hollowFunctions：只标有问题的具名函数和它的行，不把整个文件算进去", () => {
  const text = ["export function real() {", "  return work()", "}", "export function later() {", "  raise NotImplementedError()", "}", ""].join("\n");
  // JS 文件里 raise 不会被当成函数体语法；用 Python 定义
  const py = ["def real(self):", "    return work()", "def later(self):", "    raise NotImplementedError()", ""].join("\n");
  const found = hollowFunctions(py);
  assert.deepEqual(found.map((f) => f.name), ["later"]);
  assert.equal(found[0]!.line, 3);
  assert.equal(found[0]!.reason, "unimplemented");
  assert.equal(hollowFunctions(text).some((f) => f.name === "real"), false);
});

test("delegatedCalls：函数体只有一句调用时记下来", () => {
  const text = "import { later } from './b'\nexport function run() {\n  return later(1)\n}\n";
  assert.deepEqual(delegatedCalls(text), [{ name: "run", line: 2, callee: "later" }]);
});

test("buildLayers：跨文件调用追到写着没实现的函数，最多两跳", () => {
  const data = buildLayers([
    commit(["src/a.ts", "src/mid.ts", "src/b.ts"], [], {
      facts: [
        { file: "src/a.ts", depth: "substantive", trivialFns: [], forwardTo: [], reexports: [], imports: [{ local: "mid", imported: "mid", spec: "./mid" }] },
        { file: "src/mid.ts", depth: "substantive", trivialFns: [], forwardTo: [], reexports: [], imports: [{ local: "later", imported: "later", spec: "./b" }] },
        { file: "src/b.ts", depth: "substantive", trivialFns: ["later"], forwardTo: [], reexports: [] },
      ],
      hollowFns: [{ file: "src/b.ts", name: "later", line: 1, reason: "unimplemented" }],
      delegates: [
        { file: "src/a.ts", name: "run", line: 4, callee: "mid" },
        { file: "src/mid.ts", name: "mid", line: 2, callee: "later" },
      ],
    }),
  ]);
  const mid = data.down.find((d) => d.name === "mid");
  const run = data.down.find((d) => d.name === "run");
  assert.equal(mid?.via, "src/b.ts:later");
  assert.equal(run?.reason, "calls-other");
  assert.equal(run?.via, "src/mid.ts:mid");
});

test("isEntryPoint：主文件、index 和 bin、cmd 下的命令是入口", () => {
  for (const f of ["index.ts", "src/index.ts", "src/main.py", "src/__init__.py", "bin/lint.ts", "cmd/tool.go", "setup.py"]) {
    assert.equal(isEntryPoint(f), true, f);
  }
  assert.equal(isEntryPoint("src/util.ts"), false);
  assert.equal(isEntryPoint("src/server/routes.ts"), false, "目录名带 server 不算入口，只看文件名和 bin/cmd");
});

test("scanFileLayer：路由声明与引用，模板字符串和查询串不算进名字", () => {
  const js = ["app.get('/api/users', h)", "router.post(`/api/items/${id}`, h)", "fetch('/api/users?x=1')", "axios.get('/api/other')"].join("\n");
  const l = scanFileLayer(js);
  assert.deepEqual(l.declares.map((d) => d.name), ["/api/users"]);
  assert.deepEqual(l.references.map((r) => r.name).sort(), ["/api/other", "/api/users"]);

  const py = "@app.route('/api/users')\ndef f():\n    pass\n";
  assert.deepEqual(scanFileLayer(py).declares.map((d) => d.name), ["/api/users"]);
  assert.equal(scanFileLayer(py).stub, false);
});

const piece = (file: string, text: string) => {
  const l = scanFileLayer(text);
  return { file, imports: l.imports, routers: l.routers, mounts: l.mounts, declares: l.declares };
};

test("mountRoutes：APIRouter 与 include_router 的前缀拼到装饰器路径上", () => {
  const users = ['router = APIRouter(prefix="/users")', '@router.get("/list")', "def list_users():", "    return {'ok': True}", ""].join("\n");
  const main = ["from users import router as users_router", "app = FastAPI()", 'app.include_router(users_router, prefix="/api/v1")', ""].join("\n");
  const mounted = mountRoutes([piece("users.py", users), piece("main.py", main)], (from, spec, imported) =>
    from === "main.py" && spec === "users" && imported === "router" ? ["users.py"] : [],
  );
  assert.deepEqual(
    mounted.map((d) => d.name),
    ["/api/v1/users/list"],
  );

  const same = ['router = APIRouter(prefix="/users")', '@router.get("/list")', "def list_users():", "    return 1", "app = FastAPI()", 'app.include_router(router, prefix="/api/v1")', ""].join("\n");
  assert.deepEqual(mountRoutes([piece("app.py", same)], () => []).map((d) => d.name), ["/api/v1/users/list"]);

  const bare = "@app.route('/api/users')\ndef f():\n    pass\n";
  const kept = mountRoutes([piece("a.py", bare)], () => []);
  assert.deepEqual(kept.map((d) => d.name), ["/api/users"]);
  assert.equal(kept[0]?.handler, "trivial");
});

test("mountRoutes：点属性挂载和嵌套 include 都拼进路径", () => {
  const users = ['router = APIRouter(prefix="/users")', '@router.get("/list")', "def list_users():", "    return 1", ""].join("\n");
  const api = ["from .users import router as users_router", 'api = APIRouter(prefix="/v1")', "api.include_router(users_router)", ""].join("\n");
  const main = ["from .api import api", "app = FastAPI()", 'app.include_router(api, prefix="/api")', ""].join("\n");
  const names = mountRoutes([piece("users.py", users), piece("api.py", api), piece("main.py", main)], (from, spec, imported) => {
    if (from === "api.py" && spec === ".users" && imported === "router") return ["users.py"];
    if (from === "main.py" && spec === ".api" && imported === "api") return ["api.py"];
    return [];
  }).map((d) => d.name);
  assert.deepEqual(names, ["/api/v1/users/list"]);
});

test("scanFileLayer：注入线索只标出调用点，超大文件和二进制不看", () => {
  const l = scanFileLayer("const x = eval(input)\nel.innerHTML = input\n");
  assert.deepEqual(l.clues.sort(), ["eval", "innerHTML"]);
  assert.equal(scanFileLayer("a".repeat(600 * 1024)).stub, false);
  assert.deepEqual(scanFileLayer("a\u0000b").clues, []);
});

const layer = (p: Partial<CommitLayer> = {}): CommitLayer => ({ stubs: [], facts: [], declares: [], references: [], clues: [], ...p });

const commit = (files: string[], edges: [string, string][] = [], l: Partial<CommitLayer> = {}): LayerCommit => ({
  files,
  edges,
  layer: layer(l),
});

test("buildLayers：孤立模块排除入口、测试和被引用的文件", () => {
  const data = buildLayers([
    commit(["src/index.ts", "src/used.ts", "src/dead.ts", "src/used.test.ts"], [["src/index.ts", "src/used.ts"], ["src/used.test.ts", "src/used.ts"]]),
  ]);
  assert.deepEqual(data.unreferenced.map((u) => u.file), ["src/dead.ts"]);
});

test("buildLayers：契约缺任何一侧都不算对不上，两侧都在才比较", () => {
  const onlyRefs = buildLayers([commit(["a.ts"], [], { references: [{ kind: "route", name: "/api/x", file: "a.ts" }] })]);
  assert.equal(onlyRefs.contracts[0]!.unmet.length, 0, "只有引用、没有声明：可能是在调外部服务");
  assert.equal(onlyRefs.contracts[0]!.declared.length, 0);

  const onlyDecls = buildLayers([commit(["a.ts"], [], { declares: [{ kind: "route", name: "/api/x", file: "a.ts" }] })]);
  assert.equal(onlyDecls.contracts[0]!.unmet.length, 0, "只有声明、没有引用：调用方可以在仓库外");

  const both = buildLayers([
    commit(["a.ts", "b.ts"], [], {
      declares: [{ kind: "route", name: "/api/users", file: "a.ts" }],
      references: [
        { kind: "route", name: "/api/users", file: "b.ts" },
        { kind: "route", name: "/api/missing", file: "b.ts" },
      ],
    }),
  ]);
  assert.deepEqual(both.contracts[0]!.unmet.map((u) => u.name), ["/api/missing"]);
});

test("joinLayers：上层成立且支撑文件是空壳才算孔；被提到的文件不算孤立", () => {
  const data = buildLayers([
    commit(["src/feature.ts", "src/dead.ts", "src/noted.ts"], [], { stubs: ["src/feature.ts"] }),
    commit(["src/feature.ts", "src/dead.ts", "src/noted.ts"], [], {}),
  ]);
  const report = joinLayers(data, [
    { kind: "claim", label: "导出功能", states: [0, 0], files: ["src/feature.ts"] },
    { kind: "idea", label: "做 noted", states: [1, 0], files: ["src/noted.ts"] },
  ]);
  assert.deepEqual(
    report.hollow,
    [{ kind: "claim", label: "导出功能", file: "src/feature.ts", depth: "unimplemented", alive: [[0, 0]] }],
    "只在它既为真又是空壳的 commit 上算",
  );
  assert.deepEqual(report.orphans.map((o) => o.file), ["src/dead.ts"], "被想法提到的 noted 不算孤立");
});

test("classifyDepth：空、没实现、空函数、纯转发、有代码，五档分开", () => {
  assert.equal(classifyDepth("// 只有注释\n"), "empty");
  assert.equal(classifyDepth("throw new Error('not implemented')\n"), "unimplemented");
  assert.equal(
    classifyDepth("export function real() {\n  return work()\n}\nexport function later() {\n  throw new Error('not implemented')\n}\n"),
    "substantive",
    "一个抽象方法写着没实现，不能把整个文件判成假实现",
  );
  assert.equal(classifyDepth("export function run() {\n  return null\n}\n"), "placeholder");
  assert.equal(classifyDepth("export function run() {\n  return 1\n}\n"), "placeholder", "只返回数字，和 return null 一样算假实现");
  assert.equal(classifyDepth("function empty() {\n  return null\n}\nexport function run() {\n  return empty()\n}\n"), "placeholder", "只转去调用同一个文件里的空函数");
  assert.equal(classifyDepth("export const empty = () => []\n"), "placeholder");
  assert.equal(classifyDepth("def load():\n    pass\n"), "placeholder");
  assert.equal(classifyDepth("export { a } from './a'\n"), "forward");
  assert.equal(classifyDepth("export function run() {\n  return work()\n}\n"), "substantive");
  assert.equal(classifyDepth("export const n = 1\n"), "substantive");
});

test("scanFileLayer：空处理函数算假实现，函数里有调用的不算", () => {
  assert.equal(scanFileLayer("app.get('/api/users', () => {})\n").declares[0]?.handler, "trivial");
  assert.equal(scanFileLayer("app.get('/api/users', () => { return load() })\n").declares[0]?.handler, "substantive");
  assert.equal(scanFileLayer("function list() { return null }\napp.get('/api/users', list)\n").declares[0]?.handler, "trivial");
  assert.equal(scanFileLayer("@Get('/api/users')\nusers() {\n  return null\n}\n").declares[0]?.handler, "trivial");
  assert.ok(scanFileLayer("os.system(cmd)\n").clues.includes("os-system"));
  const imported = scanFileLayer("import { list } from './list'\napp.get('/api/users', list)\n");
  assert.equal(imported.declares[0]?.handler, "missing");
  assert.equal(imported.declares[0]?.via, "./list");
});

test("buildLayers：处理函数追到另一个空文件，路径对上了也算假实现", () => {
  const data = buildLayers([
    commit(["src/api.ts", "src/list.ts", "src/web.ts"], [["src/api.ts", "src/list.ts"]], {
      facts: [
        { file: "src/api.ts", depth: "substantive", trivialFns: [], forwardTo: [], reexports: [] },
        { file: "src/list.ts", depth: "placeholder", trivialFns: ["list"], forwardTo: [], reexports: [] },
      ],
      declares: [{ kind: "route", name: "/api/users", file: "src/api.ts", handler: "missing", via: "./list", imported: "list" }],
      references: [{ kind: "route", name: "/api/users", file: "src/web.ts" }],
    }),
  ]);
  assert.equal(data.contracts[0]!.unmet.length, 0, "路径本身对得上");
  assert.equal(data.contracts[0]!.fake.length, 1);
});

test("joinLayers：下限差额大算被措辞盖住；有实质代码的单列，不叫真实现", () => {
  const data = buildLayers([
    commit(["src/real.ts", "src/used.test.ts"], [["src/used.test.ts", "src/real.ts"]], {
      facts: [{ file: "src/real.ts", depth: "substantive", trivialFns: [], forwardTo: [], reexports: [] }],
    }),
  ]);
  const report = joinLayers(data, [
    { kind: "claim", label: "图标", states: [0], files: [], compare: "gte", claimed: [1000], actual: [1539] },
    { kind: "claim", label: "真有代码", states: [0], files: ["src/real.ts"] },
  ]);
  assert.equal(report.hollow.length, 0);
  assert.ok(report.covers.some((c) => c.how === "loose-compare" && c.detail.includes("1000")));
  const small = joinLayers(data, [{ kind: "claim", label: "关数", states: [0], files: [], compare: "gte", claimed: [5], actual: [6] }]);
  assert.ok(!small.covers.some((c) => c.how === "loose-compare"), "只差 1 的小计数不记成措辞盖住");
  const wide = joinLayers(data, [{ kind: "claim", label: "图标", states: [0], files: [], compare: "gte", claimed: [1600], actual: [1899] }]);
  assert.ok(wide.covers.some((c) => c.how === "loose-compare"), "1600 和 1899 又差比例又差绝对数量");
  assert.ok(report.covers.some((c) => c.how === "test-only" && c.label === "src/real.ts"));
  assert.deepEqual(report.unproven.map((u) => u.file), ["src/real.ts"]);
});

test("joinLayers：近似比较、区间、只有一侧的契约", () => {
  const data = buildLayers([
    commit(["a.ts"], [], { references: [{ kind: "route", name: "/api/x", file: "a.ts" }] }),
  ]);
  const report = joinLayers(data, [
    { kind: "claim", label: "大约", states: [0], files: [], compare: "approx", claimed: [1000], actual: [1200] },
    { kind: "claim", label: "区间", states: [0], files: [], verbatim: "提供 1600-1800 个图标" },
  ]);
  assert.ok(report.covers.some((c) => c.how === "loose-compare" && c.label === "大约"));
  assert.ok(report.covers.some((c) => c.how === "range" && c.detail.includes("1600-1800")));
  assert.ok(report.covers.some((c) => c.how === "one-sided" && c.detail.includes("不把它当成洞")));
});

test("端到端：空壳支撑、对不上的路由、孤立模块都进到报告里", () => {
  const repo = new TestRepo();
  try {
    repo.commit(
      {
        "README.md": "功能：导出\n共 2+ 个\n",
        "src/feature.ts": "// 功能：导出\nthrow new Error('not implemented')\n",
        "src/server.ts": "app.get('/api/users', () => {})\n",
        "src/client.ts": "fetch('/api/users')\nfetch('/api/missing')\n",
        "src/dead.ts": "export const dead = 1\n",
        "src/impl.ts": "export const impl = 1\n",
        "src/barrel.ts": "// 功能：导出\nexport { impl } from './impl'\n",
        "src/only.ts": "export const only = 1\n",
        "src/only.test.ts": "import './only'\n",
        "src/index.ts": "import './server'\n",
      },
      "c0",
    );
    writeClaims(repo, [
      { id: "feat", label: "导出功能", file: "README.md", locator: "(功能：导出)", fact: { type: "text-in-file", file: "src/feature.ts" } },
      { id: "fwd", label: "转发模块", file: "README.md", locator: "(功能：导出)", fact: { type: "text-in-file", file: "src/barrel.ts" } },
      { id: "floor", label: "文件数下限", file: "README.md", locator: "共 (\\d+)\\+ 个", fact: { type: "count-files", glob: "src/*.ts" }, compare: "gte" },
    ]);
    runLaminae(repo, "scripts/run.ts", ["data"]);

    const payload = JSON.parse(fs.readFileSync(runFile(repo, "payload.json"), "utf8")) as { layers?: LayerReport };
    const l = payload.layers!;
    assert.ok(l, "报告里有层与层的对账");
    assert.deepEqual(l.hollow.map((h) => [h.kind, h.file, h.depth]), [["claim", "src/feature.ts", "unimplemented"]]);
    assert.ok(l.covers.some((c) => c.how === "forward" && c.detail.includes("./impl")), "纯转发不算实现");
    assert.ok(l.covers.some((c) => c.how === "loose-compare"), "2+ 而实际更多，是措辞盖住的");
    assert.ok(l.covers.some((c) => c.how === "test-only" && c.label === "src/only.ts"));
    assert.ok(l.unproven.every((u) => u.file !== "src/feature.ts"), "假实现不放进未证实");
    assert.ok(l.orphans.some((o) => o.file === "src/dead.ts"), "没人引用也没人提到的 dead 是孤立模块");
    assert.ok(!l.orphans.some((o) => o.file === "src/index.ts"), "入口不算孤立");
    const route = l.contracts.find((c) => c.kind === "route")!;
    assert.deepEqual(route.unmet.map((u) => u.name), ["/api/missing"]);
    assert.deepEqual(route.fake.map((f) => f.name), ["/api/users"], "路径对上了，但处理函数是空的");
    assert.ok(route.declared.length > 0 && route.referenced.length > 0, "两侧都存在才比较");
  } finally {
    repo.dispose();
  }
});
