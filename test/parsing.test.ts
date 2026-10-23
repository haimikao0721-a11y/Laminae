import { test } from "node:test";
import assert from "node:assert/strict";
import { jsModule } from "../src/layers/syntax-js.ts";
import { buildLayers, classifyDepth, hollowFunctions, joinLayers } from "../src/layers/layers-core.ts";
import type { CommitLayer, LayerCommit } from "../src/layers/layers-core.ts";

// 这一批都是真实仓库上抓到的误报，各钉一条。

const layer = (l: Partial<CommitLayer>): CommitLayer => ({
  stubs: [],
  facts: [],
  declares: [],
  references: [],
  clues: [],
  hollowFns: [],
  delegates: [],
  ...l,
});

const commit = (files: string[], l: Partial<CommitLayer> = {}): LayerCommit => ({ files, edges: [], layer: layer(l) });

// 第一类：注释和字符串里的代码样例被当成真代码。
// vue 上 package.json 里没有，但它报出过 `xxx`、`NODE`、`foo` 三个「空函数」，
// 全部来自两行注释：
//   // Note: functions inside this closure should use `const xxx = () => {}`
//   // no: function NODE() {}
test("函数识别：注释里的代码样例不是函数", () => {
  const text = [
    "// 用法：const xxx = () => {}",
    "// no: function NODE() {}",
    "function real() {}",
  ].join("\n");
  assert.deepEqual(jsModule.findFunctions(text).map((f) => f.name), ["real"]);
});

test("函数识别：字符串里的代码样例不是函数", () => {
  const text = ['const doc = "function fake() {}"', "function real() {}"].join("\n");
  assert.deepEqual(jsModule.findFunctions(text).map((f) => f.name), ["real"]);
});

// 第二类：类型声明文件。`declare function foo(...)` 本来就没有函数体，
// `.d.ts` 里也不可能写到实现。vue 的 dts-test 目录里一整批就是这么被报出来的。
test("往下看一层：类型声明文件不算空实现", () => {
  const data = buildLayers([
    commit(["src/real.ts", "types/a.d.ts", "dts-test/b.test-d.ts"], {
      hollowFns: [
        { file: "src/real.ts", name: "unfinished", line: 1, reason: "unimplemented" },
        { file: "types/a.d.ts", name: "func", line: 1, reason: "empty" },
        { file: "dts-test/b.test-d.ts", name: "expectString", line: 1, reason: "empty" },
      ],
    }),
  ]);
  const report = joinLayers(data, []);
  assert.deepEqual(
    report.down.map((d) => d.name),
    ["unfinished"],
    "类型声明没有函数体是它本来的样子，不是没实现",
  );
});


// 第三类：箭头函数。vue 上「往下看一层」当前成立的三条全是这个形状，
// 一条都不是缺陷：
//   export const NO = () => false                      文档写着 "Always return false."
//   export const shouldTransformRef = () => false      功能开关，暂时关掉
//   const watchStopHandle = () => {}                   空句柄，后面挂 .stop / .resume
//
// 但文件级判定仍要用这个信号：一个文件里只有一句常量箭头，classifyDepth 会判
// placeholder —— 那是「这个文件没写什么」，和「这个函数要不要人看」不是一回事。
test("箭头函数不进需要复核的清单，但文件级判定照样认得它", () => {
  const text = ["export const NO = () => false", "const watchStopHandle = () => {}", "export function real() { return work() }"].join("\n");
  const hollow = hollowFunctions(text);
  assert.equal(hollow.every((h) => h.arrow), true, "这三个空判定都该带箭头标记");
  assert.equal(classifyDepth("export const empty = () => []\n"), "placeholder", "文件级仍然要判成占位");

  const data = buildLayers([
    { files: ["src/a.ts"], edges: [], layer: layer({ hollowFns: hollow.map((h) => ({ ...h, file: "src/a.ts" })) }) },
  ]);
  const report = joinLayers(data, []);
  assert.deepEqual(report.down, [], "箭头函数不该出现在清单里");
});
