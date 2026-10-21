/**
 * 打印 / 存 PDF 的样式约束。这些规则一旦丢了，PDF 里格子会是一片空白、右侧被截掉，
 * 而在屏幕上完全看不出来，所以用样式文本直接钉住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SKILL_ROOT } from "./helpers.ts";

const css = fs.readFileSync(path.join(SKILL_ROOT, "web", "style.css"), "utf8");
const printBlock = css.slice(css.indexOf("@media print"));

test("打印：要求按屏幕颜色输出，否则浏览器默认不画背景，格子会变成空白", () => {
  assert.match(printBlock, /print-color-adjust:\s*exact/);
});

test("打印：图例要保留，读图要靠它", () => {
  assert.doesNotMatch(printBlock, /\.legend[^{}]*\{[^}]*display:\s*none/);
});

test("打印：格子按页宽均分，不用屏幕上的固定宽度，commit 多时右边不会被截掉", () => {
  assert.match(printBlock, /\.map\s*\{[^}]*minmax\(0,\s*1fr\)/);
  assert.match(printBlock, /\.cell\s*\{\s*width:\s*auto/);
});
