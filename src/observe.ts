/**
 * laminae —— 跑出来才知道的事实
 *
 * 数文件、对路径、对文本，判据都在仓库里，只能回答「在不在」。
 * 测试过不过、不变量成不成立、同一份输入的输出变没变，要执行命令才知道。
 *
 * 执行发生在临时 git worktree 里，不改目标仓库的主工作区。
 * 命令写在 claims.json 里，按 shell 执行，权限和跑这条命令的人一样。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { globToRegExp } from "./facts.ts";
import type { FactSpec } from "./facts.ts";

export type ObservedKind = "test-passes" | "invariant-holds" | "output-unchanged";

export type ObservedFact = Extract<FactSpec, { type: ObservedKind }>;

/** 一条命令的结果。failed 表示超时或进程没起来，不是「检查没通过」 */
export interface CommandOutcome {
  failed: boolean;
  code: number | null;
  stdout: string;
}

export interface ObserveCache {
  key: string;
  value: number | null;
}

const DEFAULT_TIMEOUT_SEC = 60;

/** 换行归一、去掉末尾空白，避免只差一个换行就算「变了」 */
export function normalizeOutput(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

/** 输出的指纹。相等即同一份输出；0 也是合法指纹，缺失只用 null */
export function fingerprint(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 命令结果 → 事实的数。
 * 测试和不变量：退出码 0 为 1，非 0 为 0。
 * 输出差分：标准输出的指纹；非 0 退出算另一种输出，不是「测不出来」。
 * 超时或起不来为 null。
 */
export function interpretObserved(type: ObservedKind, result: CommandOutcome): number | null {
  if (result.failed || result.code === null) return null;
  if (type === "output-unchanged") {
    const body = result.code === 0 ? result.stdout : `\0exit:${result.code}\n${result.stdout}`;
    return fingerprint(normalizeOutput(body));
  }
  return result.code === 0 ? 1 : 0;
}

/**
 * 输出指纹相对「这句捕获文本第一次出现时」的基线。
 * 相同为 1，不同为 0，没有指纹为 null。捕获文本变了，基线跟着重置。
 * 句子不在（captured 为 null）时这一格也是 null，由上层记成「还不存在」。
 */
export function alignToBaseline(captured: readonly (string | null)[], fingerprints: readonly (number | null)[]): (number | null)[] {
  const out: (number | null)[] = [];
  let text: string | null = null;
  let base: number | null = null;
  for (let i = 0; i < captured.length; i++) {
    const cap = captured[i] ?? null;
    const fp = fingerprints[i] ?? null;
    if (cap === null) {
      out.push(null);
      continue;
    }
    if (cap !== text) {
      text = cap;
      base = fp;
    } else if (base === null && fp !== null) {
      base = fp;
    }
    out.push(fp === null || base === null ? null : fp === base ? 1 : 0);
  }
  return out;
}

/** watch 到的文件内容没变就返回同一个键；一个都没匹配到返回 null，调用方应照跑、不缓存 */
export function watchKey(paths: readonly string[], read: (file: string) => string | null, globs: readonly string[]): string | null {
  const res = globs.map((g) => globToRegExp(g));
  const hit = paths.filter((p) => res.some((r) => r.test(p))).sort();
  if (hit.length === 0) return null;
  let h = 2166136261;
  const mix = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  };
  for (const p of hit) {
    mix(p);
    mix("\0");
    mix(read(p) ?? "");
    mix("\0");
  }
  return (h >>> 0).toString(16);
}

export function runCommand(command: string, cwd: string, timeoutMs: number): CommandOutcome {
  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  const timedOut = !!r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  if (timedOut || r.status === null) return { failed: true, code: null, stdout: "" };
  const stdout = typeof r.stdout === "string" ? r.stdout : "";
  return { failed: false, code: r.status, stdout };
}

/**
 * 一个 commit 上求一次观察。watch 的内容与上次相同则不重复跑。
 * materialize 返回 null 表示这个 commit 准备不了工作区，记成测不出来，不缓存。
 */
export function nextObservation(opts: {
  fact: ObservedFact;
  sha: string;
  paths: readonly string[];
  read: (file: string) => string | null;
  cache: ObserveCache | undefined;
  materialize: (sha: string) => string | null;
  run: (command: string, cwd: string, timeoutMs: number) => CommandOutcome;
}): { value: number | null; cache: ObserveCache | undefined; ran: boolean } {
  const key = opts.fact.watch ? watchKey(opts.paths, opts.read, opts.fact.watch) : opts.sha;
  if (key !== null && opts.cache && opts.cache.key === key) {
    return { value: opts.cache.value, cache: opts.cache, ran: false };
  }
  const cwd = opts.materialize(opts.sha);
  if (cwd === null) return { value: null, cache: opts.cache, ran: false };
  const timeoutMs = (opts.fact.timeout ?? DEFAULT_TIMEOUT_SEC) * 1000;
  const value = interpretObserved(opts.fact.type, opts.run(opts.fact.command, cwd, timeoutMs));
  const cache = key === null ? opts.cache : { key, value };
  return { value, cache, ran: true };
}

/** 反复检出到同一个临时 worktree。关闭时删掉，不碰主工作区 */
export function openWorktree(repo: string): { at(sha: string): string | null; close(): void } {
  const parent = mkdtempSync(path.join(tmpdir(), "laminae-"));
  const dir = path.join(parent, "wt");
  let added = false;
  return {
    at(sha: string): string | null {
      try {
        if (!added) {
          execFileSync("git", ["-C", repo, "worktree", "add", "--detach", dir, sha], { stdio: "ignore" });
          added = true;
        } else {
          execFileSync("git", ["-C", dir, "checkout", "--detach", "--force", sha], { stdio: "ignore" });
        }
        return dir;
      } catch {
        return null;
      }
    },
    close(): void {
      try {
        if (added) execFileSync("git", ["-C", repo, "worktree", "remove", "--force", dir], { stdio: "ignore" });
      } catch {
        /* 工作区删不掉也不该挡住测量结果落盘 */
      }
      rmSync(parent, { recursive: true, force: true });
    },
  };
}
