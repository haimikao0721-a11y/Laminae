/**
 * laminae —— 读 git 对象库的共用工具
 *
 * 所有步骤都只通过它读目标仓库：不检出、不写工作区。
 */
import { execFileSync } from "node:child_process";
import { REPO } from "./config.ts";
import type { Tree } from "./facts.ts";

/**
 * 解析 `git cat-file --batch` 的输出。按字节切，不按字符，否则含非 UTF-8 的文件会把后面的条目错位。
 * `oid missing` 记成 null。
 */
export function parseCatFileBatch(buf: Buffer): Map<string, string | null> {
  const out = new Map<string, string | null>();
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(10, i);
    if (nl < 0) break;
    const header = buf.subarray(i, nl).toString("utf8");
    i = nl + 1;
    if (header.endsWith(" missing")) {
      out.set(header.slice(0, -" missing".length), null);
      continue;
    }
    const size = Number(header.split(" ")[2]);
    const oid = header.split(" ")[0] ?? "";
    if (!Number.isFinite(size) || size < 0) break;
    out.set(oid, buf.subarray(i, i + size).toString("utf8"));
    i += size + 1;
  }
  return out;
}

/** git 调用。core.quotepath=false 保证中文路径不被转义；失败返回 null 而不是抛。 */
export function git(args: string[]): string | null {
  try {
    return execFileSync("git", ["-c", "core.quotepath=false", "-C", REPO, ...args], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"], // 吞掉「该 commit 上文件不存在」的噪音
    });
  } catch {
    return null;
  }
}

interface Listed {
  path: string;
  oid: string;
}

function listTree(sha: string): Listed[] {
  const raw = git(["ls-tree", "-r", sha]) ?? "";
  const out: Listed[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const oid = line.slice(0, tab).split(" ")[2] ?? "";
    if (oid) out.push({ path: line.slice(tab + 1), oid });
  }
  return out;
}

/** 一次 cat-file 读一批 blob。调用方按 oid 缓存，内容没变的 commit 不再读 */
function catBlobs(oids: readonly string[]): Map<string, string | null> {
  if (oids.length === 0) return new Map();
  try {
    const buf = execFileSync("git", ["-c", "core.quotepath=false", "-C", REPO, "cat-file", "--batch"], {
      input: `${oids.join("\n")}\n`,
      maxBuffer: 256 * 1024 * 1024,
    });
    return parseCatFileBatch(buf);
  } catch {
    return new Map();
  }
}

/**
 * 跨 commit 复用 blob 正文。每个 commit 只列一次树，再把「这次要读、缓存里还没有」的 blob 一次取回。
 * pick 在路径列表出来之后决定读哪些文件：说法点名的、以及 watch 到的。
 */
export function openTrees(): { at(sha: string, pick: (paths: readonly string[]) => readonly string[]): Tree } {
  const bodies = new Map<string, string | null>();
  return {
    at(sha: string, pick: (paths: readonly string[]) => readonly string[]): Tree {
      const listed = listTree(sha);
      const oidOf = new Map(listed.map((e) => [e.path, e.oid]));
      const need: string[] = [];
      for (const file of pick(listed.map((e) => e.path))) {
        const oid = oidOf.get(file);
        if (oid && !bodies.has(oid) && !need.includes(oid)) need.push(oid);
      }
      for (const [oid, text] of catBlobs(need)) bodies.set(oid, text);
      return {
        paths: () => listed.map((e) => e.path),
        read: (file) => {
          const oid = oidOf.get(file);
          if (!oid) return null;
          if (!bodies.has(oid)) {
            const got = catBlobs([oid]);
            bodies.set(oid, got.get(oid) ?? null);
          }
          return bodies.get(oid) ?? null;
        },
      };
    },
  };
}

/** 某个 commit 上的文件树。正文按需读，不跨 commit 缓存。要复用用 openTrees */
export function treeAt(sha: string): Tree {
  return openTrees().at(sha, () => []);
}

/** 主线上的提交序列（最早在前），与 measure.ts / build-data.ts 共用 LOG_ARGS 保证下标对齐 */
export function commitShas(logArgs: readonly string[]): string[] {
  const out = git(["log", ...logArgs, "--format=%H"]);
  return out ? out.split("\n").filter(Boolean) : [];
}
