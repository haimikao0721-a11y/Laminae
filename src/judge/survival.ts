/**
 * laminae —— 生存分析与收场方式汇总
 *
 * 纯函数，不读文件、不打印。
 *
 * 为什么不用中位数：到 HEAD 仍挂着的假段是「右删失」的，只知道它至少挂了这么久，
 * 真实长度还在继续变长。把它们当作「就结束在这里」去取中位数，结果会系统性偏小。
 * Kaplan-Meier 估计把删失的段算进「仍在风险中」的人数，只在它被观察到的那段时间里起作用，
 * 不会把它当成已经结束。
 */
import type { Outcome } from "../core/types.ts";

/** 一个观察：持续了多久（commit 数或小时数），以及它是否真的结束了 */
export interface Obs {
  time: number;
  /** true = 假段确实结束了；false = 右删失，只知道至少这么久 */
  event: boolean;
}

export interface KMPoint {
  t: number;
  /** 在 t 时刻仍在风险中的人数 */
  atRisk: number;
  /** 恰在 t 时刻结束的个数 */
  events: number;
  /** t 之后的生存概率：假段持续超过 t 的概率 */
  surv: number;
}

export interface KMResult {
  n: number;
  events: number;
  censored: number;
  curve: KMPoint[];
  /** 生存概率降到 0.5 以下（含）的最早时刻；曲线一直没降到 0.5 就是 null，表示中位数无法估计 */
  median: number | null;
}

/**
 * Kaplan-Meier 估计。
 * 同一时刻既有结束又有删失时，删失的算作在该时刻仍在风险中（标准约定）。
 */
export function kaplanMeier(obs: Obs[]): KMResult {
  const n = obs.length;
  const events = obs.filter((o) => o.event).length;
  const times = [...new Set(obs.filter((o) => o.event).map((o) => o.time))].sort((a, b) => a - b);

  const curve: KMPoint[] = [];
  let surv = 1;
  let median: number | null = null;
  for (const t of times) {
    const atRisk = obs.filter((o) => o.time >= t).length;
    const d = obs.filter((o) => o.event && o.time === t).length;
    surv *= 1 - d / atRisk;
    curve.push({ t, atRisk, events: d, surv });
    // 浮点误差：恰好 0.5 时连乘可能得到 0.5000000000000001
    if (median === null && surv <= 0.5 + 1e-12) median = t;
  }
  return { n, events, censored: n - events, curve, median };
}

/** 收场方式的汇总，方向（改文档还是改现实）单独拆出来 */
export interface Closure {
  /** 文档追上了现实，或文档被改正：不一致靠改文档消失，说法本身还在 */
  docUpdated: number;
  /** 说法被删掉或改模糊：不一致靠删说法消失 */
  docRemoved: number;
  /** 现实追上了说法：不一致靠改现实消失 */
  realityFixed: number;
  /** 收场了，但方向判不出来：两边同时变、事实测不出来、无故翻转 */
  undetermined: number;
  /** 到 HEAD 仍挂着 */
  pending: number;
  /** 已收场且方向可判定的段数 = docUpdated + docRemoved + realityFixed */
  determinable: number;
}

export function summarizeClosure(outcomes: Partial<Record<Outcome, number>>): Closure {
  const n = (o: Outcome): number => outcomes[o] ?? 0;
  const docUpdated = n("doc-caught-up") + n("doc-corrected");
  const docRemoved = n("doc-removed");
  const realityFixed = n("reality-caught-up");
  return {
    docUpdated,
    docRemoved,
    realityFixed,
    undetermined: n("both-changed") + n("unmeasurable") + n("anomaly"),
    pending: n("hanging-reality-still") + n("hanging-reality-moved"),
    determinable: docUpdated + docRemoved + realityFixed,
  };
}
