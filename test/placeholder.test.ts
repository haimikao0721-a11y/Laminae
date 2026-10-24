import { test } from "node:test";
import assert from "node:assert/strict";
import { placeholderFact } from "../src/measure/lint.ts";
import type { ClaimDef } from "../src/core/types.ts";

// 两条警告，守的是同一条规矩：**别让工具「看起来查过了」。**
//
// 一、占位事实：init 生成的草稿里 fact 是默认值（数所有文件、只问 package.json
//     有没有 scripts 键）。它照样跑得出结果，报告里显示成真或假 ——
//     看着像结论，其实是没调好的机器。这比「测不出来」更该说：
//     测不出来至少没人会当真。
//
// 二、locator 匹配多处：判定只取第一处，绑到哪句全看谁在前面，而以前完全静默。
//     文档里加一句相似的话，结论就换了，而且看不出来。

const base = (fact: ClaimDef["fact"]): ClaimDef => ({
  id: "x",
  label: "x",
  file: "README.md",
  locator: "(\\d+) 关",
  impact: "normal",
  compare: "eq",
  tolerance: 0,
  fact,
});

test("占位事实：数所有文件会被认出来", () => {
  for (const glob of ["**/*", "**", "*", ""]) {
    const why = placeholderFact(base({ type: "count-files", glob }).fact);
    assert.notEqual(why, null, `glob=${JSON.stringify(glob)} 应当被认成占位`);
    assert.match(why!, /所有文件/);
  }
});

test("占位事实：只问 package.json 有没有 scripts 也算", () => {
  const why = placeholderFact(base({ type: "json-has-key", file: "package.json", path: "scripts" }).fact);
  assert.notEqual(why, null);
  assert.match(why!, /任何 npm 项目都有/);
});

test("占位事实：正常的事实不会被冤枉", () => {
  // 误报一次，人以后就不看这条警告了 —— 所以只认两种形状，不去猜别的
  assert.equal(placeholderFact(base({ type: "count-files", glob: "src/**/*.ts" }).fact), null);
  assert.equal(placeholderFact(base({ type: "json-length", file: "a.json", path: "levels" }).fact), null);
  assert.equal(placeholderFact(base({ type: "json-has-key", file: "package.json", path: "bin" }).fact), null);
  assert.equal(placeholderFact(base({ type: "path-exists" }).fact), null);
  assert.equal(placeholderFact(base({ type: "test-passes", command: "npm test" }).fact), null);
});
