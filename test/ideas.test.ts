import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { collectChecklist, collectTodos, parseChecklist, parseTodo, sampleIndexes } from "../src/ideas/candidates.ts";
import { describeIdea, evalEdge, ideaStateAt, parseIdeas, summarizeIdea } from "../src/ideas/ideas-core.ts";
import type { EdgeFact, EdgeScan } from "../src/ideas/ideas-core.ts";
import { TestRepo, runLaminae, writeClaims } from "./helpers.ts";
import type { Candidates, IdeaTimeline } from "../src/core/types.ts";
import type { Tree } from "../src/measure/facts.ts";

const ok = { id: "a", text: "做 A", target: "src/a.js", fact: { type: "path-exists" } };

const tree = (files: Record<string, string>): Tree => ({
  paths: () => Object.keys(files),
  read: (f) => files[f] ?? null,
});

test("parseIdeas：缺省值——想法应该存在，边界应该不存在", () => {
  const [idea, bound] = parseIdeas([ok, { ...ok, id: "b", boundary: true }]);
  assert.equal(idea!.expect, "present");
  assert.equal(idea!.boundary, false);
  assert.equal(bound!.expect, "absent");
  assert.equal(bound!.boundary, true);
  assert.equal(idea!.source, "");
});

test("parseIdeas：出错时指出哪一条哪个字段", () => {
  assert.throws(() => parseIdeas({}), /必须是数组/);
  assert.throws(() => parseIdeas([{ ...ok, id: "" }]), /ideas\[0\].*id/);
  assert.throws(() => parseIdeas([{ ...ok, text: undefined }]), /text/);
  assert.throws(() => parseIdeas([{ ...ok, target: "" }]), /target/);
  assert.throws(() => parseIdeas([ok, ok]), /重复/);
  assert.throws(() => parseIdeas([{ ...ok, expect: "maybe" }]), /expect/);
  assert.throws(() => parseIdeas([{ ...ok, boundary: "yes" }]), /boundary/);
  assert.throws(() => parseIdeas([{ ...ok, fact: { type: "count-files", glob: "*" } }]), /引用型/);
  assert.throws(() => parseIdeas([{ ...ok, fact: undefined }]), /fact/);
  assert.deepEqual(parseIdeas([]), []);
});

test("ideaStateAt：证据满足 0，不满足 1，读不到 3；方向由 expect 决定", () => {
  const [idea] = parseIdeas([ok]);
  assert.equal(ideaStateAt(idea!, tree({ "src/a.js": "" })), 0);
  assert.equal(ideaStateAt(idea!, tree({ "src/b.js": "" })), 1);

  const [gone] = parseIdeas([{ ...ok, expect: "absent" }]);
  assert.equal(ideaStateAt(gone!, tree({ "src/a.js": "" })), 1);
  assert.equal(ideaStateAt(gone!, tree({})), 0);

  const [txt] = parseIdeas([{ id: "t", text: "t", target: "flask", fact: { type: "text-in-file", file: "setup.py" }, boundary: true }]);
  assert.equal(ideaStateAt(txt!, tree({ "setup.py": "install_requires=['requests']" })), 0, "边界：没出现 = 守住");
  assert.equal(ideaStateAt(txt!, tree({ "setup.py": "install_requires=['flask']" })), 1, "边界：出现了 = 越界");
  assert.equal(ideaStateAt(txt!, tree({})), 3, "setup.py 读不到是测不出来，不是守住");
});

test("describeIdea", () => {
  const [a, b] = parseIdeas([ok, { id: "k", text: "k", target: "build", fact: { type: "json-has-key", file: "package.json", path: "scripts" }, expect: "absent" }]);
  assert.equal(describeIdea(a!), "路径 src/a.js 存在");
  assert.equal(describeIdea(b!), "package.json → scripts 里的键 build 不存在");
});

test("summarizeIdea：第一次满足与退回次数，测不出来不算退回", () => {
  assert.deepEqual(summarizeIdea([1, 1, 0, 0]), { firstMet: 2, regressions: 0 });
  assert.deepEqual(summarizeIdea([1, 0, 1, 0, 1]), { firstMet: 1, regressions: 2 });
  assert.deepEqual(summarizeIdea([0, 3, 0]), { firstMet: 0, regressions: 0 });
  assert.deepEqual(summarizeIdea([0, 3, 1]), { firstMet: 0, regressions: 1 }, "中间测不出来，前后对比仍算退回");
  assert.deepEqual(summarizeIdea([1, 1]), { firstMet: -1, regressions: 0 });
});

test("线索：清单项与 TODO 的解析", () => {
  assert.deepEqual(parseChecklist("- [ ] 写文档"), { text: "写文档", done: false });
  assert.deepEqual(parseChecklist("  * [x] 做完了"), { text: "做完了", done: true });
  assert.deepEqual(parseChecklist("* [X] 大写"), { text: "大写", done: true });
  assert.equal(parseChecklist("- 普通列表"), null);
  assert.equal(parseTodo("  // TODO: 处理空输入"), "处理空输入");
  assert.equal(parseTodo("# FIXME(bob) 这里会崩"), "这里会崩", "署名去掉");
  assert.equal(parseTodo("x = 1  # XXX"), "x = 1  # XXX", "没有说明就留整行");

  const out = ["rev:ROADMAP.md:3:- [x] 完成", "rev:ROADMAP.md:4:- [ ] 未完成", "rev:a.md:1:正文"].join("\n");
  const items = collectChecklist("rev", out);
  assert.deepEqual(items.map((i) => [i.text, i.done, i.line]), [["未完成", false, 4], ["完成", true, 3]], "未勾的排前面");
  assert.deepEqual(collectTodos("rev", "rev:src/a.js:7:  // TODO 补测试").map((i) => [i.file, i.line, i.text]), [["src/a.js", 7, "补测试"]]);
});

test("sampleIndexes：均匀抽样，含首尾", () => {
  assert.deepEqual(sampleIndexes(0, 5), []);
  assert.deepEqual(sampleIndexes(3, 5), [0, 1, 2]);
  const s = sampleIndexes(100, 5);
  assert.equal(s.length, 5);
  assert.equal(s[0], 0);
  assert.equal(s.at(-1), 99);
});

const timeline = (repo: TestRepo): IdeaTimeline[] =>
  JSON.parse(fs.readFileSync(path.join(repo.dir, ".laminae", "data", "ideas-timeline.json"), "utf8")) as IdeaTimeline[];

test("端到端：想法从未完成到完成，又被删掉退回；边界先守住后越界", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "README.md": "x\n" }, "c0");
    repo.commit({ "src/feature.js": "1\n" }, "c1 做出来");
    repo.commit({ "x.txt": "x" }, "c2");
    repo.commit({ "src/feature.js": null }, "c3 被删");
    repo.commit({ "src/extra.js": "1\n" }, "c4 越界");
    writeClaims(repo, [{ id: "c", label: "c", file: "README.md", locator: "(x)", fact: { type: "text-in-file", file: "README.md" } }]);
    fs.writeFileSync(
      path.join(repo.dir, ".laminae", "ideas.json"),
      JSON.stringify([
        { id: "feature", text: "做 feature", target: "src/feature.js", fact: { type: "path-exists" } },
        { id: "no-extra", text: "不做 extra", target: "src/extra.js", fact: { type: "path-exists" }, boundary: true },
        { id: "mentions", text: "文档提到 x", target: "x", fact: { type: "text-in-file", file: "x.txt" } },
      ]),
    );
    runLaminae(repo, "src/ideas/ideas.ts");

    const [feature, noExtra, mentions] = timeline(repo);
    assert.deepEqual(mentions!.evidence, ["x.txt"], "text-in-file 的证据文件要带出来，图上靠它把想法挂到模块");
    assert.deepEqual(feature!.states, [1, 0, 0, 1, 1]);
    assert.equal(feature!.firstMet, 1);
    assert.equal(feature!.regressions, 1);
    assert.equal(feature!.atHead, 1);
    assert.deepEqual(feature!.evidence, [], "路径型证据不读文件");
    assert.deepEqual(noExtra!.states, [0, 0, 0, 0, 1]);
    assert.equal(noExtra!.boundary, true);
    assert.equal(noExtra!.check, "路径 src/extra.js 不存在");
  } finally {
    repo.dispose();
  }
});

test("端到端：没有 ideas.json 时跳过，并清掉上一次留下的旧结果", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "a.txt": "a" });
    fs.mkdirSync(path.join(repo.dir, ".laminae", "data"), { recursive: true });
    const stale = path.join(repo.dir, ".laminae", "data", "ideas-timeline.json");
    fs.writeFileSync(stale, "[]");
    const out = runLaminae(repo, "src/ideas/ideas.ts");
    assert.match(out, /跳过想法与边界/);
    assert.ok(!fs.existsSync(stale), "旧结果不能混进新报告");
  } finally {
    repo.dispose();
  }
});

test("端到端：ideas.json 有错时报出具体位置并失败", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "a.txt": "a" });
    fs.mkdirSync(path.join(repo.dir, ".laminae"), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, ".laminae", "ideas.json"), JSON.stringify([{ id: "x" }]));
    assert.throws(() => runLaminae(repo, "src/ideas/ideas.ts"), /ideas\[0\]/);
  } finally {
    repo.dispose();
  }
});

test("端到端：提取路线图清单与 TODO 作为线索，并画出数量趋势", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "ROADMAP.md": "- [ ] 想法一\n- [ ] 想法二\n", "src/a.js": "// TODO 补错误处理\n" }, "c0");
    repo.commit({ "ROADMAP.md": "- [x] 想法一\n- [ ] 想法二\n" }, "c1 勾掉一个");
    repo.commit({ "src/a.js": "const a = 1\n" }, "c2 TODO 清掉");
    runLaminae(repo, "src/ideas/ideas.ts");

    const c = JSON.parse(fs.readFileSync(path.join(repo.dir, ".laminae", "data", "candidates.json"), "utf8")) as Candidates;
    assert.equal(c.checklist.open, 1);
    assert.equal(c.checklist.done, 1);
    assert.equal(c.checklist.items[0]!.text, "想法二", "未勾的排前面");
    assert.equal(c.todos.total, 0);
    assert.deepEqual(c.trend.at, [0, 1, 2]);
    assert.deepEqual(c.trend.todo, [1, 1, 0]);
    assert.deepEqual(c.trend.open, [2, 1, 1]);
    assert.deepEqual(c.trend.done, [0, 1, 1]);
  } finally {
    repo.dispose();
  }
});

/* ── 引用边界 ── */

const edgeIdea = (extra: Record<string, unknown> = {}): unknown[] => [
  { id: "ui-server", text: "前端不许引用后端", fact: { type: "import-edge", from: "./src/ui/", to: "src/server" }, boundary: true, ...extra },
];

test("parseIdeas：import-edge——不需要 target，路径去掉 ./ 与结尾 /，边界默认不该出现", () => {
  const [d] = parseIdeas(edgeIdea());
  assert.deepEqual(d!.fact, { type: "import-edge", from: "src/ui", to: "src/server" });
  assert.equal(d!.target, "src/ui → src/server");
  assert.equal(d!.expect, "absent");
  assert.equal(describeIdea(d!), "src/ui 没有引用 src/server");
  assert.equal(describeIdea(parseIdeas(edgeIdea({ expect: "present", boundary: false }))[0]!), "src/ui 引用了 src/server");
});

test("parseIdeas：import-edge 的 from / to 缺失、为空或相同都要报错", () => {
  const bad = (fact: Record<string, unknown>): unknown[] => [{ id: "x", text: "x", fact: { type: "import-edge", ...fact } }];
  assert.throws(() => parseIdeas(bad({ to: "b" })), /fact\.from/);
  assert.throws(() => parseIdeas(bad({ from: "a", to: " / " })), /fact\.to/);
  assert.throws(() => parseIdeas(bad({ from: "a/", to: "./a" })), /不能相同/);
});

test("ideaStateAt 不接受 import-edge（它需要引用扫描）", () => {
  const [d] = parseIdeas(edgeIdea());
  assert.throws(() => ideaStateAt(d!, tree({})), /evalEdge/);
});

const fact: EdgeFact = { type: "import-edge", from: "src/ui", to: "src/server" };
const scan = (p: Partial<EdgeScan>): EdgeScan => ({
  allFiles: ["src/ui/a.ts", "src/server/db.ts"],
  edges: [],
  unresolved: [],
  ...p,
});

test("evalEdge：有越界的引用 → 边界为 1 并列出；想法（应该有）为 0", () => {
  const s = scan({ edges: [["src/ui/a.ts", "src/server/db.ts"], ["src/ui/a.ts", "src/ui/b.ts"]] });
  const r = evalEdge({ fact, expect: "absent" }, s);
  assert.equal(r.state, 1);
  assert.deepEqual(r.hits, [["src/ui/a.ts", "src/server/db.ts"]]);
  assert.equal(evalEdge({ fact, expect: "present" }, s).state, 0);
});

test("evalEdge：没有引用 → 边界守住 0；想法为 1", () => {
  assert.equal(evalEdge({ fact, expect: "absent" }, scan({})).state, 0);
  assert.equal(evalEdge({ fact, expect: "present" }, scan({})).state, 1);
});

test("evalEdge：目录名只按整段匹配，src/ui2 不算在 src/ui 之下", () => {
  const s = scan({ edges: [["src/ui2/a.ts", "src/server/db.ts"], ["src/ui/a.ts", "src/server2/x.ts"]] });
  assert.equal(evalEdge({ fact, expect: "absent" }, s).state, 0);
});

test("evalEdge：from / to 也可以是单个文件", () => {
  const f: EdgeFact = { type: "import-edge", from: "src/ui/a.ts", to: "src/server/db.ts" };
  assert.equal(evalEdge({ fact: f, expect: "absent" }, scan({ edges: [["src/ui/a.ts", "src/server/db.ts"]] })).state, 1);
});

test("evalEdge：from 下有解析不了、名字里带 to 的别名引用 → 测不出来，不能说守住", () => {
  for (const spec of ["@/server/db", "~/server", "src/server/db", "#server/x.ts"]) {
    const r = evalEdge({ fact, expect: "absent" }, scan({ unresolved: [["src/ui/a.ts", spec]] }));
    assert.equal(r.state, 3, spec);
    assert.match(r.unsure!, /别名引用解析不了/);
  }
});

test("evalEdge：无关的别名引用、别处的别名引用不影响结论", () => {
  assert.equal(evalEdge({ fact, expect: "absent" }, scan({ unresolved: [["src/ui/a.ts", "@/utils/format"]] })).state, 0);
  assert.equal(evalEdge({ fact, expect: "absent" }, scan({ unresolved: [["src/other/a.ts", "@/server/db"]] })).state, 0);
});

test("evalEdge：已经找到越界的引用，就算还有别名悬着，结论也是确定的", () => {
  const r = evalEdge({ fact, expect: "absent" }, scan({ edges: [["src/ui/a.ts", "src/server/db.ts"]], unresolved: [["src/ui/b.ts", "@/server/x"]] }));
  assert.equal(r.state, 1);
  assert.equal(r.unsure, null);
});

test("evalEdge：from 下全是引用图不支持的语言 → 测不出来；from 不存在则不算", () => {
  const go = scan({ allFiles: ["src/ui/main.go", "src/server/db.go"] });
  const r = evalEdge({ fact, expect: "absent" }, go);
  assert.equal(r.state, 3);
  assert.match(r.unsure!, /不支持/);
  assert.equal(evalEdge({ fact, expect: "absent" }, scan({ allFiles: ["README.md"] })).state, 0, "from 还不存在时，自然没有越界");
});

test("端到端：引用边界——越界、改成别名后测不出来、删掉后守住；HEAD 的越界清单随结果带出", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "src/ui/a.ts": "export const a = 1\n", "src/server/db.ts": "export const db = 1\n" }, "c0 守住");
    repo.commit({ "src/ui/a.ts": "import { db } from '../server/db'\nexport const a = db\n" }, "c1 越界");
    repo.commit({ "src/ui/a.ts": "import { db } from '@/server/db'\nexport const a = db\n" }, "c2 改成别名，看不出来");
    repo.commit({ "src/ui/a.ts": "export const a = 1\n" }, "c3 守住");
    repo.commit({ "src/ui/b.ts": "import { db } from '../server/db'\nexport const b = db\n", "src/ui/c.ts": "import { db } from '../server/db'\n" }, "c4 又越界，两处");
    writeClaims(repo, [{ id: "c", label: "c", file: "src/ui/a.ts", locator: "(a)", fact: { type: "text-in-file", file: "src/ui/a.ts" } }]);
    const write = (ideas: unknown[]): void => fs.writeFileSync(path.join(repo.dir, ".laminae", "ideas.json"), JSON.stringify(ideas));

    write(edgeIdea());
    runLaminae(repo, "src/ideas/ideas.ts");
    const [e] = timeline(repo);
    assert.deepEqual(e!.states, [0, 1, 3, 0, 1], "守住 → 越界 → 测不出来（不是守住）→ 守住 → 越界");
    assert.deepEqual(e!.edge, { from: "src/ui", to: "src/server" });
    assert.equal(e!.hitsTotal, 2);
    assert.deepEqual(e!.hits!.map(([a]) => a).sort(), ["src/ui/b.ts", "src/ui/c.ts"]);
    assert.equal(e!.unsure, null);
    assert.equal(e!.check, "src/ui 没有引用 src/server");
    assert.equal(e!.regressions, 2, "守住之后两次越界；测不出来不算退回");
    assert.deepEqual(e!.evidence, []);

    // 想法形式：ui 应该引用 server
    write(edgeIdea({ boundary: false, id: "wired", expect: "present" }));
    runLaminae(repo, "src/ideas/ideas.ts");
    assert.deepEqual(timeline(repo)[0]!.states, [1, 0, 3, 1, 0]);
  } finally {
    repo.dispose();
  }
});

test("端到端：引用边界在 HEAD 上判不了时，带出原因，不报守住", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "src/ui/a.ts": "import { db } from '@/server/db'\n", "src/server/db.ts": "export const db = 1\n" }, "c0");
    writeClaims(repo, [{ id: "c", label: "c", file: "src/ui/a.ts", locator: "(db)", fact: { type: "text-in-file", file: "src/ui/a.ts" } }]);
    fs.writeFileSync(path.join(repo.dir, ".laminae", "ideas.json"), JSON.stringify(edgeIdea()));
    runLaminae(repo, "src/ideas/ideas.ts");
    const [e] = timeline(repo);
    assert.equal(e!.atHead, 3);
    assert.match(e!.unsure!, /@\/server\/db/);
    assert.equal(e!.hitsTotal, 0);
  } finally {
    repo.dispose();
  }
});

test("端到端：monorepo 内部包的引用算越界（@acme/server 指向 packages/server）", () => {
  const repo = new TestRepo();
  try {
    repo.commit(
      {
        "packages/server/package.json": JSON.stringify({ name: "@acme/server", main: "index.ts" }),
        "packages/server/index.ts": "export const s = 1\n",
        "packages/ui/package.json": JSON.stringify({ name: "@acme/ui" }),
        "packages/ui/a.ts": "import { s } from '@acme/server'\nexport const a = s\n",
      },
      "c0",
    );
    writeClaims(repo, [{ id: "c", label: "c", file: "packages/ui/a.ts", locator: "(s)", fact: { type: "text-in-file", file: "packages/ui/a.ts" } }]);
    fs.writeFileSync(
      path.join(repo.dir, ".laminae", "ideas.json"),
      JSON.stringify([{ id: "b", text: "ui 不许用 server", fact: { type: "import-edge", from: "packages/ui", to: "packages/server" }, boundary: true }]),
    );
    runLaminae(repo, "src/ideas/ideas.ts");
    const [e] = timeline(repo);
    assert.equal(e!.atHead, 1);
    assert.deepEqual(e!.hits, [["packages/ui/a.ts", "packages/server/index.ts"]]);
  } finally {
    repo.dispose();
  }
});