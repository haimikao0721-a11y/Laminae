/**
 * laminae —— 引用关系图里浏览器端也要用的两个纯函数
 *
 * 单独放一个文件、不引任何 node 模块，浏览器端打包才不会把 node:path 之类带进去。
 */
import type { Interval } from "./types.ts";

/** 文件所在目录的前 depth 级；根目录下的文件归到 "." */
export function groupOf(file: string, depth: number): string {
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
  if (dir === ".") return ".";
  return dir.split("/").slice(0, depth).join("/");
}

/** 区间列表里有没有包含 c。区间按从小到大排好 */
export function aliveAt(alive: readonly Interval[], c: number): boolean {
  for (const [a, b] of alive) {
    if (c < a) return false;
    if (c <= b) return true;
  }
  return false;
}
