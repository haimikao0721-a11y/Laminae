/**
 * laminae —— 分段与结局判定
 *
 * 纯函数，不读文件、不打印，analyze.ts 与测试共用。
 */
import { satisfies } from "../measure/compare.ts";
import type { Compare } from "../measure/compare.ts";
import { ABSENT, FALSE, TRUE, UNMEASURED } from "../core/types.ts";
import type { Outcome, State } from "../core/types.ts";

/** 一条说法逐 commit 的判定结果 */
export interface Judged {
  states: State[];
  claimed: (number | null)[];
  actual: (number | null)[];
  /** 每个 commit 上，文档里那一行的原文 */
  lines: (string | null)[];
}

/** 一段连续同状态的 commit 区间 */
export interface Run {
  state: State;
  from: number;
  to: number;
  len: number;
  outcome: Outcome | null;
}

/**
 * 判定某个 commit 上一条说法的状态。
 *
 *   文档里找不到这条说法      → 还不存在
 *   说法在，但事实读不到      → 测不出来（不能记成「还不存在」）
 *   满足比较方式              → 真（默认 eq：两者相等；「1600+」用 gte，见 compare.ts）
 *   不满足                    → 假
 */
export function judgeState(claimed: number | null, actual: number | null, compare: Compare = "eq", tolerance?: number): State {
  if (claimed === null) return ABSENT;
  if (actual === null) return UNMEASURED;
  return satisfies(claimed, actual, compare, tolerance) ? TRUE : FALSE;
}

/**
 * 把文档里捕获到的文本读成数。允许千分位逗号、下划线和空白（"1,200" → 1200）。
 * 读不成有限数字返回 null。
 */
export function parseClaimedNumber(text: string): number | null {
  const cleaned = text.replace(/[,_\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** 把状态序列切成连续同状态的区间 */
export function segment(states: State[]): Run[] {
  const runs: Run[] = [];
  let i = 0;
  while (i < states.length) {
    let j = i;
    while (j + 1 < states.length && states[j + 1] === states[i]) j++;
    runs.push({ state: states[i]!, from: i, to: j, len: j - i + 1, outcome: null });
    i = j + 1;
  }
  return runs;
}

/**
 * 假段是否右删失：到 HEAD 仍未结束，或之后事实测不出来、不知道什么时候结束。
 * 说法被删掉是一次真实的结束，不算删失。
 */
export function isCensored(run: Pick<Run, "to">, states: State[]): boolean {
  const after = run.to + 1;
  return after >= states.length || states[after] === UNMEASURED;
}

/**
 * 假段期间现实有没有动过。
 *
 * 窗口要从假段的前一格开始算。说法常常就是因为现实在假段第一格上变了才变假的
 * （文档写 5，现实 5 → 8），只看假段内部会漏掉这一次变化，
 * 把「现实变了、文档没跟上」误判成「现实一直没动」。
 * 前一格没有读数（还不存在、测不出来）时，窗口里就没有这一格，不会误判。
 */
export function didRealityMove(run: Pick<Run, "from" | "to">, actual: (number | null)[]): boolean {
  const start = run.from > 0 ? run.from - 1 : run.from;
  const values = actual.slice(start, run.to + 1).filter((v): v is number => v !== null);
  return values.some((v, i) => i > 0 && v !== values[i - 1]);
}

/**
 * 结局判定。
 *
 * 关键：不能只比较假段的两个端点。现实可能在假段期间一直在动
 * （例如关卡从 12 涨到 20，文档一直写 12），那种情况下文档最后追上，
 * 是「文档落后」，不是「改文档掩盖问题」。两者必须分开。
 */
export function classify(run: Run, j: Pick<Judged, "states" | "claimed" | "actual">): Outcome {
  const after = run.to + 1;

  const realityMoved = didRealityMove(run, j.actual);

  // 假段一直延续到 HEAD
  if (after >= j.states.length) {
    return realityMoved ? "hanging-reality-moved" : "hanging-reality-still";
  }

  const next = j.states[after];

  // 假段之后说法从文档里消失：必须先于「是否为真」判断。
  // 说法消失的那一格是「还不存在」，不是「真」，放在后面会永远走不到这里。
  if (next === ABSENT) return "doc-removed";

  // 说法还在，但事实读不到，无法判断这一段是怎么收场的
  if (next === UNMEASURED) return "unmeasurable";

  const claimChanged = j.claimed[after] !== j.claimed[run.to];
  const actualChanged = j.actual[after] !== j.actual[run.to];

  if (actualChanged && !claimChanged) return "reality-caught-up";
  // 说法与事实恰好在同一个 commit 上一起变：分不清谁追上谁。
  // 必须先于下面两条，否则只要说法变了就会被它们截走，「两边都变了」永远走不到。
  if (claimChanged && actualChanged) return "both-changed";
  if (claimChanged && realityMoved) return "doc-caught-up";
  if (claimChanged && !realityMoved) return "doc-corrected";
  return "anomaly";
}
