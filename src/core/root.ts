/**
 * laminae —— 找到工具自己的根目录
 *
 * 这件事本来是一行 `path.resolve(HERE, "../..")`，但在**打包之后就不成立了**：
 *
 *   源码：  <pkg>/src/core/paths.ts   →  HERE = <pkg>/src/core  →  ../.. = <pkg>
 *   打包：  <pkg>/build/run.mjs        →  HERE = <pkg>/build     →  ../.. = <pkg> 的上一级
 *
 * 打包时 esbuild 把 import.meta.url 换成产物文件的位置，所以 `../..` 会跑到包外面去，
 * 报告里引用的 dist/app.js 和 web/style.css 就都找不到了。
 *
 * 改成往上找：**从自己所在目录开始往上走，第一个既有 package.json 又有 dist/ 的目录就是它。**
 * 两种布局都能认出来，也不怕以后目录再挪。
 *
 * 找不到就退回老算法 —— 宁可报一个能看懂的错误，也不要在这里抛异常。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_UP = 6;

/** 判断一个目录像不像 laminae 自己的根 */
function looksLikeRoot(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "dist", "app.js"));
  } catch {
    return false;
  }
}

/**
 * @param here 从哪个目录开始找（一般是 `path.dirname(fileURLToPath(import.meta.url))`）
 */
export function findSkillRoot(here: string): string {
  let dir = here;
  for (let i = 0; i < MAX_UP; i++) {
    if (looksLikeRoot(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // 退回老算法：源码布局下这里是 `<pkg>/src/core` → `../..` 正好是 `<pkg>`
  return path.resolve(here, "../..");
}

/** 本文件所在目录 */
export const HERE = path.dirname(fileURLToPath(import.meta.url));

/** laminae 自身的根目录，用来找预构建的浏览器端脚本与样式 */
export const SKILL_ROOT = findSkillRoot(HERE);
