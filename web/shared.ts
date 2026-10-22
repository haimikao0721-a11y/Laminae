/**
 * laminae —— 浏览器端几块之间共用的状态与小工具
 *
 * 「当前时间点」只有一份：调用关系图、想法条都跟着它走，拖一处，几处一起动。
 */
import type { Commit } from "../src/core/types.ts";

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]!);

type Listener = () => void;

/** 当前看的是第几个 commit，以及对比模式下的起点（null 表示不在对比） */
export const timeline = {
  c: 0,
  from: null as number | null,
  listeners: [] as Listener[],
  set(c: number, from: number | null | undefined = undefined): void {
    timeline.c = c;
    if (from !== undefined) timeline.from = from;
    for (const l of timeline.listeners) l();
  },
  onChange(l: Listener): void {
    timeline.listeners.push(l);
  },
};

export function commitText(commits: readonly Commit[], i: number): string {
  const c = commits[i];
  return c ? `c${i} · ${c.short} · ${c.date} · ${c.subject}` : `c${i}`;
}

/** 目标路径规范化：去掉开头的 ./ 与结尾的 / */
export const normPath = (p: string): string => p.trim().replace(/^\.\//, "").replace(/\/+$/, "");

/** 调用关系图挂在 window 上的接口，想法那一块靠它把想法「指」到图上 */
export interface GraphApi {
  /** 把路径指向的节点钉住并滚到可见；可以给多个候选，取第一个能找到的。找不到返回 false */
  focusTarget(...targets: string[]): boolean;
  /** 标出一条引用边界涉及的线；两端在图上都找不到返回 false */
  focusRule(rule: { text: string; from: string; to: string; expect: "present" | "absent" }): boolean;
}