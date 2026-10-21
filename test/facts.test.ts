import { test } from "node:test";
import assert from "node:assert/strict";
import { describeFact, evalFact, globToRegExp, isObserved, isReferential, parseFact } from "../src/facts.ts";
import type { Tree } from "../src/facts.ts";

/** 用内存里的文件表充当某个 commit 的文件树 */
function tree(files: Record<string, string>): Tree {
  return {
    paths: () => Object.keys(files),
    read: (f) => files[f] ?? null,
  };
}

test("glob：* 不跨目录，** 跨目录", () => {
  assert.ok(globToRegExp("assets/*.png").test("assets/a.png"));
  assert.ok(!globToRegExp("assets/*.png").test("assets/sub/a.png"));
  assert.ok(globToRegExp("assets/**/*.png").test("assets/sub/deep/a.png"));
  assert.ok(globToRegExp("assets/**/*.png").test("assets/a.png"), "**/ 可以匹配零层目录");
  assert.ok(globToRegExp("**/*.md").test("README.md"));
  assert.ok(globToRegExp("src/?.ts").test("src/a.ts"));
  assert.ok(!globToRegExp("src/?.ts").test("src/ab.ts"));
});

test("glob：文件名里的点和括号按字面匹配", () => {
  assert.ok(globToRegExp("a.b").test("a.b"));
  assert.ok(!globToRegExp("a.b").test("axb"));
  assert.ok(globToRegExp("x(1).txt").test("x(1).txt"));
});

test("count-files：按 glob 计数，没有匹配就是 0", () => {
  const t = tree({ "a/1.png": "", "a/2.png": "", "a/3.ico": "", "b.png": "" });
  assert.equal(evalFact({ type: "count-files", glob: "a/*.png" }, t), 2);
  assert.equal(evalFact({ type: "count-files", glob: "none/*" }, t), 0);
});

test("json-length：数组长度、对象键数、点路径", () => {
  const t = tree({ "d.json": JSON.stringify({ list: [1, 2, 3], nest: { items: [[], []] }, obj: { a: 1, b: 2 } }) });
  assert.equal(evalFact({ type: "json-length", file: "d.json", path: "list" }, t), 3);
  assert.equal(evalFact({ type: "json-length", file: "d.json", path: "nest.items" }, t), 2);
  assert.equal(evalFact({ type: "json-length", file: "d.json", path: "obj" }, t), 2);
});

test("json-length：根节点是数组时 path 可省略", () => {
  assert.equal(evalFact({ type: "json-length", file: "d.json" }, tree({ "d.json": "[1,2]" })), 2);
});

test("json-length：文件缺失、JSON 损坏、路径不存在、类型不对，都是 null（测不出来）", () => {
  assert.equal(evalFact({ type: "json-length", file: "d.json", path: "x" }, tree({})), null);
  assert.equal(evalFact({ type: "json-length", file: "d.json", path: "x" }, tree({ "d.json": "{ 坏的" })), null);
  assert.equal(evalFact({ type: "json-length", file: "d.json", path: "x" }, tree({ "d.json": "{}" })), null);
  assert.equal(evalFact({ type: "json-length", file: "d.json", path: "x" }, tree({ "d.json": '{"x": 5}' })), null);
});

test("json-number：读数值字段，非数字为 null", () => {
  const t = tree({ "p.json": JSON.stringify({ version: 3, name: "x", deep: { n: 7 } }) });
  assert.equal(evalFact({ type: "json-number", file: "p.json", path: "version" }, t), 3);
  assert.equal(evalFact({ type: "json-number", file: "p.json", path: "deep.n" }, t), 7);
  assert.equal(evalFact({ type: "json-number", file: "p.json", path: "name" }, t), null);
});

test("regex-count：统计匹配次数，文件缺失为 null", () => {
  const t = tree({ "t.js": "it('a')\nit('b')\n// it('c')\n" });
  assert.equal(evalFact({ type: "regex-count", file: "t.js", pattern: "^it\\(", flags: "m" }, t), 2);
  assert.equal(evalFact({ type: "regex-count", file: "t.js", pattern: "it\\(" }, t), 3);
  assert.equal(evalFact({ type: "regex-count", file: "none.js", pattern: "x" }, t), null);
});

test("line-count 与 file-bytes", () => {
  const t = tree({ "a.txt": "1\n2\n3\n", "empty.txt": "", "zh.txt": "中" });
  assert.equal(evalFact({ type: "line-count", file: "a.txt" }, t), 3);
  assert.equal(evalFact({ type: "line-count", file: "empty.txt" }, t), 0);
  assert.equal(evalFact({ type: "line-count", file: "none.txt" }, t), null);
  assert.equal(evalFact({ type: "file-bytes", file: "zh.txt" }, t), 3);
});

test("path-exists：文件、目录前缀、base、./ 与结尾的 / 都能识别", () => {
  const t = tree({ "docs/guide.md": "", "src/a/b.ts": "" });
  const f = { type: "path-exists" } as const;
  assert.equal(evalFact(f, t, "docs/guide.md"), 1);
  assert.equal(evalFact(f, t, "./docs/guide.md"), 1);
  assert.equal(evalFact(f, t, "src/a"), 1, "目录靠路径前缀判断");
  assert.equal(evalFact(f, t, "src/a/"), 1);
  assert.equal(evalFact(f, t, "src/ab"), 0, "前缀必须在目录边界上，src/ab 不是 src/a 的子路径");
  assert.equal(evalFact(f, t, "docs/missing.md"), 0);
  assert.equal(evalFact({ type: "path-exists", base: "src" }, t, "a/b.ts"), 1);
  assert.equal(evalFact({ type: "path-exists", base: "src/" }, t, "a/b.ts"), 1);
});

test("引用型：没有捕获到文本时返回 null，而不是 0", () => {
  const t = tree({ "a.md": "x" });
  assert.equal(evalFact({ type: "path-exists" }, t, null), null);
  assert.equal(evalFact({ type: "path-exists" }, t, "  "), null);
  assert.equal(evalFact({ type: "text-in-file", file: "a.md" }, t, null), null);
});

test("text-in-file：出现过为 1，没出现为 0，文件缺失为 null", () => {
  const t = tree({ "Makefile": "build:\n\tgo build\n" });
  assert.equal(evalFact({ type: "text-in-file", file: "Makefile" }, t, "build:"), 1);
  assert.equal(evalFact({ type: "text-in-file", file: "Makefile" }, t, "deploy:"), 0);
  assert.equal(evalFact({ type: "text-in-file", file: "none" }, t, "build:"), null);
});

test("json-has-key：package.json 的 scripts 里有没有这个命令", () => {
  const t = tree({ "package.json": JSON.stringify({ scripts: { build: "x", test: "y" } }), "bad.json": "{ 坏的" });
  const f = { type: "json-has-key", file: "package.json", path: "scripts" } as const;
  assert.equal(evalFact(f, t, "build"), 1);
  assert.equal(evalFact(f, t, "deploy"), 0);
  assert.equal(evalFact({ ...f, file: "bad.json" }, t, "build"), null, "JSON 损坏是测不出来");
  assert.equal(evalFact({ ...f, path: "nope" }, t, "build"), null, "路径不存在是测不出来");
});

test("isReferential 只认引用型", () => {
  assert.ok(isReferential({ type: "path-exists" }));
  assert.ok(isReferential({ type: "text-in-file", file: "a" }));
  assert.ok(isReferential({ type: "json-has-key", file: "a" }));
  assert.ok(!isReferential({ type: "count-files", glob: "a" }));
  assert.ok(!isReferential({ type: "line-count", file: "a" }));
  assert.ok(!isReferential({ type: "test-passes", command: "pytest" }));
});

test("parseFact：引用型的参数校验", () => {
  assert.deepEqual(parseFact({ type: "path-exists" }, "x"), { type: "path-exists" });
  assert.deepEqual(parseFact({ type: "path-exists", base: "src" }, "x"), { type: "path-exists", base: "src" });
  assert.throws(() => parseFact({ type: "path-exists", base: "" }, "x"), /fact\.base/);
  assert.throws(() => parseFact({ type: "text-in-file" }, "x"), /fact\.file/);
  assert.deepEqual(parseFact({ type: "json-has-key", file: "package.json", path: "scripts" }, "x"), {
    type: "json-has-key",
    file: "package.json",
    path: "scripts",
  });
});

test("parseFact：合法的声明原样通过", () => {
  assert.deepEqual(parseFact({ type: "count-files", glob: "a/*" }, "x"), { type: "count-files", glob: "a/*" });
  assert.deepEqual(parseFact({ type: "json-length", file: "d.json", path: "a" }, "x"), {
    type: "json-length",
    file: "d.json",
    path: "a",
  });
});

test("parseFact：错误信息指出哪里写错了", () => {
  assert.throws(() => parseFact("count-files", "claims[0]"), /fact 必须是对象/);
  assert.throws(() => parseFact({ type: "nope" }, "claims[0]"), /fact\.type 必须是/);
  assert.throws(() => parseFact({ type: "count-files" }, "claims[0]"), /fact\.glob/);
  assert.throws(() => parseFact({ type: "regex-count", file: "a", pattern: "(" }, "claims[0]"), /不是合法正则/);
});

test("parseFact：跑出来的事实要有命令，watch 和 timeout 可选", () => {
  assert.deepEqual(parseFact({ type: "test-passes", command: "pytest -q" }, "x"), { type: "test-passes", command: "pytest -q" });
  assert.deepEqual(parseFact({ type: "invariant-holds", command: "python check.py", watch: ["fee.py"], source: "tests/test_fee.py" }, "x"), {
    type: "invariant-holds",
    command: "python check.py",
    watch: ["fee.py"],
    source: "tests/test_fee.py",
  });
  assert.equal(isObserved({ type: "output-unchanged", command: "node print.js" }), true);
  assert.throws(() => parseFact({ type: "test-passes" }, "x"), /fact\.command/);
  assert.throws(() => parseFact({ type: "test-passes", command: "pytest", watch: [] }, "x"), /fact\.watch/);
  assert.throws(() => parseFact({ type: "output-unchanged", command: "node print.js", source: "a.py" }, "x"), /不用 fact\.source/);
  assert.equal(evalFact({ type: "test-passes", command: "pytest" }, tree({})), null);
});

test("describeFact：每种类型都有一句话描述", () => {
  assert.match(describeFact({ type: "count-files", glob: "a/*.png" }), /a\/\*\.png/);
  assert.match(describeFact({ type: "json-length", file: "d.json", path: "levels" }), /d\.json.*levels/);
});
