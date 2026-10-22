/**
 * laminae —— 数值说法怎么和事实比（纯函数，浏览器端也用）
 *
 * 文档里的数不一定是精确值：「1600+」是下限，「不超过 50」是上限，「约 2000」是近似。
 * 说法默认严格相等（eq），要换比较方式就在 claims.json 里写 compare：
 *
 *   eq      文档写的数 = 事实（默认）
 *   gte     事实 ≥ 文档写的数      「1600+」「至少 10 项」「more than 10」
 *   lte     事实 ≤ 文档写的数      「最多 50」「不超过 50」
 *   approx  事实与文档写的数相差不超过 tolerance 倍（相对误差，默认 0.05）   「约 2000」
 *
 * 只比较方向，不判断文档写的下限是不是太保守：README 写「1000+」、实际 1539，gte 下仍然是真。
 * 「写得太旧」是另一回事，要靠把 compare 换成 approx 或写成精确值来暴露。
 */

export const COMPARES = ["eq", "gte", "lte", "approx"] as const;
export type Compare = (typeof COMPARES)[number];

export const DEFAULT_TOLERANCE = 0.05;

/** 事实是否满足文档写的数 */
export function satisfies(claimed: number, actual: number, compare: Compare = "eq", tolerance: number = DEFAULT_TOLERANCE): boolean {
  switch (compare) {
    case "eq":
      return claimed === actual;
    case "gte":
      return actual >= claimed;
    case "lte":
      return actual <= claimed;
    case "approx":
      return claimed === 0 ? actual === 0 : Math.abs(actual - claimed) <= Math.abs(claimed) * tolerance;
  }
}

const INEXACT =
  /\d\+(?![\w+])|[≥≤≈~]\s*\d|约|大约|至少|超过|不少于|不超过|多于|少于|最多|上下|左右|\b(?:at least|at most|more than|over|about|around|approximately|up to|fewer than|less than|nearly)\b/i;

/**
 * 文档里这个数周围的措辞像不像「下限 / 上限 / 近似」。像的话返回命中的那一小段，不像返回 null。
 * 只用来提醒使用者：这条说法按严格相等比较，可能不是本意。工具不替人改比较方式。
 */
export function inexactWording(context: string): string | null {
  return INEXACT.exec(context)?.[0] ?? null;
}

/** 界面上数前面的符号；eq 不加 */
export function comparePrefix(compare: Compare | undefined): string {
  return compare === "gte" ? "≥ " : compare === "lte" ? "≤ " : compare === "approx" ? "≈ " : "";
}

/** 一句话说明比较方式，「被测事实」旁边显示。eq 返回空串 */
export function describeCompare(compare: Compare | undefined, tolerance: number = DEFAULT_TOLERANCE): string {
  switch (compare) {
    case "gte":
      return "事实不小于文档写的数";
    case "lte":
      return "事实不大于文档写的数";
    case "approx":
      return `事实与文档写的数相差不超过 ${Math.round(tolerance * 1000) / 10}%`;
    default:
      return "";
  }
}
