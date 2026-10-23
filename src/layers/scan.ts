/**
 * laminae —— 逐 commit 扫描代码文件之间的引用（读 git 对象，不检出）
 *
 * graph.ts（画引用图）和 ideas.ts（判定「A 不许引用 B」这类边界）共用这一份扫描，
 * 两边看到的引用关系因此完全一致。
 *
 * 省时间的两个办法：
 *   1. 文件正文用一个常驻的 `git cat-file --batch` 读，而且同一个 blob 只读、只解析一次；
 *      相邻 commit 绝大多数文件没变，所以每个 commit 只多读几个新文件。
 *   2. 代码文件与 package.json 完全没变的 commit 直接沿用上一个结果。
 */
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { REPO } from "../core/config.ts";
import type { CommitGraph } from "./graph-core.ts";
import { TreeWalker } from "./treewalk.ts";
import { astroFrontmatter, indexPackages, isCodeFile, isTestFile, parseBareSpecs, parseFileImports, resolveBareSpecs, resolvePython, resolveRaw, sfcScript } from "./imports.ts";
import { isUnsupportedCode } from "./lang.ts";
import type { RawImport, ResolveEnv } from "./imports.ts";
import { EMPTY_COMMIT_LAYER, mountRoutes, scanFileLayer } from "./layers-core.ts";
import type { CommitLayer, FileLayer } from "./layers-core.ts";

/** 常驻的 git cat-file --batch：按 blob 号批量读正文，免得每个文件起一个进程 */
export class BlobReader {
  private proc: ChildProcessByStdio<Writable, Readable, null>;
  private buf: Buffer = Buffer.alloc(0);
  private wake: (() => void) | null = null;
  private closed = false;

  constructor() {
    this.proc = spawn("git", ["-C", REPO, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "ignore"] });
    this.proc.stdout.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.wake?.();
    });
    this.proc.on("close", () => {
      this.closed = true;
      this.wake?.();
    });
    this.proc.stdin.on("error", () => {
      /* 进程已退出，读取侧会发现 */
    });
  }

  private async fill(enough: () => boolean): Promise<void> {
    while (!enough()) {
      if (this.closed) throw new Error("git cat-file 意外退出");
      await new Promise<void>((r) => (this.wake = r));
    }
    this.wake = null;
  }

  async read(oids: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (let i = 0; i < oids.length; i += 200) {
      const chunk = oids.slice(i, i + 200);
      this.proc.stdin.write(chunk.join("\n") + "\n");
      for (const oid of chunk) {
        await this.fill(() => this.buf.includes(10));
        const nl = this.buf.indexOf(10);
        const header = this.buf.subarray(0, nl).toString("utf8");
        this.buf = this.buf.subarray(nl + 1);
        if (header.endsWith(" missing")) {
          out.set(oid, null);
          continue;
        }
        const size = Number(header.split(" ")[2]);
        await this.fill(() => this.buf.length >= size + 1);
        out.set(oid, this.buf.subarray(0, size).toString("utf8"));
        this.buf = this.buf.subarray(size + 1);
      }
    }
    return out;
  }

  close(): void {
    this.proc.stdin.end();
  }
}

/** 一个 commit 上：文件 → blob 号，以及判断「引用有没有可能变过」的签名 */
function snapshot(files_: ReadonlyMap<string, string>): {
  files: Map<string, string>;
  code: string[];
  unsupported: string[];
  pkgs: string[];
  declares: string[];
  sig: string;
} {
  // 文件表由 TreeWalker 滚动重建，一次 git 调用覆盖整条主线。
  // 原来每个 commit 一次 ls-tree，Windows 上进程启动就要 29 ms。
  const files = new Map<string, string>();
  const code: string[] = [];
  const unsupported: string[] = [];
  const pkgs: string[] = [];
  const declares: string[] = [];
  const h = createHash("sha1");
  for (const [file, oid] of files_) {
    files.set(file, oid);
    if (isCodeFile(file)) {
      code.push(file);
      h.update(`${oid}\t${file}\n`);
    } else if (isUnsupportedCode(file)) {
      unsupported.push(file);
      h.update(`${oid}\t${file}\n`);
    } else if (file === "package.json" || file.endsWith("/package.json")) {
      pkgs.push(file);
      declares.push(file);
      h.update(`${oid}\t${file}\n`);
    } else if (DECLARES_EXT.test(file) && !BIG_EXT.test(file)) {
      // 配置、清单、页面与文档：里面有路径字面量的可能。改了会影响「按约定加载」的判定，
      // 所以要进签名 —— 但正文按 blob 缓存，实际不会重读
      declares.push(file);
      h.update(`${oid}\t${file}\n`);
    }
  }
  return { files, code, unsupported, pkgs, declares, sig: h.digest("hex") };
}

/**
 * 可能用路径字面量提到别的文件的那些：清单、页面、构建配置、文档。
 * 不看图片与压缩包 —— 名字在二进制里出现不算证据。
 */
const DECLARES_EXT = /\.(json|html?|astro|vue|svelte|ya?ml|toml|md|mdx|txt|cfg|ini|mk|sh|ps1|bat|cmd)$/i;
const BIG_EXT = /\.(min\.js|map|lock)$/i;


/**
 * 「按约定加载」的文件：没有任何 import 边，但文件名在别的文件正文里作为字面量出现过。
 *
 * 真实仓库里至少有三类这样的东西，静态图上一条边都没有：
 *   - package.json 的 scripts 按路径调用的脚本：`node scripts/run-tests.mjs`
 *   - 页面里的 `<script src="viewer/export.js">`
 *   - 模板串拼出来的路径：`path.join(root, 'renderers', type, \`render-${type}.mjs\`)`
 *
 * 三者共有一个可机械检查的特征：**文件名出现在某个文件的正文里**。所以这里不猜目录名、
 * 不猜框架、不看 import 语句，只查这一件事。
 *
 * 查不到的不算 —— 宁可留下一个可疑的，也不要把真的孤立说成「用过」。
 * 名字太短的不算：`index.js`、`a.js` 这种命中率太高，当证据会盖住真的孤立。
 */

/**
 * 把一段正文里所有「像文件名」的 token 抽出来，记下各自出现的次数。
 *
 * 为什么需要它：原来是「对每个候选文件，在整段正文里搜一遍它的名字」——
 * 候选几百个、正文几 MB，一个 commit 就退化成几百次全文扫描。
 * 在 vue 上实测：526 个候选 × 5.6 MB ≈ 2 秒/commit，这是整条流水线真正的大头
 * （一次 git ls-tree 只要 39 ms）。
 *
 * 现在改成一次扫描建索引，之后每个候选 O(1) 查表。
 */
/**
 * 一个文件贡献了哪些文件名计数。增量维护用的最小单位。
 */
function mentionsOf(text: string): { names: Map<string, number>; stems: Map<string, number>; shapes: Set<string> } {
  const names = new Map<string, number>();
  const stems = new Map<string, number>();
  const shapes = new Set<string>();
  for (const piece of text.split(/[^A-Za-z0-9_@./-]+/)) {
    let token = piece;
    while (token.length > 0 && ".-/".includes(token[token.length - 1]!)) token = token.slice(0, -1);
    while (token.length > 0 && ".-/@".includes(token[0]!)) token = token.slice(1);
    if (token.length < 5) continue;
    if (token.includes(".")) {
      names.set(token, (names.get(token) ?? 0) + 1);
      const base = token.slice(token.lastIndexOf("/") + 1);
      if (base !== token) names.set(base, (names.get(base) ?? 0) + 1);
      continue;
    }
    // 没有扩展名、但带路径分隔符的，是「路径形态的字符串」：
    //   `${location.origin}/src/vue-dev-proxy`
    // 这种引用是 dev server 按路径加载，引用图上没有边。记下它的文件名部分，
    // 让同名文件（vue-dev-proxy.ts）不至于被判成没人用。
    const slash = token.lastIndexOf("/");
    if (slash < 0) continue;
    const stem = token.slice(slash + 1);
    if (stem.length >= 5) stems.set(stem, (stems.get(stem) ?? 0) + 1);
  }
  // 文件名是拼出来的：
  //   path.join(skillRoot, 'renderers', type, `render-${type}.mjs`)
  // 这种加载方式在引用图上不会留下边，但文件名确实被用到了。
  // 只认「模板字符串里含插值、并且以扩展名结尾」的那一种，把插值当通配。
  for (const m of text.matchAll(/`([^`\n]{1,120})`/g)) {
    const body = m[1]!;
    if (!body.includes("${")) continue;
    const cut = body.lastIndexOf("/");
    const name = cut < 0 ? body : body.slice(cut + 1);
    if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) continue;
    const shape = name.replace(/\${[^}]*}/g, "\u0000");
    if (shape.length < 4) continue;
    shapes.add(shape);
  }
  return { names, stems, shapes };
}

/** 文件名是不是符合「拼出来」的形状：\u0000 是通配 */
function matchesShape(shape: string, base: string): boolean {
  const parts = shape.split("\u0000");
  if (parts.length === 1) return false;
  let at = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === "") continue;
    const found = base.indexOf(part, at);
    if (found < 0) return false;
    if (i === 0 && found !== 0) return false;
    at = found + part.length;
  }
  const tail = parts[parts.length - 1]!;
  return tail === "" || base.endsWith(tail);
}

/** 跨 commit 维护的文件名计数表。只处理变动的文件，不重扫全仓。 */
class MentionTable {
  private names = new Map<string, number>();
  private stems = new Map<string, number>();
  /** 拼出来的文件名形状，跨文件去重后按持有者计数 */
  private shapes = new Map<string, number>();
  private byFile = new Map<string, { oid: string; counts: Map<string, number>; stems: Map<string, number>; shapes: Set<string> }>();

  /** 把这一轮的 (文件 → 正文, blob 号) 同步进来，只动变了的 */
  sync(texts: ReadonlyMap<string, string>, oids: ReadonlyMap<string, string>): void {
    for (const f of [...this.byFile.keys()]) {
      if (!texts.has(f)) {
        const prev = this.byFile.get(f)!;
        for (const [tok, n] of prev.counts) this.bump(this.names, tok, -n);
        for (const [tok, n] of prev.stems) this.bump(this.stems, tok, -n);
        for (const s of prev.shapes) this.bump(this.shapes, s, -1);
        this.byFile.delete(f);
      }
    }
    for (const [f, text] of texts) {
      const oid = oids.get(f) ?? "";
      const prev = this.byFile.get(f);
      if (prev && prev.oid === oid) continue;
      if (prev) {
        for (const [tok, n] of prev.counts) this.bump(this.names, tok, -n);
        for (const [tok, n] of prev.stems) this.bump(this.stems, tok, -n);
        for (const s of prev.shapes) this.bump(this.shapes, s, -1);
      }
      const fresh = mentionsOf(text);
      for (const [tok, n] of fresh.names) this.bump(this.names, tok, n);
      for (const [tok, n] of fresh.stems) this.bump(this.stems, tok, n);
      for (const s of fresh.shapes) this.bump(this.shapes, s, 1);
      this.byFile.set(f, { oid, counts: fresh.names, stems: fresh.stems, shapes: fresh.shapes });
    }
  }

  private bump(m: Map<string, number>, tok: string, n: number): void {
    const next = (m.get(tok) ?? 0) + n;
    if (next === 0) m.delete(tok);
    else m.set(tok, next);
  }

  /** 这个文件名（带扩展名）在整段正文里出现几次 */
  all(base: string): number {
    return this.names.get(base) ?? 0;
  }

  /** 去掉扩展名之后的名字，被当作路径片段出现过几次 */
  stemAll(stem: string): number {
    return this.stems.get(stem) ?? 0;
  }

  /** 有没有哪个文件名是拼出来的，而且拼出来的形状和它吻合 */
  shapeAll(base: string): boolean {
    for (const s of this.shapes.keys()) if (matchesShape(s, base)) return true;
    return false;
  }

  /** 这个名字在它自己文件里出现几次 */
  own(file: string, base: string): number {
    return this.byFile.get(file)?.counts.get(base) ?? 0;
  }
}



function conventionRefs(
  snap: { files: ReadonlyMap<string, string>; code: readonly string[]; declares: readonly string[] },
  edges: readonly (readonly [string, string])[],
  mentions: MentionTable,
): string[] {
  const incomingBy = new Map<string, string[]>();
  for (const [s, t] of edges) {
    const arr = incomingBy.get(t);
    if (arr) arr.push(s);
    else incomingBy.set(t, [s]);
  }

  // 要看两类文件：一条边都没有的，和只有测试文件引用的。
  // 后一类如果没有别的证据，会被判成「只有测试引用它，生产代码没用」——
  // 但按路径调用的脚本、页面引用的资产本来就不会有生产代码的边。
  const candidates = snap.code.filter((f) => {
    if (isTestFile(f)) return false;
    const srcs = incomingBy.get(f) ?? [];
    return srcs.length === 0 || srcs.every(isTestFile);
  });
  if (candidates.length === 0) return [];

  // 计数表是跨 commit 增量维护的，这里只查，不扫正文。
  const out: string[] = [];
  for (const f of candidates) {
    const base = f.slice(f.lastIndexOf("/") + 1);
    if (base.length < 5) continue;
    // 两条证据都算：完整文件名出现，或者「去掉扩展名的名字」被当成路径片段用过
    // （`${location.origin}/src/vue-dev-proxy` 这种）。后者是 dev server 按路径加载，
    // 引用图上永远不会有边。代价和这一档其他规则一样：只能证明有人提过这个名字。
    const stem = base.replace(/\.[^.]+$/, "");
    const total = mentions.all(base) + (stem !== base ? mentions.stemAll(stem) : 0);
    // 第三种证据：文件名是拼出来的（`render-${type}.mjs`），形状对得上就算。
    // 这一种的代价最大 —— 只要仓库里有一处 `render-${x}.mjs`，
    // 所有 render-*.mjs 都会被当成「有人在用」。宁可漏掉真的孤立。
    const shaped = total === 0 && mentions.shapeAll(base);
    if (total === 0 && !shaped) continue;
    if (shaped || total > mentions.own(f, base)) out.push(f);
  }
  return out;
}

/* ── 入口点：为什么一个文件没有入边却不是孤立 ──
 *
 * 「没有别的模块 import 它」是个中性的结构事实，不是一个缺陷。真实仓库里至少三类文件
 * 天生就没有入边，而且它们恰恰是仓库里最正常的部分：
 *
 *   1. 演示与工具脚本   examples/*、scripts/*   —— 给人执行的，不是给代码 import 的
 *   2. 文档构建配置     docs/conf.py            —— 给 Sphinx 加载的
 *   3. 库的公开模块     src/click/testing.py    —— 给**使用者** import 的，库自己不用
 *
 * 第三类最容易读反：在库里，一个模块没有内部引用，常常意味着「这是出口，不是入口」。
 *
 * 所以这里不猜，只认仓库里明写的声明。一条都对不上的，才留在孤立里。
 *
 * 每一条都是可核对的：目录名、__init__.py 在不在、清单里有没有写、文件开头是不是 #!。
 * 没有一条依赖「这个文件名看起来像什么」。
 */
export interface EntryPoint {
  file: string;
  /** 为什么说它是入口。这句话会原样出现在报告里，要能被人核对 */
  why: string;
}

/** 演示、工具、文档这类目录下的文件，用途是被人执行或被工具加载，不是被 import */
export const ENTRY_DIR =
  /^(?:examples?|samples?|demos?|docs?|contrib|docs-src|scripts?|bin|tools?|hack|benchmarks?)\//;
/** 这些目录出现在任何层级都算「示例」，不只根目录 —— Rust 的 crates/x/examples/ 是惯例 */
export const ENTRY_DIR_ANY =
  /(?:^|\/)(?:examples?|samples?|demos?|benchmarks?)\//;

/**
 * 被工具**按文件名**加载的东西。它们从不被应用代码 import，但每一个都是活的。
 *
 * 这三类是在 vue 上补的：170 条孤立降到 31 条之后，剩下的全是它们 ——
 *   vitest.config.ts / eslint.config.js / vite.config.ts   工具按约定找配置
 *   __benchmarks__/*.bench.ts                              vitest bench 按后缀找
 *   dts-test/*.test-d.ts                                   由 tsc 直接做类型检查
 *
 * 判据是后缀和目录名，不是「猜」。工具确实就是这么找它们的。
 */
const TOOL_LOADED = /(?:^|\/)(?:[\w.-]+\.config\.[cm]?[jt]s|[^/]+\.bench\.[cm]?[jt]s|[^/]+\.test-d\.tsx?|[^/]+\.d\.ts)$/;
const BENCH_DIR = /(?:^|\/)(?:__benchmarks__|benchmarks?|bench)\//;

/** 从清单里取出声明为入口的路径。认不出返回空数组，不抛错 */
function manifestEntries(file: string, text: string): string[] {
  const out: string[] = [];
  const base = file.slice(file.lastIndexOf("/") + 1);

  if (base === "package.json") {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const bin = j["bin"];
      if (typeof bin === "string") out.push(bin);
      else if (bin && typeof bin === "object") for (const v of Object.values(bin)) if (typeof v === "string") out.push(v);
      if (typeof j["main"] === "string") out.push(j["main"]);
    } catch {
      // 清单坏了就不当证据
    }
    return out;
  }

  if (base === "pyproject.toml" || base === "setup.cfg") {
    // [project.scripts] / [options.entry_points] 下面的 name = "module:func"
    // module 部分转成路径，别的语法一律忽略
    for (const m of text.matchAll(/=\s*["']([A-Za-z_][\w.]*)\s*:/g)) out.push(m[1]!.replace(/\./g, "/"));
    return out;
  }

  if (base === "Cargo.toml") {
    for (const m of text.matchAll(/^\s*path\s*=\s*["']([^"']+\.rs)["']/gm)) out.push(m[1]!);
    return out;
  }
  return out;
}

/**
 * 找出有入口证据的文件。返回值是 file -> 理由。
 *
 * 顺序有意这样排：先说更硬的理由。目录角色和包归属是结构性的，清单是显式声明，
 * 被文档点名是最弱的一条 —— 它只证明有人提过这个名字。
 */
function entryPoints(
  snap: { files: ReadonlyMap<string, string>; code: readonly string[]; declares: readonly string[]; pkgs: readonly string[] },
  info: ReadonlyMap<string, BlobInfo>,
  declaresText: ReadonlyMap<string, string>,
  docMentions: MentionTable,
): Map<string, string> {
  const out = new Map<string, string>();

  // 哪些目录是 Python 包（含 __init__.py）。包内模块对使用者是公开的
  const pkgDirs = new Set<string>();
  for (const f of snap.files.keys()) {
    if (f === "__init__.py") pkgDirs.add("");
    else if (f.endsWith("/__init__.py")) pkgDirs.add(f.slice(0, f.lastIndexOf("/")));
  }

  // 清单里声明为入口的路径（去掉前导 ./）
  const declared = new Set<string>();
  for (const f of snap.pkgs) {
    const t = declaresText.get(snap.files.get(f) ?? "");
    if (t) for (const p of manifestEntries(f, t)) declared.add(p.replace(/^\.\//, "").replace(/\/+$/, ""));
  }
  for (const f of snap.declares) {
    const base = f.slice(f.lastIndexOf("/") + 1);
    if (base !== "pyproject.toml" && base !== "setup.cfg" && base !== "Cargo.toml") continue;
    const t = declaresText.get(snap.files.get(f) ?? "");
    if (t) for (const p of manifestEntries(f, t)) declared.add(p.replace(/^\.\//, "").replace(/\/+$/, ""));
  }

  // 被文档点名的：所有文档正文拼起来查文件名，和按约定加载用的是同一份材料
  const hay: string[] = [];
  for (const f of snap.declares) {
    const t = declaresText.get(snap.files.get(f) ?? "");
    if (t) hay.push(t);
  }

  for (const f of snap.code) {
    if (TOOL_LOADED.test(f)) {
      out.set(f, "工具按文件名加载它（配置 / 基准 / 类型测试），应用代码不会 import");
      continue;
    }
    if (BENCH_DIR.test(f)) {
      out.set(f, "在基准测试目录下，由测试工具按后缀收集");
      continue;
    }
    if (ENTRY_DIR.test(f) || ENTRY_DIR_ANY.test(f)) {
      out.set(f, `在 ${f.split("/")[0]}/ 下：演示、工具或文档目录，用途是被执行或被加载`);
      continue;
    }
    const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
    if (pkgDirs.has(dir) || [...pkgDirs].some((d) => d !== "" && dir.startsWith(`${d}/`))) {
      out.set(f, "属于 Python 包内的模块，使用者可以直接 import，库自己不引用是正常的");
      continue;
    }
    // 清单里写的可能是目录（入口是个包），也可能是文件
    if ([...declared].some((p) => p !== "" && (f === p || f.startsWith(`${p}/`)))) {
      out.set(f, "在清单里被声明为入口");
      continue;
    }
    const body = info.get(snap.files.get(f) ?? "")?.text ?? "";
    if (/^#!/.test(body)) {
      out.set(f, "文件开头是 #!，是被直接执行的");
      continue;
    }
    const base = f.slice(f.lastIndexOf("/") + 1);
    if (base.length >= 5 && docMentions.all(base) > 0) {
      out.set(f, "被文档或配置按文件名点名");
    }
  }
  return out;
}

export interface CommitScan {
  /** 该 commit 上的代码文件与它们之间的引用。代码没变的相邻 commit 共用同一个对象 */
  graph: CommitGraph;
  /**
   * 解析不了、又不像第三方包的引用：[引用方, 引用字符串]。多半是 @/x、src/x 这样的别名路径，
   * 它们可能指向仓库里的某处，但图上没有这条边。判定边界时要把它们当作「不确定」。
   */
  unresolved: readonly (readonly [string, string])[];
  /** 该 commit 上的全部文件（文件 → blob 号），每个 commit 都是新的 */
  all: ReadonlyMap<string, string>;
  /** 空壳、契约与注入线索。代码没变的相邻 commit 共用同一个对象 */
  layer: CommitLayer;
}

interface BlobInfo {
  raw: RawImport[];
  bare: string[];
  layer: FileLayer;
  /** 正文。用来查「这个文件名有没有被别的文件按字面量提到」 */
  text: string;
}

export class ImportScanner {
  private reader = new BlobReader();
  /** blob 号 → 它里面的引用（只取决于正文，跨 commit 复用） */
  private walker = new TreeWalker();
  private infoByBlob = new Map<string, BlobInfo>();
  /** 代码 + 声明的合并计数表（按约定加载用） */
  private mentions = new MentionTable();
  /** 只算声明（文档、配置）的计数表（入口点用） */
  private docMentions = new MentionTable();
  /** package.json 的 blob 号 → 正文 */
  private pkgByBlob = new Map<string, string | null>();
  /** 配置、清单、页面与文档的 blob 号 → 正文。用来查「按名字提到」，不是 import 边 */
  private declaresText = new Map<string, string>();
  private prevSig = "";
  private prev: { graph: CommitGraph; unresolved: readonly (readonly [string, string])[]; layer: CommitLayer } = {
    graph: { files: [], edges: [] },
    unresolved: [],
    layer: EMPTY_COMMIT_LAYER,
  };

  /** 有多少个 commit 的代码有变化、一共读了多少个文件正文（给终端摘要用） */
  scanned = 0;
  blobsRead = 0;

  async scan(sha: string): Promise<CommitScan> {
    const snap = snapshot(this.walker.filesAt(sha));
    if (snap.sig !== this.prevSig) {
      this.prevSig = snap.sig;
      this.scanned++;
      const analyzed = snap.code.length === 0 ? { graph: { files: [], edges: [] }, unresolved: [] as [string, string][], layer: { ...EMPTY_COMMIT_LAYER } } : await this.analyze(snap);
      analyzed.layer.unsupported = snap.unsupported;
      this.prev = analyzed;
    }
    return { graph: this.prev.graph, unresolved: this.prev.unresolved, layer: this.prev.layer, all: snap.files };
  }

  private async analyze(snap: ReturnType<typeof snapshot>): Promise<{ graph: CommitGraph; unresolved: [string, string][]; layer: CommitLayer }> {
    const needCode = [...new Set(snap.code.map((f) => snap.files.get(f)!))].filter((o) => !this.infoByBlob.has(o));
    const needPkg = [...new Set(snap.pkgs.map((f) => snap.files.get(f)!))].filter((o) => !this.pkgByBlob.has(o));
    const needDecl = [...new Set(snap.declares.map((f) => snap.files.get(f)!))].filter((o) => !this.declaresText.has(o));
    const texts = await this.reader.read([...new Set([...needCode, ...needPkg, ...needDecl])]);
    this.blobsRead += texts.size;
    for (const o of needDecl) this.declaresText.set(o, texts.get(o) ?? "");
    const kindOf = new Map<string, string>(); // 同一个 blob 号按它的文件扩展名选解析方式
    for (const f of snap.code) kindOf.set(snap.files.get(f)!, f);
    for (const o of needCode) {
      const file = kindOf.get(o)!;
      const text = texts.get(o) ?? "";
      // 单文件组件只解析 <script> 块：模板是 HTML，当 JS 解析会把属性当成代码。
      // 正文本身仍然保留原文 —— 模板里的组件标签也算「提到了这个文件」。
      const from = /\.(?:vue|svelte)$/i.test(file) ? sfcScript(text) : /\.astro$/i.test(file) ? astroFrontmatter(text) : text;
      this.infoByBlob.set(o, { raw: parseFileImports(file, from), bare: parseBareSpecs(file, from), layer: scanFileLayer(from), text });
    }
    for (const o of needPkg) this.pkgByBlob.set(o, texts.get(o) ?? null);

    const env: ResolveEnv = { files: new Set(snap.files.keys()), read: (f) => this.pkgByBlob.get(snap.files.get(f) ?? "") ?? null };
    const pk = indexPackages(snap.pkgs.map((file) => ({ file, body: this.pkgByBlob.get(snap.files.get(file)!) ?? null })));

    const edges: [string, string][] = [];
    const unresolved: [string, string][] = [];
    const layer: CommitLayer = { stubs: [], facts: [], declares: [], references: [], clues: [], hollowFns: [], delegates: [] };
    const pieces: Parameters<typeof mountRoutes>[0][number][] = [];
    for (const f of snap.code) {
      const info = this.infoByBlob.get(snap.files.get(f)!);
      if (!info) continue;
      pieces.push({
        file: f,
        imports: info.layer.imports,
        routers: info.layer.routers,
        mounts: info.layer.mounts,
        declares: info.layer.declares,
      });
      // 同一 blob 号、不同扩展名（py 与 js 同内容）几乎不会发生；真发生了解析会得到空而不是错
      const targets = new Set(resolveRaw(f, info.raw, env));
      const bare = resolveBareSpecs(info.bare, pk, env);
      for (const t of bare.targets) if (t !== f) targets.add(t);
      for (const t of targets) edges.push([f, t]);
      for (const spec of bare.unknown) unresolved.push([f, spec]);
      if (info.layer.stub) layer.stubs.push(f);
      layer.facts.push({
        file: f,
        depth: info.layer.depth,
        trivialFns: info.layer.trivialFns,
        reexports: info.layer.reexports,
        forwardTo: info.layer.forwardTo,
        imports: info.layer.imports,
      });
      for (const r of info.layer.references) layer.references.push({ ...r, file: f });
      for (const kind of info.layer.clues) layer.clues.push({ kind, file: f });
      // arrow 要一起带过去：下游靠它判断「这条要不要进需要复核的清单」。
    for (const h of info.layer.hollowFns)
      layer.hollowFns!.push({ file: f, name: h.name, line: h.line, reason: h.reason, ...(h.arrow ? { arrow: true } : {}) });
      for (const d of info.layer.delegates) layer.delegates!.push({ file: f, ...d });
    }
    layer.declares = mountRoutes(pieces, (from, spec, imported) => resolvePython(from, { spec, names: [imported] }, env)).map((d) => ({
      kind: "route",
      name: d.name,
      file: d.file,
      handler: d.handler,
      ...(d.via ? { via: d.via } : {}),
      ...(d.imported ? { imported: d.imported } : {}),
    }));
    // 两张表都增量维护：只处理这一轮变了的文件，不重扫全仓。
    // 这是 profile 推出来的：每个 commit 重扫 5.6 MB 正文占了三分之一的时间，
    // 而相邻 commit 之间 99% 的正文是一样的。
    const combined = new Map<string, string>();
    const combinedOid = new Map<string, string>();
    for (const f of snap.code) {
      const oid = snap.files.get(f);
      const text = oid === undefined ? undefined : this.infoByBlob.get(oid)?.text;
      if (text !== undefined) {
        combined.set(f, text);
        combinedOid.set(f, oid!);
      }
    }
    for (const f of snap.declares) {
      const oid = snap.files.get(f);
      const text = oid === undefined ? undefined : this.declaresText.get(oid);
      if (text !== undefined) {
        combined.set(f, text);
        combinedOid.set(f, oid!);
      }
    }
    this.mentions.sync(combined, combinedOid);

    const docsOnly = new Map<string, string>();
    const docsOnlyOid = new Map<string, string>();
    for (const f of snap.declares) {
      const oid = snap.files.get(f);
      const text = oid === undefined ? undefined : this.declaresText.get(oid);
      if (text !== undefined) {
        docsOnly.set(f, text);
        docsOnlyOid.set(f, oid!);
      }
    }
    this.docMentions.sync(docsOnly, docsOnlyOid);

    layer.convention = conventionRefs(snap, edges, this.mentions);
    // 入口点：有明写证据的，不算孤立。理由一并带上，报告里要能被人核对
    layer.entry = [...entryPoints(snap, this.infoByBlob, this.declaresText, this.docMentions)].map(([file, why]) => ({ file, why }));
    return { graph: { files: snap.code, edges }, unresolved, layer };
  }

  close(): void {
    this.reader.close();
  }
}
