/**
 * laminae —— 把一个「脚本在仓库里的相对路径」解析成**这次真的能执行的文件**
 *
 * 有两条路径：
 *
 *   在仓库里跑       <pkg>/src/measure/measure.ts       直接跑源码
 *   装成包之后跑     <pkg>/build/measure.mjs            跑打包产物
 *
 * 为什么不能统一：Node 拒绝为 `node_modules` 下的 `.ts` 擦除类型
 * （`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），所以发布出去的那份必须是 js。
 *
 * 规则很简单：**先在 build/ 里找同名产物，找不到再退回源码。**
 * 打包时每个入口都用文件名扁平化命名（`src/output/build-data.ts` → `build/build-data.mjs`），
 * 这几个名字之间不会撞车。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findSkillRoot } from "./root.ts";

// 刻意不 import paths.ts：那会把 config.ts 一并拉进来，而 config.ts 在模块加载时
// 就会去解析目标仓库，解析不到直接 process.exit。run.ts 自己有一套「目录下面有仓库」
// 的处理，比 config 那句提示更好；早一步 import config 会让它永远轮不到。
const SKILL_ROOT = findSkillRoot(path.dirname(fileURLToPath(import.meta.url)));

/** @param rel 相对仓库根的脚本路径，例如 `src/measure/measure.ts` */
/**
 * 只有**自己也是从 build/ 里跑起来**的时候才用产物。
 *
 * 这一条很重要：仓库里执行过 npm run build:cli 之后，build/ 会留在磁盘上。
 * 如果无条件优先用产物，那么本机跑测试、跑源码，实际执行的都是那批可能已经过期的
 * 打包文件 —— 改了源码不生效，而且看不出来。按「自己从哪来」判断就不会错。
 */
const SELF = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILD = SELF.split(path.sep).includes("build");

export function entryScript(rel: string): string {
  if (RUNNING_FROM_BUILD) {
    const base = path.basename(rel).replace(/\.ts$/, ".mjs");
    const built = path.join(SKILL_ROOT, "build", base);
    if (fs.existsSync(built)) return built;
  }
  return path.join(SKILL_ROOT, rel);
}

/**
 * 这个文件到底存不存在。给「启动子进程之前先确认」用。
 * 打包之后 `src/` 不在包里也没关系，只要产物在。
 */
export function entryExists(rel: string): boolean {
  return fs.existsSync(entryScript(rel));
}

/**
 * 这个模块是不是**正在被当成入口直接执行**。
 *
 * 原来是 `path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))`。
 * 打包之后这个判断会出错：模块被内联进别的入口，import.meta.url 变成那个入口的路径，
 * 于是它把自己当成入口跑起来了 —— init 里调用 lookClaim，结果 lookup 的 main() 也跑了，
 * 还去打开 `--dry-run` 这个参数当文件。
 *
 * build-cli.ts 用 define 把 process.env.LAMINAE_BUNDLED 换成字符串 "1"，
 * 所以打包产物里这一行恒假：入口自己的 main() 是被无条件调用的，不需要这个判断。
 */
export function isEntry(moduleUrl: string): boolean {
  if (process.env.LAMINAE_BUNDLED === "1") return false;
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(moduleUrl));
}
