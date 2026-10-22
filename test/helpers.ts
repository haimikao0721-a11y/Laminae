/**
 * 测试辅助：在临时目录里造一个小 git 仓库，并像使用 skill 时那样，
 * 以该仓库为当前目录运行 laminae（说法定义放 .laminae/claims.json，不设任何环境变量）。
 *
 * 默认说法：文档里写「共 N 关」，事实是 assets/data/systems.json 里 levels 数组的长度。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaimInput, State } from "../src/core/types.ts";

/** laminae（skill）自己的根目录 */
export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 屏蔽本机的全局 git 配置，保证测试结果不受用户设置影响。
// Windows 上 os.devNull 不能当 git 配置文件用，所以用一个空文件。
const EMPTY_CONFIG = path.join(os.tmpdir(), "laminae-empty-gitconfig");
fs.writeFileSync(EMPTY_CONFIG, "");

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: EMPTY_CONFIG,
  GIT_CONFIG_NOSYSTEM: "1",
};

export const sys = (levels: number): string => JSON.stringify({ levels: Array(levels).fill(0), chapters: [1] });
export const readme = (levels: number | null): string =>
  levels === null ? "# demo\n\n这里没有数字。\n" : `# demo\n\n本作共 ${levels} 关。\n`;

/** 默认说法：README 里「共 N 关」，对应 systems.json 里 levels 数组的长度 */
export const LEVELS_CLAIM: ClaimInput = {
  id: "levels",
  file: "README.md",
  locator: "(\\d+) 关",
  fact: { type: "json-length", file: "assets/data/systems.json", path: "levels" },
  label: "关数",
};

export class TestRepo {
  readonly dir: string;
  private tick = 0;

  constructor() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "laminae-repo-"));
    this.git("init", "-q", "-b", "main");
  }

  git(...args: string[]): string {
    return execFileSync("git", ["-C", this.dir, "-c", "commit.gpgsign=false", ...args], {
      encoding: "utf8",
      env: { ...process.env, ...GIT_ENV },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  /** 写入 / 删除文件（值为 null 表示删除）并提交，返回提交的 sha */
  commit(files: Record<string, string | null>, message = "c"): string {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(this.dir, rel);
      if (content === null) {
        fs.rmSync(abs, { force: true });
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf8");
      }
    }
    this.git("add", "-A");
    const date = new Date(Date.UTC(2026, 0, 1, 0, this.tick++)).toISOString();
    execFileSync("git", ["-C", this.dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], {
      env: { ...process.env, ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return this.git("rev-parse", "HEAD").trim();
  }

  /** 以 --no-ff 合并分支，生成合并提交 */
  merge(branch: string): void {
    const date = new Date(Date.UTC(2026, 0, 1, 0, this.tick++)).toISOString();
    execFileSync("git", ["-C", this.dir, "-c", "commit.gpgsign=false", "merge", "--no-ff", "-q", "-m", `merge ${branch}`, branch], {
      env: { ...process.env, ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  dispose(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

export interface ResultOf {
  id: string;
  states: State[];
  outcomes: string[];
  claimed: (number | null)[];
  actual: (number | null)[];
}

export interface Pipeline {
  commitCount: number;
  results: ResultOf[];
}

/** 环境：去掉任何 LAMINAE_* 变量，确保测的是「在当前目录运行」这条默认路径 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("LAMINAE_")) delete env[k];
  return env;
}

/** 在仓库里写入 .laminae/claims.json（未跟踪，不会影响 git 历史） */
export function writeClaims(repo: TestRepo, claims: unknown): void {
  const dir = path.join(repo.dir, ".laminae");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "claims.json"), JSON.stringify(claims), "utf8");
}

/** 以仓库为当前目录运行 laminae 的某个脚本，返回标准输出；失败时抛错，带上标准错误 */
export function runLaminae(repo: TestRepo, script: string, args: string[] = [], extraEnv: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [path.join(SKILL_ROOT, script), ...args], {
    cwd: repo.dir,
    env: { ...cleanEnv(), ...extraEnv },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 对仓库跑 measure 与 analyze，返回 timeline.json 的内容 */
export function runPipeline(repo: TestRepo, claims: ClaimInput[] = [LEVELS_CLAIM]): Pipeline {
  writeClaims(repo, claims);
  for (const step of ["src/measure/measure.ts", "src/judge/analyze.ts"]) runLaminae(repo, step);
  return JSON.parse(fs.readFileSync(path.join(repo.dir, ".laminae", "data", "timeline.json"), "utf8")) as Pipeline;
}

/* ── 运行产物 ──
 *
 * 生成物现在落在 .laminae/runs/<id>/ 下，每次运行一个目录。
 * 测试不该假设 id 是什么，从这里取最近一次。 */

/** 最近一次运行的目录。没有运行过就抛，让测试立刻看出是「根本没跑成」 */
export function latestRunDir(repo: TestRepo): string {
  const runs = path.join(repo.dir, ".laminae", "runs");
  const ids = fs.existsSync(runs)
    ? fs
        .readdirSync(runs, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    : [];
  const last = ids.at(-1);
  if (!last) throw new Error(`${repo.dir} 下没有运行产物，.laminae/runs 是空的`);
  return path.join(runs, last);
}

/** 最近一次运行里的某个产物文件，例如 payload.json / laminae.html */
export function runFile(repo: TestRepo, name: string): string {
  return path.join(latestRunDir(repo), name);
}

/** 最近一次运行的 payload.json 内容 */
export function latestPayload(repo: TestRepo): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(runFile(repo, "payload.json"), "utf8")) as Record<string, unknown>;
}

/** 最近一次运行的 laminae.html 内容 */
export function latestHtml(repo: TestRepo): string {
  return fs.readFileSync(runFile(repo, "laminae.html"), "utf8");
}

/** .laminae/latest 指针指向的 id */
export function latestPointer(repo: TestRepo): string | null {
  try {
    return fs.readFileSync(path.join(repo.dir, ".laminae", "latest"), "utf8").trim() || null;
  } catch {
    return null;
  }
}
