import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, judgeState, parseClaimedNumber, segment } from "../src/classify.ts";
import { ABSENT, FALSE, TRUE, UNMEASURED } from "../src/types.ts";
import type { State } from "../src/types.ts";

/** 按给定的「文档写的 / 实际的」序列算出状态，再取第一个假段的结局 */
function outcomeOf(claimed: (number | null)[], actual: (number | null)[]): string {
  const states: State[] = claimed.map((c, i) => judgeState(c, actual[i] ?? null));
  const run = segment(states).find((r) => r.state === FALSE);
  assert.ok(run, "测试数据里应该有一个假段");
  return classify(run, { states, claimed, actual });
}

test("judgeState：说法不在文档里是「还不存在」", () => {
  assert.equal(judgeState(null, 5), ABSENT);
  assert.equal(judgeState(null, null), ABSENT);
});

test("judgeState：说法在、事实读不到是「测不出来」，不是「还不存在」", () => {
  assert.equal(judgeState(5, null), UNMEASURED);
});

test("judgeState：相等为真，不等为假", () => {
  assert.equal(judgeState(5, 5), TRUE);
  assert.equal(judgeState(5, 6), FALSE);
});

test("parseClaimedNumber：支持千分位，读不成数返回 null", () => {
  assert.equal(parseClaimedNumber("17"), 17);
  assert.equal(parseClaimedNumber("1,200"), 1200);
  assert.equal(parseClaimedNumber("1_000"), 1000);
  assert.equal(parseClaimedNumber("3.5"), 3.5);
  assert.equal(parseClaimedNumber("abc"), null);
  assert.equal(parseClaimedNumber(""), null);
});

test("segment：连续同状态合成一段", () => {
  const runs = segment([ABSENT, TRUE, TRUE, FALSE, FALSE, FALSE, TRUE]);
  assert.deepEqual(
    runs.map((r) => [r.state, r.from, r.to, r.len]),
    [
      [ABSENT, 0, 0, 1],
      [TRUE, 1, 2, 2],
      [FALSE, 3, 5, 3],
      [TRUE, 6, 6, 1],
    ],
  );
});

test("classify：写下即假、到 HEAD 仍未结束，现实没动", () => {
  // 文档写 5，实际一直是 4
  assert.equal(outcomeOf([5, 5, 5, 5], [4, 4, 4, 4]), "hanging-reality-still");
});

test("classify：现实在假段第一格上变了、文档没跟上，是现实动过（回归：此前误判为没动）", () => {
  // 文档写 5，现实 5 → 8，之后一直是 8
  assert.equal(outcomeOf([5, 5, 5, 5], [5, 8, 8, 8]), "hanging-reality-moved");
});

test("classify：假段到 HEAD 仍未结束，现实动过", () => {
  assert.equal(outcomeOf([5, 5, 5, 5], [5, 6, 7, 7]), "hanging-reality-moved");
});

test("classify：假段之后说法被删掉是 doc-removed（回归：此前永远走不到）", () => {
  // 第 2 格起为假，第 4 格说法从文档里消失
  assert.equal(outcomeOf([5, 5, 5, null], [5, 4, 4, 4]), "doc-removed");
});

test("classify：假段之后事实测不出来是 unmeasurable", () => {
  assert.equal(outcomeOf([5, 5, 5, 5], [5, 4, 4, null]), "unmeasurable");
});

test("classify：现实改回说法写的数是 reality-caught-up", () => {
  assert.equal(outcomeOf([5, 5, 5, 5], [5, 4, 4, 5]), "reality-caught-up");
});

test("classify：现实先涨、文档后补是 doc-caught-up", () => {
  // 实际 5→6→7，文档一直写 5，最后文档改成 7
  assert.equal(outcomeOf([5, 5, 5, 7], [5, 6, 7, 7]), "doc-caught-up");
});

test("classify：现实在假段第一格上变了、文档后来补上，是 doc-caught-up（回归：此前误判为 doc-corrected）", () => {
  assert.equal(outcomeOf([5, 5, 5, 8], [5, 8, 8, 8]), "doc-caught-up");
});

test("classify：写下即假、现实没动、文档后来改对，是 doc-corrected", () => {
  assert.equal(outcomeOf([5, 5, 5, 4], [4, 4, 4, 4]), "doc-corrected");
});

test("classify：文档被改错、之后又改回，现实没动，是 doc-corrected", () => {
  assert.equal(outcomeOf([4, 5, 5, 4], [4, 4, 4, 4]), "doc-corrected");
});

test("classify：说法与事实在同一个 commit 上一起变是 both-changed（回归：此前永远走不到）", () => {
  // 假段期间现实不动；结束那一格文档改成 9，事实也变成 9
  assert.equal(outcomeOf([5, 5, 5, 9], [5, 4, 4, 9]), "both-changed");
});
