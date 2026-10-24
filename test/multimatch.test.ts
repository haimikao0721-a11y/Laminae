import { test } from "node:test";
import assert from "node:assert/strict";
import { lintClaims } from "../src/measure/lint.ts";
import type { ClaimDef } from "../src/core/types.ts";

// locator 在同一份文档里匹配到多处时，判定只取第一处（`new RegExp(...).exec(doc)`）。
// 绑到哪句全看谁在前面 —— 以前这件事完全静默：文档里加一句相似的话，结论就换了，
// 而且看不出来。
//
// 这里钉三件事：能报出来、给出行号、只匹配一处时不报。

const claim = (locator: string): ClaimDef => ({
  id: "levels",
  label: "关卡数",
  file: "README.md",
  locator,
  impact: "normal",
  compare: "eq",
  tolerance: 0,
  fact: { type: "json-length", file: "s.json", path: "levels" },
});

const DOC = ["# demo", "", "本作共 12 关。", "", "补充说明：本作共 12 关。", ""].join("\n");

function lint(locator: string): { code: string; message: string }[] {
  return lintClaims([{}], [claim(locator)], (f) => (f === "README.md" ? DOC : null));
}

test("匹配多处：报出来，并给出行号", () => {
  const w = lint("本作共 (\\d+) 关");
  const hit = w.find((x) => x.code === "locator-multi-match");
  assert.ok(hit, "匹配到两处必须报");
  assert.match(hit.message, /匹配到 2 处/);
  assert.match(hit.message, /第 3、5 行/, "要指出具体行号，人才知道去哪儿收紧");
});

test("匹配多处：说清后果是「可能绑错」，不是「结论错」", () => {
  const w = lint("本作共 (\\d+) 关");
  const hit = w.find((x) => x.code === "locator-multi-match")!;
  assert.match(hit.message, /只取第一处/);
  assert.match(hit.message, /不会让结论「错」/);
  assert.match(hit.message, /多带几个字/);
});

test("只匹配一处时不报 —— 这条警告不能天天响", () => {
  const w = lint("补充说明：本作共 (\\d+) 关");
  assert.equal(w.some((x) => x.code === "locator-multi-match"), false);
});

test("一处都匹配不到时走的是另一条警告，不是这条", () => {
  const w = lint("根本不存在 (\\d+) 关");
  assert.equal(w.some((x) => x.code === "locator-multi-match"), false);
  assert.ok(w.some((x) => x.code === "locator-miss"));
});
