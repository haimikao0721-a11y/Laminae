/**
 * laminae —— 引用关系图随时间的行程编码（纯函数，不碰 git）
 *
 * 输入：每个 commit 上有哪些代码文件、文件之间有哪些引用。
 * 输出：每个节点、每条边「在哪些 commit 区间里存在」。同一条边在整个历史上通常只出现几段，
 * 逐 commit 存会把同一个结果重复几千遍，行程编码之后只剩几段区间。
 */
import { groupOf } from "./graph-util.ts";
import { isTestFile } from "./imports.ts";
import type { GraphData, Interval } from "../core/types.ts";

export { aliveAt, groupOf } from "./graph-util.ts";

export interface CommitGraph {
  /** 该 commit 上的代码文件 */
  files: readonly string[];
  /** 文件之间的引用：[引用方, 被引用方] */
  edges: readonly (readonly [string, string])[];
}

/** 节点数超过这个值就按目录合并，否则图挤成一团看不清 */
export const MAX_NODES = 350;

/** 选一个最细的合并深度，使节点数不超过上限。文件数本来就少则不合并，返回 null */
export function chooseDepth(all: ReadonlySet<string>, max = MAX_NODES): number | null {
  if (all.size <= max) return null;
  // 从文件实际的最深目录层数开始往浅处试，这样报出来的深度就是真正合并到了第几级
  let deepest = 1;
  for (const f of all) deepest = Math.max(deepest, Math.min(8, f.split("/").length - 1));
  for (let d = deepest; d >= 1; d--) {
    const groups = new Set([...all].map((f) => groupOf(f, d)));
    if (groups.size <= max) return d;
  }
  return 1;
}

/** 逐 commit 的 0/1 序列折成区间，闭区间 */
function toIntervals(flags: readonly boolean[]): Interval[] {
  const out: Interval[] = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    const on = i < flags.length && flags[i]!;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      out.push([start, i - 1]);
      start = -1;
    }
  }
  return out;
}

export function buildGraph(commits: readonly CommitGraph[]): GraphData {
  const everFiles = new Set<string>();
  for (const c of commits) for (const f of c.files) everFiles.add(f);

  const depth = chooseDepth(everFiles);
  const idOf = (f: string): string => (depth === null ? f : groupOf(f, depth));

  const n = commits.length;
  const nodeFlags = new Map<string, boolean[]>();
  /** 节点下是否出现过非测试文件 */
  const hasNonTest = new Set<string>();
  const edgeFlags = new Map<string, boolean[]>();

  commits.forEach((c, i) => {
    for (const f of c.files) {
      const id = idOf(f);
      if (!isTestFile(f)) hasNonTest.add(id);
      let fl = nodeFlags.get(id);
      if (!fl) nodeFlags.set(id, (fl = new Array<boolean>(n).fill(false)));
      fl[i] = true;
    }
    for (const [a, b] of c.edges) {
      const s = idOf(a);
      const t = idOf(b);
      if (s === t) continue; // 合并之后落在同一个节点内的引用不画
      const key = `${s}\u0000${t}`;
      let fl = edgeFlags.get(key);
      if (!fl) edgeFlags.set(key, (fl = new Array<boolean>(n).fill(false)));
      fl[i] = true;
    }
  });

  const ids = [...nodeFlags.keys()].sort();
  const index = new Map(ids.map((id, k) => [id, k]));

  return {
    level: depth === null ? "file" : "dir",
    depth,
    nodes: ids.map((id) => ({ id, alive: toIntervals(nodeFlags.get(id)!), test: !hasNonTest.has(id) })),
    edges: [...edgeFlags.entries()]
      .map(([key, fl]) => {
        const [s, t] = key.split("\u0000") as [string, string];
        return { s: index.get(s)!, t: index.get(t)!, alive: toIntervals(fl) };
      })
      .sort((a, b) => a.s - b.s || a.t - b.t),
    fileCount: everFiles.size,
  };
}
