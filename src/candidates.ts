/**
 * laminae —— 想法线索的提取（纯函数部分）
 *
 * 路线图里的 `- [ ]` 清单、代码里的 TODO / FIXME，都是「有人想过要做」的痕迹，
 * 但它们只是线索：没勾选不等于没做（常见的是做完直接删掉清单项），TODO 也可能早就过时。
 * 所以这里只提取与计数，不判定，由人或 agent 确认后写进 ideas.json 才算数。
 */
import type { Candidate } from "./types.ts";

/** git grep 取清单项的扩展正则 */
export const CHECKLIST_PATTERN = "^[[:space:]]*[-*][[:space:]]+\\[[ xX]\\]";
/** git grep 取 TODO 的扩展正则 */
export const TODO_PATTERN = "(TODO|FIXME|XXX|HACK)([^A-Za-z]|$)";

/** 数量统计时要排除的路径：文档（清单与 TODO 分开统计）、锁文件、依赖与产物 */
export const TODO_EXCLUDES = [
  ":(exclude,glob)**/*.md",
  ":(exclude,glob)**/*.lock",
  ":(exclude,glob)**/package-lock.json",
  ":(exclude,glob)**/node_modules/**",
  ":(exclude,glob)**/dist/**",
  ":(exclude,glob)**/vendor/**",
  ":(exclude,glob)**/*.min.*",
];

/** git grep 输出的一行：<rev>:<path>:<行号>:<内容> */
export function parseGrepLine(rev: string, line: string): { file: string; line: number; text: string } | null {
  if (!line.startsWith(`${rev}:`)) return null;
  const m = line.slice(rev.length + 1).match(/^(.*?):(\d+):(.*)$/);
  return m ? { file: m[1]!, line: Number(m[2]), text: m[3]! } : null;
}

const clip = (s: string, n = 140): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** 清单项：返回文本与是否已勾选；不是清单项返回 null */
export function parseChecklist(text: string): { text: string; done: boolean } | null {
  const m = text.match(/^\s*[-*]\s+\[([ xX])\]\s*(.*)$/);
  return m ? { text: clip(m[2]!.trim()), done: m[1] !== " " } : null;
}

/** TODO 行：取标记之后的说明；没有说明就取整行 */
export function parseTodo(text: string): string {
  const m = text.match(/(?:TODO|FIXME|XXX|HACK)(.*)$/);
  // 去掉 TODO(某人) 里的署名，再去掉冒号、破折号之类的分隔
  const tail = (m?.[1] ?? "").replace(/^\([^)]*\)/, "").replace(/^[:\s\-–]+/, "").trim();
  return clip(tail || text.trim());
}

/** 把 git grep 的清单项输出整理成候选，未勾选的排前面 */
export function collectChecklist(rev: string, out: string | null): Candidate[] {
  const items: Candidate[] = [];
  for (const raw of (out ?? "").split("\n")) {
    const g = parseGrepLine(rev, raw);
    const c = g && parseChecklist(g.text);
    if (g && c) items.push({ file: g.file, line: g.line, text: c.text, done: c.done });
  }
  return items.sort((a, b) => Number(a.done) - Number(b.done));
}

export function collectTodos(rev: string, out: string | null): Candidate[] {
  const items: Candidate[] = [];
  for (const raw of (out ?? "").split("\n")) {
    const g = parseGrepLine(rev, raw);
    if (g && g.text.length < 400) items.push({ file: g.file, line: g.line, text: parseTodo(g.text) });
  }
  return items;
}

/** 在 [0, n) 里均匀取最多 k 个下标，含首尾 */
export function sampleIndexes(n: number, k: number): number[] {
  if (n <= 0) return [];
  if (n <= k) return Array.from({ length: n }, (_, i) => i);
  return Array.from({ length: k }, (_, i) => Math.round((i * (n - 1)) / (k - 1)));
}
