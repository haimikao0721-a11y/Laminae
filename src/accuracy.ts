/**
 * 把工具标出的「假实现 / 被盖住」和读者判断对照。
 *
 * 读者判断问的是：这里算不算问题。不是问规则有没有按 15% 执行。
 * 标出了、读者也认为是问题 → 命中。标出了、读者认为没问题 → 误报。
 * 读者认为是问题、工具没标 → 漏报。
 */

export interface AccuracyRow {
  id: string;
  /** 读者会不会认为这里有问题 */
  problem: boolean;
  /** 工具有没有把它标成假实现或被盖住 */
  flagged: boolean;
}

export interface AccuracyScore {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** 标出来的里面，读者也认为是问题的比例。没有标出时为 null */
  precision: number | null;
  /** 读者认为是问题的里面，工具标出来的比例。没有问题时为 null */
  recall: number | null;
}

export function scoreAccuracy(rows: readonly AccuracyRow[]): AccuracyScore {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const r of rows) {
    if (r.problem && r.flagged) tp++;
    else if (!r.problem && r.flagged) fp++;
    else if (r.problem && !r.flagged) fn++;
    else tn++;
  }
  return {
    tp,
    fp,
    fn,
    tn,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
  };
}
