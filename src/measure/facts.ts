/**
 * laminae —— 事实的声明式定义与求值
 *
 * 一条说法要对照的「事实」在 claims.json 里用 FactSpec 声明。
 * 数仓库的那几种只读 git 对象（文件列表与文件内容），不执行命令。
 * test-passes、invariant-holds、output-unchanged 要跑命令才知道，求值在 observe.ts，不在这里。
 */
import { repoRelative } from "../core/paths.ts";

export type FactSpec =
  /** 匹配 glob 的文件个数 */
  | { type: "count-files"; glob: string }
  /** JSON 文件里某个数组（或对象）的长度；path 省略表示根节点 */
  | { type: "json-length"; file: string; path?: string }
  /** JSON 文件里某个数值字段的值 */
  | { type: "json-number"; file: string; path: string }
  /** 文件里正则的匹配次数 */
  | { type: "regex-count"; file: string; pattern: string; flags?: string }
  /** 文件行数 */
  | { type: "line-count"; file: string }
  /** 文件字节数 */
  | { type: "file-bytes"; file: string }
  /* ── 引用型：文档里写的不是数，而是一个指向仓库内某物的引用（路径、命令名……），事实是「它存不存在」 ── */
  /** 捕获到的文本是仓库里的一个路径（文件或目录）；base 给出时相对 base 目录 */
  | { type: "path-exists"; base?: string }
  /** 捕获到的文本在 file 里出现过 */
  | { type: "text-in-file"; file: string }
  /** 捕获到的文本是 JSON 文件里某个对象的键，例如 package.json 的 scripts 里有没有这个命令 */
  | { type: "json-has-key"; file: string; path?: string }
  /**
   * 跑出来才知道。command 在该 commit 的临时工作区里执行。
   * watch：这些 glob 的内容没变就沿用上次结果；不写则每个 commit 都跑。
   * timeout：秒，缺省 60，最大 900。
   * source：结局里「声称那边有没有改」看这个文件的正文，缺省用说法所在文件。
   * 测一条测试时，把说法的 file 指到测试文件，改断言才会被认成声称变了。
   */
  | { type: "test-passes"; command: string; watch?: string[]; timeout?: number; source?: string }
  /** 同 test-passes，语义是代码自己声明的不变量。退出码 0 表示成立 */
  | { type: "invariant-holds"; command: string; watch?: string[]; timeout?: number; source?: string }
  /**
   * 跑 command，看标准输出相对「这句捕获文本第一次出现时」变没变。
   * 不判断输出对不对，只判断文档还指着这句时，输出是否还是当时那一份。
   */
  | { type: "output-unchanged"; command: string; watch?: string[]; timeout?: number };

/** 某个 commit 上的文件树，求值时只通过它读取 */
export interface Tree {
  /** 该 commit 上所有文件路径（正斜杠，相对仓库根） */
  paths(): string[];
  /** 读文件正文；该 commit 上不存在则返回 null */
  read(file: string): string | null;
}

export const FACT_TYPES = [
  "count-files",
  "json-length",
  "json-number",
  "regex-count",
  "line-count",
  "file-bytes",
  "path-exists",
  "text-in-file",
  "json-has-key",
  "test-passes",
  "invariant-holds",
  "output-unchanged",
] as const;

/**
 * 引用型事实：说法里捕获到的是一段文本而不是数，事实是「它指向的东西存不存在」。
 * 这类说法在文档里写的「数」恒为 1（断言它存在），事实是 1（存在）或 0（不存在）。
 */
export function isReferential(f: FactSpec): boolean {
  return f.type === "path-exists" || f.type === "text-in-file" || f.type === "json-has-key";
}

/** 要执行命令才知道的事实。结果是过或不过，不能写 compare */
export function isObserved(f: FactSpec): f is Extract<FactSpec, { type: "test-passes" | "invariant-holds" | "output-unchanged" }> {
  return f.type === "test-passes" || f.type === "invariant-holds" || f.type === "output-unchanged";
}

/** 测试或不变量：声称恒为「应该通过」，实际是退出码 */
export function isHold(f: FactSpec): f is Extract<FactSpec, { type: "test-passes" | "invariant-holds" }> {
  return f.type === "test-passes" || f.type === "invariant-holds";
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 校验并规范化 claims.json 里的 fact。出错抛 Error，信息要能让写 claims 的人直接改 */
export function parseFact(raw: unknown, where: string): FactSpec {
  if (!isObj(raw)) throw new Error(`${where}：fact 必须是对象，例如 { "type": "count-files", "glob": "assets/*.png" }`);
  const type = raw["type"];
  if (typeof type !== "string" || !(FACT_TYPES as readonly string[]).includes(type)) {
    throw new Error(`${where}：fact.type 必须是 ${FACT_TYPES.join(" / ")} 之一，现在是 ${JSON.stringify(type)}`);
  }

  const str = (k: string): string => {
    const v = raw[k];
    if (typeof v !== "string" || v === "") throw new Error(`${where}：fact.${k} 必须是非空字符串`);
    return v;
  };
  const rel = (k: string): string => repoRelative(str(k), `${where}：fact.${k}`);

  switch (type) {
    case "count-files":
      return { type, glob: str("glob") };
    case "json-length": {
      const p = raw["path"];
      if (p !== undefined && typeof p !== "string") throw new Error(`${where}：fact.path 必须是字符串`);
      return p === undefined ? { type, file: rel("file") } : { type, file: rel("file"), path: p };
    }
    case "json-number":
      return { type, file: rel("file"), path: str("path") };
    case "regex-count": {
      const pattern = str("pattern");
      const flags = raw["flags"];
      if (flags !== undefined && typeof flags !== "string") throw new Error(`${where}：fact.flags 必须是字符串`);
      try {
        new RegExp(pattern, flags ?? "");
      } catch (e) {
        throw new Error(`${where}：fact.pattern 不是合法正则：${(e as Error).message}`);
      }
      return flags === undefined ? { type, file: rel("file"), pattern } : { type, file: rel("file"), pattern, flags };
    }
    case "line-count":
      return { type, file: rel("file") };
    case "path-exists": {
      const b = raw["base"];
      if (b !== undefined && (typeof b !== "string" || b === "")) throw new Error(`${where}：fact.base 必须是非空字符串`);
      return b === undefined ? { type } : { type, base: repoRelative(b as string, `${where}：fact.base`) };
    }
    case "text-in-file":
      return { type, file: rel("file") };
    case "json-has-key": {
      const p = raw["path"];
      if (p !== undefined && typeof p !== "string") throw new Error(`${where}：fact.path 必须是字符串`);
      return p === undefined ? { type, file: rel("file") } : { type, file: rel("file"), path: p };
    }
    case "test-passes":
    case "invariant-holds":
    case "output-unchanged":
      return parseObserved(type, raw, where, str);
    default:
      return { type: "file-bytes", file: rel("file") };
  }
}

function parseObserved(
  type: "test-passes" | "invariant-holds" | "output-unchanged",
  raw: Record<string, unknown>,
  where: string,
  str: (k: string) => string,
): FactSpec {
  const command = str("command");
  if (command.length > 2000) throw new Error(`${where}：fact.command 最长 2000 字符`);
  const watchRaw = raw["watch"];
  let watch: string[] | undefined;
  if (watchRaw !== undefined) {
    if (!Array.isArray(watchRaw) || watchRaw.length === 0 || watchRaw.length > 20 || watchRaw.some((g) => typeof g !== "string" || g === "")) {
      throw new Error(`${where}：fact.watch 必须是 1 到 20 个非空 glob；不写表示每个 commit 都跑`);
    }
    watch = watchRaw as string[];
  }
  const timeoutRaw = raw["timeout"];
  let timeout: number | undefined;
  if (timeoutRaw !== undefined) {
    if (typeof timeoutRaw !== "number" || !Number.isInteger(timeoutRaw) || timeoutRaw < 1 || timeoutRaw > 900) {
      throw new Error(`${where}：fact.timeout 是秒，必须是 1 到 900 的整数`);
    }
    timeout = timeoutRaw;
  }
  const sourceRaw = raw["source"];
  if (sourceRaw !== undefined && type === "output-unchanged") {
    throw new Error(`${where}：output-unchanged 不用 fact.source，声称变没变看 locator 捕获到的文本`);
  }
  if (sourceRaw !== undefined && (typeof sourceRaw !== "string" || sourceRaw === "")) {
    throw new Error(`${where}：fact.source 必须是非空字符串（测试或不变量所在文件）`);
  }
  const source = typeof sourceRaw === "string" ? repoRelative(sourceRaw, `${where}：fact.source`) : undefined;
  const base = { type, command, ...(watch === undefined ? {} : { watch }), ...(timeout === undefined ? {} : { timeout }) };
  if (type === "output-unchanged") return base;
  return source === undefined ? base : { ...base, source };
}

/** 这条事实读哪些文件（证据所在）。count-files 与 path-exists 读的是一批或不固定的路径，不在此列 */
export function factFiles(f: FactSpec): string[] {
  if ("source" in f && f.source) return [f.source];
  return "file" in f ? [f.file] : [];
}

/** 一句话描述这条事实，界面里「被测事实」显示它 */
export function describeFact(f: FactSpec): string {
  switch (f.type) {
    case "count-files":
      return `文件数 ${f.glob}`;
    case "json-length":
      return `${f.file}${f.path ? " → " + f.path : ""} 的长度`;
    case "json-number":
      return `${f.file} → ${f.path}`;
    case "regex-count":
      return `${f.file} 中 /${f.pattern}/${f.flags ?? ""} 的匹配数`;
    case "line-count":
      return `${f.file} 的行数`;
    case "file-bytes":
      return `${f.file} 的字节数`;
    case "path-exists":
      return f.base ? `文档里写的路径在 ${f.base}/ 下是否存在` : "文档里写的路径是否存在";
    case "text-in-file":
      return `文档里写的文本是否出现在 ${f.file} 中`;
    case "json-has-key":
      return `文档里写的名字是否是 ${f.file}${f.path ? " → " + f.path : ""} 的键`;
    case "test-passes":
      return `跑测试 ${f.command}`;
    case "invariant-holds":
      return `跑不变量 ${f.command}`;
    case "output-unchanged":
      return `跑 ${f.command}，输出相对这句写下时变没变`;
  }
}

/** 把 glob 转成正则：`*` 不跨目录，`**` 跨目录，`?` 匹配单个非 `/` 字符 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` 可以匹配零层或多层目录
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/** 按点分路径取 JSON 里的值；数组下标用数字，如 `a.b.0.c` */
function pick(root: unknown, dotted: string | undefined): unknown {
  if (!dotted) return root;
  let cur: unknown = root;
  for (const key of dotted.split(".")) {
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else if (isObj(cur)) cur = cur[key];
    else return undefined;
  }
  return cur;
}

function readJson(tree: Tree, file: string): unknown {
  const text = tree.read(file);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // 该 commit 上是坏的 JSON
  }
}

/** 规范化文档里写的路径：去掉首尾空白、开头的 ./ 和结尾的 / */
function normalizePath(p: string): string {
  const norm = p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (norm === "" || norm.startsWith("/") || /^[A-Za-z]:/.test(norm) || norm.split("/").includes("..")) return "";
  return norm;
}

/**
 * 引用型事实求值：返回 1（存在）或 0（不存在）。
 * 没有捕获到文本（文档里没有这条说法）或读不到被查的文件时返回 null。
 */
function evalReference(f: FactSpec, tree: Tree, captured: string | null): number | null {
  if (captured === null || captured.trim() === "") return null;
  switch (f.type) {
    case "path-exists": {
      const rel = normalizePath(f.base ? `${f.base.replace(/\/+$/, "")}/${normalizePath(captured)}` : captured);
      if (rel === "") return null;
      // 文件，或者是某个目录（git 只存文件，目录靠路径前缀判断）
      return tree.paths().some((p) => p === rel || p.startsWith(`${rel}/`)) ? 1 : 0;
    }
    case "text-in-file": {
      const text = tree.read(f.file);
      return text === null ? null : text.includes(captured.trim()) ? 1 : 0;
    }
    case "json-has-key": {
      const v = pick(readJson(tree, f.file), f.path);
      return isObj(v) ? (Object.hasOwn(v, captured.trim()) ? 1 : 0) : null;
    }
    default:
      return null;
  }
}

/**
 * 在某个 commit 的文件树上求值。读不到（文件缺失、JSON 损坏、路径不存在、类型不对）返回 null，
 * 由上层记为「测不出来」；count-files 永远有值，匹配不到就是 0。
 */
export function evalFact(f: FactSpec, tree: Tree, captured: string | null = null): number | null {
  switch (f.type) {
    case "path-exists":
    case "text-in-file":
    case "json-has-key":
      return evalReference(f, tree, captured);
    case "count-files": {
      const re = globToRegExp(f.glob);
      return tree.paths().filter((p) => re.test(p)).length;
    }
    case "json-length": {
      const v = pick(readJson(tree, f.file), f.path);
      if (Array.isArray(v)) return v.length;
      if (isObj(v)) return Object.keys(v).length;
      return null;
    }
    case "json-number": {
      const v = pick(readJson(tree, f.file), f.path);
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    }
    case "regex-count": {
      const text = tree.read(f.file);
      if (text === null) return null;
      const flags = (f.flags ?? "").includes("g") ? f.flags! : (f.flags ?? "") + "g";
      return [...text.matchAll(new RegExp(f.pattern, flags))].length;
    }
    case "line-count": {
      const text = tree.read(f.file);
      if (text === null) return null;
      return text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
    }
    case "file-bytes": {
      const text = tree.read(f.file);
      return text === null ? null : Buffer.byteLength(text, "utf8");
    }
    case "test-passes":
    case "invariant-holds":
    case "output-unchanged":
      // 读文件树回答不了。measure.ts 会改走 observe.ts；这里返回 null，避免被当成 0。
      return null;
  }
}
