import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MAX_NODES, buildGraph, chooseDepth } from "../src/graph-core.ts";
import { aliveAt, groupOf } from "../src/graph-util.ts";
import { layoutGraph, shortLabels } from "../web/layout.ts";
import { TestRepo, runLaminae } from "./helpers.ts";
import type { GraphData } from "../src/types.ts";

test("buildGraph：节点与边折成存在的区间", () => {
  const g = buildGraph([
    { files: ["a.js", "b.js"], edges: [["a.js", "b.js"]] }, // 0
    { files: ["a.js", "b.js"], edges: [] }, // 1 引用被删
    { files: ["a.js", "b.js", "c.js"], edges: [["a.js", "b.js"]] }, // 2 引用回来，多了 c
    { files: ["a.js", "c.js"], edges: [] }, // 3 b 被删
  ]);
  assert.equal(g.level, "file");
  const node = (id: string) => g.nodes.find((n) => n.id === id)!;
  assert.deepEqual(node("a.js").alive, [[0, 3]]);
  assert.deepEqual(node("b.js").alive, [[0, 2]]);
  assert.deepEqual(node("c.js").alive, [[2, 3]]);
  assert.equal(g.edges.length, 1);
  assert.deepEqual(g.edges[0]!.alive, [[0, 0], [2, 2]], "同一条引用消失又回来是两段");
  assert.equal(g.nodes[g.edges[0]!.s]!.id, "a.js");
  assert.equal(g.nodes[g.edges[0]!.t]!.id, "b.js");
});

test("buildGraph：测试文件标出来，目录合并后只有全是测试才算", () => {
  const g = buildGraph([{ files: ["src/a.js", "tests/a.test.js"], edges: [["tests/a.test.js", "src/a.js"]] }]);
  assert.equal(g.nodes.find((n) => n.id === "src/a.js")!.test, false);
  assert.equal(g.nodes.find((n) => n.id === "tests/a.test.js")!.test, true);
});

test("文件太多时按目录合并：同一目录内的引用不画，节点数不超过上限", () => {
  const files: string[] = [];
  for (let d = 0; d < 30; d++) for (let f = 0; f < 20; f++) files.push(`pkg/m${d}/f${f}.js`);
  assert.ok(files.length > MAX_NODES);
  const depth = chooseDepth(new Set(files));
  assert.equal(depth, 2, "pkg/mN 这一级有 30 个目录，够细也不超限");

  const g = buildGraph([
    {
      files,
      edges: [
        ["pkg/m0/f0.js", "pkg/m0/f1.js"], // 同一目录，合并后是自环，丢掉
        ["pkg/m0/f0.js", "pkg/m1/f0.js"],
        ["pkg/m0/f5.js", "pkg/m1/f9.js"], // 合并后和上一条是同一条边
      ],
    },
  ]);
  assert.equal(g.level, "dir");
  assert.equal(g.depth, 2);
  assert.equal(g.nodes.length, 30);
  assert.equal(g.edges.length, 1);
  assert.equal(g.fileCount, 600);
});

test("文件不多时不合并", () => {
  assert.equal(chooseDepth(new Set(["a.js", "b/c.js"])), null);
});

test("groupOf 与 aliveAt", () => {
  assert.equal(groupOf("a.js", 2), ".");
  assert.equal(groupOf("src/lib/deep/a.js", 2), "src/lib");
  assert.equal(groupOf("src/a.js", 5), "src");
  const alive = [[2, 4], [8, 9]] as const;
  assert.deepEqual([0, 2, 4, 5, 8, 9, 10].map((c) => aliveAt(alive, c)), [false, true, true, false, true, true, false]);
});

test("layoutGraph：引用别人的在左，被引用的在右", () => {
  const ids = ["main", "lib", "util"];
  const lay = layoutGraph(ids, [{ s: 0, t: 1 }, { s: 1, t: 2 }, { s: 0, t: 2 }]);
  assert.deepEqual(lay.layer, [0, 1, 2]);
  assert.equal(lay.layers, 3);
});

test("layoutGraph：有环不会卡住，孤立节点排在每层最后", () => {
  const ids = ["a", "b", "c", "lonely"];
  const lay = layoutGraph(ids, [{ s: 0, t: 1 }, { s: 1, t: 2 }, { s: 2, t: 0 }]);
  assert.equal(lay.layer.length, 4);
  assert.ok(lay.layers >= 1 && lay.layers <= 3);
  const sameLayer = ids.map((_, i) => i).filter((i) => lay.layer[i] === lay.layer[3]);
  assert.equal(Math.max(...sameLayer.map((i) => lay.row[i]!)), lay.row[3], "孤立的 lonely 在它那一层的最后一行");
});

test("layoutGraph：空图与越界的边", () => {
  assert.deepEqual(layoutGraph([], []).layer, []);
  assert.doesNotThrow(() => layoutGraph(["a"], [{ s: 0, t: 5 }, { s: 0, t: 0 }]));
});

test("shortLabels：重名时补上目录，直到互不相同", () => {
  assert.deepEqual(shortLabels(["src/index.js", "lib/index.js", "a.js"]), ["src/index.js", "lib/index.js", "a.js"]);
  assert.deepEqual(shortLabels(["a/b/x.js", "a/c/x.js"]), ["b/x.js", "c/x.js"]);
  assert.deepEqual(shortLabels(["x.js", "y/x.js"]), ["x.js", "y/x.js"]);
});

test("端到端：逐 commit 抽取引用，增删引用与文件都反映在区间里", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "src/a.js": "import { b } from './b.js'\n", "src/b.js": "export const b = 1\n" }, "c0 a 引用 b");
    repo.commit({ "src/a.js": "// 不再引用\n" }, "c1 去掉引用");
    repo.commit({ "src/a.js": "const c = require('./lib')\n", "src/lib/index.js": "module.exports = 1\n" }, "c2 改引用 lib 目录");
    repo.commit({ "README.md": "只改文档\n" }, "c3 没动代码");
    repo.commit({ "src/b.js": null }, "c4 删 b");
    runLaminae(repo, "src/graph.ts");

    const g = JSON.parse(fs.readFileSync(path.join(repo.dir, ".laminae", "data", "graph.json"), "utf8")) as GraphData;
    const id = (i: number): string => g.nodes[i]!.id;
    const edge = (s: string, t: string) => g.edges.find((e) => id(e.s) === s && id(e.t) === t);

    assert.deepEqual(edge("src/a.js", "src/b.js")!.alive, [[0, 0]]);
    assert.deepEqual(edge("src/a.js", "src/lib/index.js")!.alive, [[2, 4]], "引用目录解析到 index.js，README 提交沿用上一个结果");
    assert.deepEqual(g.nodes.find((n) => n.id === "src/b.js")!.alive, [[0, 3]]);
    assert.equal(g.level, "file");
  } finally {
    repo.dispose();
  }
});

test("端到端：Python 的相对引用", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "pkg/__init__.py": "", "pkg/a.py": "from . import b\nfrom .c import f\n", "pkg/b.py": "", "pkg/c.py": "" }, "py");
    runLaminae(repo, "src/graph.ts");
    const g = JSON.parse(fs.readFileSync(path.join(repo.dir, ".laminae", "data", "graph.json"), "utf8")) as GraphData;
    const has = (s: string, t: string): boolean => g.edges.some((e) => g.nodes[e.s]!.id === s && g.nodes[e.t]!.id === t);
    assert.ok(has("pkg/a.py", "pkg/b.py"));
    assert.ok(has("pkg/a.py", "pkg/c.py"));
  } finally {
    repo.dispose();
  }
});

test("端到端：没有可解析的代码时，图是空的而不是报错", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "main.go": "package main\n", "README.md": "x\n" });
    const out = runLaminae(repo, "src/graph.ts");
    const g = JSON.parse(fs.readFileSync(path.join(repo.dir, ".laminae", "data", "graph.json"), "utf8")) as GraphData;
    assert.equal(g.nodes.length, 0);
    assert.match(out, /没有找到可解析/);
  } finally {
    repo.dispose();
  }
});
