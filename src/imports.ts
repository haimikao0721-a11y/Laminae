/**
 * laminae —— 模块之间的引用关系（import / require）
 *
 * 只做「模块级」：哪个文件引用了仓库里的哪个文件。支持 JS/TS 与 Python。
 * 不做函数级的「谁调用谁」：那需要真正的语法解析器，靠正则误报太多，宁可不做。
 *
 * 这里全是纯函数，不碰 git，方便单独测试。取行与读文件由 graph.ts 负责。
 */
import { builtinModules } from "node:module";
import path from "node:path";
import { isSupportedCode } from "./lang.ts";

/** 认作代码文件的扩展名。和 lang.ts 里支持的语言一致 */
export const CODE_EXT = /\.(?:[cm]?[jt]sx?|py)$/;

/** 测试文件：目录名或文件名带 test / spec。图上默认折掉，不然它们会盖过真正的模块关系 */
export function isTestFile(file: string): boolean {
  return /(?:^|\/)(?:tests?|__tests__|specs?|e2e)\//i.test(file) || /(?:\.|_)(?:test|spec)\.[^/]+$/i.test(file) || /(?:^|\/)test_[^/]+\.py$/.test(file) || /(?:^|\/)test\.py$/.test(file) || /(?:^|\/)\.storybook\//.test(file) || /\.story(?:s)?\.[^/]+$/.test(file);
}

export function isCodeFile(file: string): boolean {
  return isSupportedCode(file);
}

/** git grep 用的扩展正则：只捞出可能含引用的行，真正的判断在 parseImportLine */
export const GREP_PATTERN =
  "(from[[:space:]]+['\"]\\.|require\\([[:space:]]*['\"]\\.|import\\([[:space:]]*['\"]\\.|import[[:space:]]+['\"]\\.|^[[:space:]]*(from|import)[[:space:]]+[A-Za-z_.])";

export interface RawImport {
  /** JS/TS：引用的相对路径，如 "./a"、"../"；Python：点号形式，如 ".x"、"pkg.sub" */
  spec: string;
  /** Python 的 `from . import a, b` 里被导入的名字，它们也可能是子模块 */
  names?: string[];
}

/** 从一行代码里取出引用。认不出来返回 null。file 决定按哪种语言解析 */
export function parseImportLine(file: string, line: string): RawImport[] | null {
  if (file.endsWith(".py")) return parsePython(line);
  if (file.endsWith(".rs")) return parseRust(line);
  // 去掉行内注释前的内容太麻烦，直接找引号里以 . 开头的路径；注释里的引用会被当成引用，这是已知的小误差
  const out: RawImport[] = [];
  const re = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}(?:\/[^'"]*)?)\1/g;
  for (const m of line.matchAll(re)) out.push({ spec: m[2]! });
  return out.length ? out : null;
}

/** Rust 的 use 与 mod。只认 crate:: / super:: / self:: 开头，外部 crate 不解析 */
function parseRust(line: string): RawImport[] | null {
  const s = line.replace(/\/\/.*$/, "").trim();
  const mod = /^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/.exec(s);
  if (mod) return [{ spec: `self::${mod[1]!}` }];
  const use = /^(?:pub(?:\([^)]*\))?\s+)?use\s+([A-Za-z_][\w:]*)/.exec(s);
  if (!use) return null;
  const spec = use[1]!;
  return /^(?:crate|super|self)::/.test(spec) ? [{ spec }] : null;
}

/** 这个文件所属 crate 的 src 目录；找不到返回 null */
function crateRoot(file: string): string | null {
  const segs = file.split("/");
  const i = segs.lastIndexOf("src");
  return i < 0 ? null : segs.slice(0, i + 1).join("/");
}

/** 这个文件对应的模块路径（相对 crate 根）。lib.rs / main.rs / mod.rs 是所在目录本身 */
function modulePath(file: string, root: string): string[] {
  const parts = file.slice(root.length + 1).split("/");
  const stem = (parts.pop() ?? "").replace(/\.rs$/, "");
  return stem === "mod" || stem === "lib" || stem === "main" ? parts : [...parts, stem];
}

/**
 * Rust 的模块路径解析：`crate::a::b` 从 src 往下找 `a/b.rs` 或 `a/b/mod.rs`。
 * `super::` 往上一层，`self::` 是当前模块。从最长的一段往回退，命中第一个存在的就停
 * —— `use a::b::C` 里的 C 是条目不是模块。
 */
export function resolveRust(from: string, spec: string, env: ResolveEnv): string[] {
  const root = crateRoot(from);
  if (root === null) return [];
  const cur = modulePath(from, root);
  const parts = spec.split("::").filter(Boolean);
  let base: string[];
  if (parts[0] === "crate") base = parts.slice(1);
  else if (parts[0] === "super") base = [...cur.slice(0, -1), ...parts.slice(1)];
  else if (parts[0] === "self") base = [...cur, ...parts.slice(1)];
  else return [];
  for (let n = base.length; n >= 0; n--) {
    const rel = base.slice(0, n).join("/");
    const candidates =
      rel === ""
        ? [`${root}/lib.rs`, `${root}/main.rs`, `${root}/mod.rs`]
        : [`${root}/${rel}.rs`, `${root}/${rel}/mod.rs`];
    const hit = candidates.filter((c) => env.files.has(c) && c !== from);
    if (hit.length > 0) return hit;
  }
  return [];
}

function parsePython(line: string): RawImport[] | null {
  const t = line.replace(/#.*$/, "").trim();
  let m = t.match(/^from\s+(\.*[A-Za-z_][\w.]*|\.+)\s+import\s+(.+)$/);
  if (m) {
    const names = m[2]!
      .replace(/[()]/g, "")
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0]!.trim())
      .filter((s) => /^[A-Za-z_]\w*$/.test(s));
    return [{ spec: m[1]!, names }];
  }
  m = t.match(/^import\s+(.+)$/);
  if (m) {
    const mods = m[1]!
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0]!.trim())
      .filter((s) => /^[A-Za-z_][\w.]*$/.test(s));
    return mods.length ? mods.map((spec) => ({ spec })) : null;
  }
  return null;
}

const JS_TRY = ["", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
/** TS 里常把 ./a.js 写成指向 ./a.ts */
const JS_SWAP: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

export interface ResolveEnv {
  /** 该 commit 上的所有文件 */
  files: Set<string>;
  /** 读文件正文（只用来读 package.json 的 main） */
  read: (file: string) => string | null;
}

const norm = (p: string): string => path.posix.normalize(p).replace(/^\.\//, "").replace(/\/$/, "");

/** 目录被当作模块引用时，取它 package.json 的 main，没有就是 index */
function resolveDirectory(dir: string, env: ResolveEnv): string | null {
  const prefix = dir === "." || dir === "" ? "" : dir + "/";
  const pkgFile = `${prefix}package.json`;
  if (env.files.has(pkgFile)) {
    const body = env.read(pkgFile);
    if (body !== null) {
      try {
        const main = (JSON.parse(body) as { main?: unknown }).main;
        if (typeof main === "string") {
          const t = norm(`${prefix}${main}`);
          for (const e of JS_TRY) if (env.files.has(t + e)) return t + e;
        }
      } catch {
        /* package.json 损坏，退回 index */
      }
    }
  }
  for (const idx of ["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs", "index.jsx"]) {
    if (env.files.has(prefix + idx)) return prefix + idx;
  }
  return null;
}

/** 解析 JS/TS 的相对引用，指向仓库里的哪个文件；解析不到返回 null */
export function resolveJs(from: string, spec: string, env: ResolveEnv): string | null {
  const target = norm(path.posix.join(path.posix.dirname(from), spec));
  const ext = path.posix.extname(target);
  for (const e of JS_TRY) if (e !== "" && env.files.has(target + e)) return target + e;
  if (env.files.has(target) && CODE_EXT.test(target)) return target;
  for (const swap of JS_SWAP[ext] ?? []) {
    const t = target.slice(0, -ext.length) + swap;
    if (env.files.has(t)) return t;
  }
  if (spec.endsWith("/") || ext === "" || !CODE_EXT.test(target)) return resolveDirectory(target, env);
  return null;
}

/** 解析 Python 的引用。相对引用按点号向上，绝对引用在仓库根与各级祖先目录里找 */
export function resolvePython(from: string, imp: RawImport, env: ResolveEnv): string[] {
  const out = new Set<string>();
  const tryModule = (base: string, dotted: string): string | null => {
    const rel = dotted === "" ? base : (base ? base + "/" : "") + dotted.replace(/\./g, "/");
    if (env.files.has(rel + ".py")) return rel + ".py";
    if (env.files.has(rel + "/__init__.py")) return rel + "/__init__.py";
    return null;
  };

  const dots = imp.spec.match(/^\.*/)![0].length;
  const rest = imp.spec.slice(dots);
  const dir = path.posix.dirname(from);

  if (dots > 0) {
    let base = dir === "." ? "" : dir;
    for (let i = 1; i < dots; i++) base = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
    const hit = tryModule(base, rest);
    if (hit) out.add(hit);
    // from . import a, b：a、b 可能是同级子模块
    for (const n of imp.names ?? []) {
      const sub = tryModule(base, rest ? `${rest}.${n}` : n);
      if (sub) out.add(sub);
    }
    return [...out];
  }

  // 绝对引用：从文件所在目录一路往上到仓库根，哪一级能找到就用哪一级
  const bases: string[] = [];
  for (let d = dir === "." ? "" : dir; ; d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "") {
    bases.push(d);
    if (d === "") break;
  }
  for (const b of bases) {
    const hit = tryModule(b, rest);
    if (hit) {
      out.add(hit);
      for (const n of imp.names ?? []) {
        const sub = tryModule(b, `${rest}.${n}`);
        if (sub) out.add(sub);
      }
      break;
    }
  }
  return [...out];
}

/** 整个文件正文里的全部引用（未解析）。引用只取决于正文，所以同一个 blob 只需要解析一次 */
export function parseFileImports(file: string, text: string): RawImport[] {
  if (text.length > 512 * 1024 || text.includes("\u0000")) return []; // 压缩产物或二进制，不是手写的引用
  const out: RawImport[] = [];
  for (const line of text.split("\n")) {
    if (line.length > 400) continue;
    const r = parseImportLine(file, line);
    if (r) out.push(...r);
  }
  return out;
}

/** 一行引用解析成它指向的文件列表（只含仓库内的、且不是自己） */
export function resolveImports(from: string, line: string, env: ResolveEnv): string[] {
  const raws = parseImportLine(from, line);
  return raws ? resolveRaw(from, raws, env) : [];
}

/** 把已解析出的引用落到仓库里的具体文件上 */
export function resolveRaw(from: string, raws: readonly RawImport[], env: ResolveEnv): string[] {
  const out = new Set<string>();
  for (const r of raws) {
    const targets = from.endsWith(".py")
      ? resolvePython(from, r, env)
      : from.endsWith(".rs")
        ? resolveRust(from, r.spec, env)
        : [resolveJs(from, r.spec, env)];
    for (const t of targets) if (t && t !== from && isCodeFile(t)) out.add(t);
  }
  return [...out];
}

/* ── 非相对的引用：包名、别名路径、monorepo 里的内部包 ──
 *
 * 图本身只画相对引用，但「A 不许引用 B」这类边界需要知道：写成 @/server/db、src/server/db、
 * @acme/server 这些形式的引用，是不是其实指向了 B。能解析的（monorepo 内部包）算进引用，
 * 解析不了又不像是第三方包的，单独记下来，由判定那边决定是「没越界」还是「测不出来」。 */

const BUILTIN = new Set(builtinModules);

const ANY_SPEC = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;

/** JS/TS 文件里所有非相对的引用字符串（包名、别名路径）。Python 不做，返回空 */
export function parseBareSpecs(file: string, text: string): string[] {
  if (file.endsWith(".py") || text.length > 512 * 1024 || text.includes("\u0000")) return [];
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.length > 400) continue;
    for (const m of line.matchAll(ANY_SPEC)) {
      const spec = m[2]!;
      if (spec.startsWith(".") || spec.startsWith("node:") || /^[a-z][a-z0-9+.-]*:/i.test(spec)) continue;
      out.add(spec);
    }
  }
  return [...out];
}

/** 引用字符串对应的包名：@scope/name/sub → @scope/name，lodash/fp → lodash，@/x/y → @/x（不是合法包名，必然落到「未知」） */
export function packageNameOf(spec: string): string {
  const seg = spec.split("/");
  return spec.startsWith("@") ? seg.slice(0, 2).join("/") : (seg[0] ?? spec);
}

export interface PackageIndex {
  /** 各 package.json 声明的依赖名（dependencies、devDependencies、peerDependencies、optionalDependencies） */
  deps: Set<string>;
  /** monorepo 里的内部包：包名 → 所在目录（根目录的 package.json 不算） */
  workspace: Map<string, string>;
}

/** 汇总一个 commit 上所有 package.json。损坏的跳过 */
export function indexPackages(pkgs: Iterable<{ file: string; body: string | null }>): PackageIndex {
  const deps = new Set<string>();
  const workspace = new Map<string, string>();
  for (const { file, body } of pkgs) {
    if (body === null) continue;
    let j: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(body);
      if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
      j = v as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const d = j[k];
      if (typeof d === "object" && d !== null) for (const name of Object.keys(d)) deps.add(name);
    }
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    if (typeof j["name"] === "string" && dir !== "") workspace.set(j["name"], dir);
  }
  return { deps, workspace };
}

export interface BareResult {
  /** 指向仓库内文件的引用（monorepo 内部包） */
  targets: string[];
  /** 既不是内置模块、不是声明过的依赖、也解析不到仓库内文件的引用 */
  unknown: string[];
}

/** 把非相对引用分三类：第三方 / 内置（忽略），内部包（解析成文件），其余（未知，可能是别名路径） */
export function resolveBareSpecs(specs: readonly string[], pk: PackageIndex, env: ResolveEnv): BareResult {
  const targets: string[] = [];
  const unknown: string[] = [];
  for (const spec of specs) {
    const name = packageNameOf(spec);
    if (BUILTIN.has(spec) || BUILTIN.has(name)) continue;
    const dir = pk.workspace.get(name);
    if (dir !== undefined) {
      const rest = spec.slice(name.length).replace(/^\//, "");
      const hit =
        rest === ""
          ? resolveDirectory(dir, env)
          : (resolveJs(`${dir}/_`, `./${rest}`, env) ?? resolveJs(`${dir}/_`, `./src/${rest}`, env));
      if (hit && isCodeFile(hit)) targets.push(hit);
      else unknown.push(spec);
      continue;
    }
    if (pk.deps.has(name)) continue;
    unknown.push(spec);
  }
  return { targets, unknown };
}
