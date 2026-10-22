/**
 * laminae —— 运行配置
 *
 * laminae 以「当前所在的 git 仓库」为目标：在哪个项目目录下运行，就核验哪个项目。
 * 代码里不含任何具体仓库的路径或地址。
 *
 *   LAMINAE_REPO       目标仓库路径（选填，默认取当前目录所在仓库的根）
 *   LAMINAE_REPO_URL   目标仓库的网页地址，用来拼「去核对」的链接（选填，
 *                      不填则取 origin 远程；两者都没有时，界面里的行号不带链接）
 *   LAMINAE_RUN        本次运行的 id（选填，默认按时间生成）
 *   LAMINAE_VERBOSE    设为 1 等同于 --verbose，打印完整输出
 *   LAMINAE_NO_EXCLUDE 设为 1 则不往 .git/info/exclude 写入生成物
 *
 * 命令行：--repo <路径>、--run <id>、--repos a,b,c、--jobs <N>，见 scripts/run.ts。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findSubRepos } from "./repos.ts";

/** 工具自己的根。目标仓库不能是这里 */
const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function realDir(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/* ── 命令行参数 ──
 * 只认这几个。其余参数（--verbose、data 等）由各入口自己处理。
 * 认到 --run 时写进 LAMINAE_RUN，让 paths.ts 用同一个 id。 */

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return undefined;
  const v = process.argv[i + 1]!;
  return v.startsWith("--") ? undefined : v;
}

if (process.env["LAMINAE_RUN"] === undefined) {
  const run = argValue("--run");
  if (run !== undefined) process.env["LAMINAE_RUN"] = run;
  else if (process.argv.includes("--new-run")) process.env["LAMINAE_RUN"] = "new";
}

/** `--repo <path>` 优先于当前目录。LAMINAE_REPO 环境变量仍然优先于它 */
function startDir(): string {
  return process.env["LAMINAE_REPO"] || argValue("--repo") || process.cwd();
}

/**
 * 解析目标仓库根目录：优先环境变量与 --repo，否则当前目录。
 *
 * 不在仓库里时不再只说一句「不在 git 仓库里」——那个提示是死路。
 * 如果这个目录下面有仓库，把它们列出来，并给出可以直接粘的命令。
 */
function resolveRepo(): string {
  const start = startDir();
  try {
    return execFileSync("git", ["-C", start, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    const subs = findSubRepos(start);
    if (subs.length === 0) {
      return fail(`${start} 不在 git 仓库里，下面也没有找到仓库。\n请在要核验的项目目录下运行，或用 --repo <路径> 指定。`);
    }
    const list = subs.map((s) => `  ${s.rel}/`).join("\n");
    return fail(
      [
        `${start} 本身不是 git 仓库，但它下面有 ${subs.length} 个：`,
        list,
        "",
        "跑其中一个：",
        `  node <laminae>/scripts/run.ts --repo ${subs[0]!.rel}`,
        "",
        "全跑（并行度默认按 CPU，可加 --jobs N 调整）：",
        "  node <laminae>/scripts/run.ts --repos " + subs.map((s) => s.rel).join(","),
        "",
        "或者把清单写进 .laminae/repos.json，以后直接 node <laminae>/scripts/run.ts。",
      ].join("\n"),
    );
  }
}

/** 目标仓库的根目录 */
export const REPO: string = resolveRepo();

/**
 * 一次运行只绑这一个仓库，而且不能绑工具自己。
 * 放在各入口调用，不放在加载时：测试会在工具仓库里 import 这些模块。
 */
export function assertBoundRepo(): void {
  if (realDir(REPO) === realDir(SKILL_ROOT)) {
    fail(`${REPO} 是 laminae 自己的仓库，不能当被核验的项目。\n到要核验的项目目录里运行，或设置 LAMINAE_REPO 指向那个项目。`);
  }
}

/**
 * 是否打印完整输出。默认只打印紧凑摘要：输出量不随 commit 数和说法数增长，
 * 免得几千个 commit 的逐格时间线灌满终端（agent 运行时就是灌满它的上下文）。
 * 完整数据始终写在 .laminae/data/ 里。
 */
export const VERBOSE: boolean = process.argv.includes("--verbose") || process.env["LAMINAE_VERBOSE"] === "1";

/**
 * 取提交序列用的 git log 参数，measure.ts 与 build-data.ts 必须共用同一份：
 * 两边按下标对齐，参数不一致会让时间戳错位。
 *
 * --first-parent：只沿主线（每次合并只算合并提交本身）。不加的话，被合并进来的
 * 分支上的提交也会混进序列，同一条说法的真假会在不同分支的状态之间来回跳。
 * --reverse：从最早到最晚。
 */
export const LOG_ARGS: readonly string[] = ["--first-parent", "--reverse"];

/** 目标仓库的目录名，用于界面标题 */
export const REPO_NAME: string = REPO.replace(/[\\/]+$/, "").replace(/^.*[\\/]/, "");

/** 把 git 远程地址（ssh 或 https）转成网页地址；认不出来返回空串 */
function toWebUrl(remote: string): string {
  const m = remote.trim().match(/^(?:https?:\/\/|git@|ssh:\/\/git@)([^/:]+)[/:](.+?)(?:\.git)?\/?$/);
  return m ? `https://${m[1]}/${m[2]}` : "";
}

function resolveRepoUrl(): string {
  if (process.env.LAMINAE_REPO_URL) return process.env.LAMINAE_REPO_URL.replace(/\/+$/, "");
  try {
    const remote = execFileSync("git", ["-C", REPO, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return toWebUrl(remote);
  } catch {
    return "";
  }
}

/** 目标仓库的网页地址；没有则为空串 */
export const REPO_URL: string = resolveRepoUrl();
