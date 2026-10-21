/**
 * laminae —— 让生成物不出现在目标仓库的 git status 里
 *
 * 做法是把生成物写进目标仓库的 .git/info/exclude。这个文件只在本地生效，
 * 不会被提交，也不改项目自己的 .gitignore，所以不会污染项目。
 *
 * 不忽略 .laminae/claims.json：它是使用者的输入，可能想提交。
 * 设置 LAMINAE_NO_EXCLUDE=1 可以关掉这一行为。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./config.ts";
import { DATA_DIR, LATEST_PATH, RUNS_DIR, SHOTS_DIR } from "./paths.ts";

const MARK = "# laminae：本地生成物，由 laminae 自动添加";

/**
 * 目标仓库里要忽略的生成物，写成 exclude 的行。在仓库之外的路径不需要忽略。
 *
 * 一律从固定目录推导，不从 HTML_PATH 推导：HTML_PATH 指到 runs/<id>/ 之后，
 * 从它反推 .laminae/shots 会拼出 runs/<id>/.laminae/shots 这种不存在的路径，
 * 而且不会报错，只会静默失效。
 *
 * 不忽略 .laminae/claims.json —— 那是使用者的输入，可能想提交。
 * latest 是一个文件，单独列；不然它会冒在 git status 里。
 * runs/ 整个忽略。想把它提交进仓库的话，git add -f .laminae/runs/，
 * 或者设 LAMINAE_NO_EXCLUDE=1 让 laminae 完全不碰 exclude。
 */
export function excludeEntries(): string[] {
  const entries: string[] = [];
  const add = (abs: string, isDir: boolean): void => {
    const rel = path.relative(REPO, abs).split(path.sep).join("/");
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return;
    entries.push(`/${rel}${isDir ? "/" : ""}`);
  };
  add(DATA_DIR, true);
  add(RUNS_DIR, true);
  add(SHOTS_DIR, true);
  add(LATEST_PATH, false);
  return [...new Set(entries)];
}

/** 把缺的行补进 .git/info/exclude。失败只提示，不影响主流程 */
export function ensureExcluded(): void {
  if (process.env["LAMINAE_NO_EXCLUDE"] === "1") return;
  try {
    const rel = execFileSync("git", ["-C", REPO, "rev-parse", "--git-path", "info/exclude"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const file = path.resolve(REPO, rel);
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const have = new Set(current.split(/\r?\n/));
    const missing = excludeEntries().filter((e) => !have.has(e));
    if (missing.length === 0) return;

    fs.mkdirSync(path.dirname(file), { recursive: true });
    const sep = current === "" || current.endsWith("\n") ? "" : "\n";
    const head = have.has(MARK) ? "" : `${MARK}\n`;
    fs.appendFileSync(file, `${sep}${head}${missing.join("\n")}\n`, "utf8");
  } catch (e) {
    console.error(`提示：没能写入 .git/info/exclude（${(e as Error).message}），生成物会出现在 git status 里。`);
  }
}
