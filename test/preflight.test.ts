import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPreflight, previewCommands } from "../src/measure/preflight.ts";
import type { ClaimDef } from "../src/core/types.ts";

// 命令类事实会**执行命令**，命令来自 .laminae/claims.json，
// 而那个文件是可以被提交进仓库的（exclude.ts 里明写了这条）。
// 也就是说：克隆一个仓库、跑一次 laminae，就可能执行别人写好的命令。
//
// 所以跑之前要把三件事摊开：命令原文、它从哪来、要跑多少次。
// 这不是沙箱 —— 沙箱让人以为「关起来了」，这里要做的是让人**看见**。

const CLAIM: ClaimDef = {
  id: "tests",
  label: "测试全过",
  file: "README.md",
  locator: "(测试全过)",
  impact: "normal",
  compare: "eq",
  tolerance: 0,
  fact: { type: "test-passes", command: "npm test && npm run lint", watch: ["src/**"], timeout: 120 },
};

const SOURCE_LOCAL = { file: ".laminae/claims.json", tracked: false, lastAuthor: null, lastDate: null };
const SOURCE_TRACKED = { file: ".laminae/claims.json", tracked: true, lastAuthor: "someone <s@example.com>", lastDate: "2026-10-01" };

test("命令原文完整打印，不截断", () => {
  const long = { ...CLAIM, fact: { ...CLAIM.fact, command: `npm test ${"x".repeat(200)} --tail-marker` } } as ClaimDef;
  const text = formatPreflight(previewCommands([long], 1), SOURCE_LOCAL, null);
  assert.match(text, /--tail-marker/, "尾巴不能被截掉 —— 截断正好能藏住东西");
  assert.match(text, /x{200}/);
});

test("说清楚要跑多少次：没配 watch 就是每个 commit 一次", () => {
  const noWatch = { ...CLAIM, fact: { ...CLAIM.fact, watch: undefined } } as ClaimDef;
  const text = formatPreflight(previewCommands([noWatch], 6513), SOURCE_LOCAL, null);
  assert.match(text, /6513 个 commit/, "一万个 commit 上各跑一次测试，这件事必须先看见");
  assert.match(text, /每个都要跑一次/);
});

test("配了 watch 时说清只会跑变动的那些", () => {
  const text = formatPreflight(previewCommands([CLAIM], 6513), SOURCE_LOCAL, null);
  assert.match(text, /watch src\/\*\*/);
  assert.match(text, /只有这些文件变了的 commit 才跑/);
});

test("出处被 git 跟踪时要标明：这是随仓库来的", () => {
  const text = formatPreflight(previewCommands([CLAIM], 1), SOURCE_TRACKED, null);
  assert.match(text, /被 git 跟踪/);
  assert.match(text, /随仓库来的/);
  assert.match(text, /someone <s@example\.com>/);
});

test("出处是本地的文件时，不吓唬人", () => {
  const text = formatPreflight(previewCommands([CLAIM], 1), SOURCE_LOCAL, null);
  assert.match(text, /没有被 git 跟踪/);
  assert.doesNotMatch(text, /随仓库来的/);
});

test("--no-commands 时说清楚：记成测不出来，不是假", () => {
  const text = formatPreflight(previewCommands([CLAIM], 1), SOURCE_TRACKED, "flag");
  assert.match(text, /--no-commands 跳过/);
  assert.match(text, /记成「测不出来」/);
  assert.match(text, /不是不成立/);
});

test("只有数仓库的事实时不打这一段（没什么要看的）", () => {
  const plain = { ...CLAIM, fact: { type: "path-exists" } } as ClaimDef;
  assert.deepEqual(previewCommands([plain], 10), []);
  assert.equal(formatPreflight([], SOURCE_LOCAL, null), "");
});
