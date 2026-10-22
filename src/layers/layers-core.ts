/**
 * laminae —— 层与层之间的对账（纯函数，不碰 git）
 *
 * 成立的结论分三档，都不是「真的实现了」：
 *   - 假实现：指着的文件结构上是空的（空文件、写着没实现、函数只返回空值）。认不出算错了
 *   - 被盖住：纯转发、只有测试引用、下限或上限措辞盖住差额、别名或处理函数看不清
 *   - 有实质代码：排除了前两档，不表示这段代码做了说法里的事
 * 孤立模块：没被引用、不是入口或测试、也没被任何说法或想法提到。
 *
 * 交互不预设项目有前端或后端。仓库里「声明的东西」和「引用的东西」按契约种类配对
 * （目前是 HTTP 路径这一种）：
 *   - 缺任何一侧都是正常的项目形态（纯库、纯前端、纯后端），记为「这一侧不存在」，不算洞
 *   - 只有两侧都存在、而某处引用了一个没人声明的名字，才算对不上
 * 库项目没有路由，靠「入口」和「孤立模块」覆盖，不需要有前端或后端。
 *
 * 注入线索（eval、innerHTML 等）只是线索，标出危险调用点在哪，不判断能不能被利用。
 */
import { isTestFile, resolveJs } from "./imports.ts";
import type { ResolveEnv } from "./imports.ts";
import { codeLines, isNonCodeLine, normRoute } from "./syntax.ts";
import type { Binding, FnReason, HandlerKind, PyMount, PyRouter, RouteDecl } from "./syntax.ts";
import { MODULES, allBindings, allMounts, allRouters, allRoutes, pickModule } from "./syntax-registry.ts";
import { ENTRY_DIR } from "./scan.ts";
import type { Interval } from "../core/types.ts";

/**
 * 一个文件看起来做了多少。这不是「真的实现了」的判断。
 *   empty          去掉注释后没有代码
 *   unimplemented  写着 not implemented / 未实现
 *   placeholder    函数都是空的，或只 return null / [] / {}
 *   forward        只把名字转到别的文件
 *   substantive    有实质代码。只能说明不是上面四种，不能说明它做了文档里的那件事
 */
export const DEPTHS = ["empty", "unimplemented", "placeholder", "forward", "substantive"] as const;
export type Depth = (typeof DEPTHS)[number];

const UNIMPLEMENTED = /not implemented|NotImplementedError|未实现|unimplemented!\(|todo!\(/i;

/** 这个文件看上去是哪种。有实质代码只表示「不是空的、不是纯转发」，不表示真的实现了 */
export function classifyDepth(text: string): Depth {
  // 只在整份文件没有别的实现时，才把「没实现」当成这文件的结论。
  // 一个几百行的模块里有一个抽象方法 raise NotImplementedError，不能把整个文件判成假实现。
  if (UNIMPLEMENTED.test(text)) {
    const stripped = text.replace(/not implemented|NotImplementedError|未实现|unimplemented!\(|todo!\(/gi, "");
    const rest = classifyDepth(stripped);
    const leftover = codeLines(stripped).filter((l) => !/^(?:throw|raise)\b/.test(l) && !/^export\b/.test(l));
    if (rest === "empty" || rest === "placeholder" || leftover.length === 0) return "unimplemented";
    return rest === "forward" ? "forward" : "substantive";
  }
  const lines = codeLines(text);
  if (lines.length === 0) return "empty";
  // 纯转发是整份文件的形状，不依赖于认出哪门语言，所以两个模块都问一遍。
  // 原来就是「JS 的纯转发成立，或者 Python 的纯转发成立」。
  if (MODULES.some((m) => m.isPureForward(lines, text))) return "forward";

  // 从这里往下才需要知道是哪门语言，取一次模块，后面都调它
  const mod = pickModule(text);
  const fns = mod.findFunctions(text);
  if (fns.length === 0 || fns.some((f) => !f.reason)) return "substantive";
  let rest = text;
  for (const f of [...fns].sort((a, b) => b.start - a.start)) rest = rest.slice(0, f.start) + rest.slice(f.end);
  const left = codeLines(rest).filter((l) => !isNonCodeLine(l));
  return left.length === 0 ? "placeholder" : "substantive";
}

const REASON_TEXT: Record<FnReason, string> = {
  empty: "函数体是空的",
  "return-const": "只返回空值或数字",
  unimplemented: "这个函数写着没实现",
  "calls-empty": "只去调用同一个文件里的空函数",
  "calls-other": "只去调用别的文件里有问题的函数",
};

/** 具名函数里，往下看一层有问题的那些。行号是函数定义那一行。不把整个文件算进去 */
/** 函数体只有一句对别的名字的调用，而且那个名字不是本文件里已经有问题的函数。跨文件要靠 import 再追 */
/**
 * 函数体里调用了本文件之外的哪些名字。
 *
 * 原来只认「函数体只有一句调用」—— 真实代码里只要多一个 if、await 或第二句，
 * 整条链就断了。现在扫函数体里任意位置的调用点，用 strict 标出是不是原来那种单句委托。
 *
 * 仍然只记名字，不记参数、不记返回值。名字重复的合并成一条。
 */
export function delegatedCalls(text: string): { name: string; line: number; callee: string; strict: boolean; local: boolean }[] {
  const fns = pickModule(text).findFunctions(text);
  if (fns.length === 0) return [];
  const localHollow = new Set(fns.filter((f) => f.reason && f.name).map((f) => f.name!));
  const localAny = new Set(fns.flatMap((f) => (f.name ? [f.name] : [])));
  // 这些不是函数调用
  const KEYWORDS = new Set([
    "if", "for", "while", "switch", "catch", "return", "typeof", "function", "await", "new",
    "super", "this", "delete", "void", "in", "of", "do", "else", "try", "throw", "yield", "case",
    "def", "elif", "except", "with", "assert", "lambda", "not", "and", "or", "is", "print",
  ]);
  const out: { name: string; line: number; callee: string; strict: boolean; local: boolean }[] = [];
  for (const f of fns) {
    if (!f.name) continue;
    // 结构上就空的（空、写着没实现、只返回常量）不用从这里追，它们自己就是链的底。
    // 但 calls-empty 不一样：它表示「这个函数只调用了同文件里的空实现」，
    // 那正是要接着往上走的一层 —— 跳过它，链就断在它这里。
    if (f.reason !== null && f.reason !== "calls-empty") continue;
    const chunk = text.slice(f.start, f.end);
    const body = chunk.includes("{") ? (/\{([\s\S]*)\}/.exec(chunk)?.[1] ?? "") : chunk.split("\n").slice(1).join("\n");
    const trimmed = body.trim();
    const single = /^\s*(?:return\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*;?\s*$/.exec(trimmed);
    const strict = single !== null && !localHollow.has(single[1]!);
    const seen = new Set<string>();
    for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      const callee = m[1]!;
      if (KEYWORDS.has(callee)) continue;
      // 文件内的调用也收，用 local 标出来。原来这里直接丢掉，于是「调用路径」只覆盖
      // 跨文件那一半，而真实的链常常是文件内几跳之后才跨出去。
      if (seen.has(callee)) continue;
      seen.add(callee);
      out.push({ name: f.name, line: text.slice(0, f.start).split("\n").length, callee, strict: strict && single?.[1] === callee, local: localAny.has(callee) });
    }
  }
  return out;
}

export function hollowFunctions(text: string): { name: string; line: number; reason: FnReason }[] {
  const fns = pickModule(text).findFunctions(text);
  return fns.flatMap((f) =>
    f.name && f.reason ? [{ name: f.name, line: text.slice(0, f.start).split("\n").length, reason: f.reason }] : [],
  );
}

export { REASON_TEXT };

/** 空壳：空文件，或写着没实现。空函数和纯转发不算在这里，它们有自己的分类 */
export function isStub(text: string): boolean {
  const d = classifyDepth(text);
  return d === "empty" || d === "unimplemented";
}

const ENTRY_NAME = /^(index|main|cli|app|server|mod|__init__|__main__|setup)$/;

/** 入口天然不会被别的文件引用：主文件、目录的 index、bin 与 cmd 下的命令 */
export function isEntryPoint(file: string): boolean {
  const base = file.slice(file.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  if (ENTRY_NAME.test(base)) return true;
  const segs = file.split("/");
  return segs.includes("bin") || segs.includes("cmd");
}

/* ── 从单个文件里提取：空壳、契约、注入线索 ── */

export interface FileLayer {
  stub: boolean;
  depth: Depth;
  /** 函数体是空的那些具名函数 */
  trivialFns: string[];
  hollowFns: { name: string; line: number; reason: FnReason }[];
  /** 本文件的 import，用来把函数调用追到别的文件 */
  imports: Binding[];
  /** 函数体只有一句调用，被调的名字不在本文件的问题函数里 */
  delegates: { name: string; line: number; callee: string }[];
  /** depth 为 forward 时，转到哪些模块 */
  forwardTo: string[];
  reexports: Binding[];
  declares: ({ kind: string; name: string } & Pick<RouteDecl, "handler" | "via" | "imported" | "router">)[];
  references: { kind: string; name: string }[];
  clues: string[];
  /** 本文件里的 APIRouter / FastAPI。装饰器路径还没拼上这些前缀 */
  routers: PyRouter[];
  /** include_router。跨文件的前缀在 mountRoutes 里拼 */
  mounts: PyMount[];
}

const ROUTE_REF_FETCH = /\bfetch\s*\(\s*(['"`])(\/[^\s'"`]{0,119})\1/g;
const ROUTE_REF_AXIOS = /\baxios\s*\.\s*(?:get|post|put|delete|patch)\s*\(\s*(['"`])(\/[^\s'"`]{0,119})\1/g;


function joinRoute(prefix: string, path: string): string {
  const head = normRoute(prefix);
  const tail = normRoute(path);
  if (!head) return tail;
  if (!tail || tail === "/") return head;
  return normRoute(`${head}${tail.startsWith("/") ? tail : `/${tail}`}`);
}

export interface MountedRoute {
  file: string;
  name: string;
  handler: HandlerKind;
  via?: string;
  imported?: string;
}

/**
 * 把 APIRouter(prefix=) 和 include_router(..., prefix=) 拼到装饰器路径上。
 * 装饰器上的 name 还是原文那一段。没挂到任何 include 上的路由，只用它自己的 prefix。
 * 嵌套 include（A 挂 B、B 挂 C）顺着挂载链往上拼，最多 6 层。
 * resolve 把 `from x import name` 解到文件；解不开的挂载跳过，那条路由仍用自己的 prefix。
 */
export function mountRoutes(
  files: readonly {
    file: string;
    imports: readonly Binding[];
    routers: readonly PyRouter[];
    mounts: readonly PyMount[];
    declares: readonly Pick<RouteDecl, "name" | "handler" | "via" | "imported" | "router">[];
  }[],
  resolve: (from: string, spec: string, imported: string) => readonly string[],
): MountedRoute[] {
  interface Node {
    id: string;
    file: string;
    own: string;
    routes: Pick<RouteDecl, "name" | "handler" | "via" | "imported">[];
  }
  const nodes = new Map<string, Node>();
  const node = (file: string, local: string, own?: string): Node => {
    const id = `${file}\0${local}`;
    let n = nodes.get(id);
    if (!n) {
      n = { id, file, own: own ?? "", routes: [] };
      nodes.set(id, n);
    } else if (own) n.own = own;
    return n;
  };

  const plain: MountedRoute[] = [];
  for (const f of files) {
    for (const r of f.routers) node(f.file, r.local, r.prefix);
    for (const d of f.declares) {
      if (!d.router) {
        plain.push({ file: f.file, name: d.name, handler: d.handler ?? "substantive", via: d.via, imported: d.imported });
        continue;
      }
      node(f.file, d.router).routes.push(d);
    }
  }

  const edges: { parent: string; child: string; prefix: string }[] = [];
  for (const f of files) {
    for (const m of f.mounts) {
      let childFile = f.file;
      let childLocal = m.local;
      if (m.attr) {
        const imp = f.imports.find((b) => b.local === m.local);
        if (!imp) continue;
        const hits = resolve(f.file, imp.spec, imp.imported);
        const sub = hits.find((h) => h.endsWith(`/${imp.imported}.py`) || h.endsWith(`/${imp.imported}/__init__.py`));
        const hit = sub ?? hits[0];
        if (!hit) continue;
        childFile = hit;
        childLocal = m.attr;
      } else if (!f.routers.some((r) => r.local === m.local)) {
        const imp = f.imports.find((b) => b.local === m.local);
        if (!imp) continue;
        const hits = resolve(f.file, imp.spec, imp.imported);
        const hit = hits.find((h) => nodes.has(`${h}\0${imp.imported}`)) ?? hits[0];
        if (!hit) continue;
        childFile = hit;
        childLocal = imp.imported;
      }
      edges.push({ parent: node(f.file, m.parent).id, child: node(childFile, childLocal).id, prefix: m.prefix });
    }
  }

  const prefixesOf = (id: string, seen: Set<string>): string[] => {
    if (seen.has(id) || seen.size > 6) return [];
    const n = nodes.get(id);
    if (!n) return [];
    const parents = edges.filter((e) => e.child === id);
    if (parents.length === 0) return [n.own];
    const next = new Set(seen);
    next.add(id);
    const out: string[] = [];
    for (const e of parents) {
      for (const up of prefixesOf(e.parent, next)) out.push(joinRoute(joinRoute(up, e.prefix), n.own));
    }
    return out.length > 0 ? out : [n.own];
  };

  const out = [...plain];
  const seen = new Set(plain.map((d) => `${d.file}\0${d.name}`));
  for (const n of nodes.values()) {
    for (const pref of prefixesOf(n.id, new Set())) {
      for (const route of n.routes) {
        const name = joinRoute(pref, route.name);
        if (name === "") continue;
        const key = `${n.file}\0${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ file: n.file, name, handler: route.handler ?? "substantive", via: route.via, imported: route.imported });
      }
    }
  }
  return out;
}

const CLUE_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["eval", /\beval\s*\(/],
  ["new-function", /\bnew\s+Function\s*\(/],
  ["child-process", /\bchild_process\b/],
  ["innerHTML", /\.innerHTML\b/],
  ["dangerously-set-innerhtml", /\bdangerouslySetInnerHTML\b/],
  ["os-system", /\bos\.system\s*\(/],
  ["subprocess", /\bsubprocess\b/],
  ["document-write", /\bdocument\.write\s*\(/],
];

const EMPTY_LAYER: FileLayer = {
  stub: false,
  depth: "substantive",
  trivialFns: [],
  hollowFns: [],
  imports: [],
  delegates: [],
  forwardTo: [],
  reexports: [],
  declares: [],
  references: [],
  clues: [],
  routers: [],
  mounts: [],
};

/** 扫描一个代码文件。超大文件和二进制不看，返回空结果 */
export function scanFileLayer(text: string): FileLayer {
  if (text.length > 512 * 1024 || text.includes("\u0000")) return EMPTY_LAYER;

  const names = (re: RegExp): string[] => {
    const out = new Set<string>();
    for (const m of text.matchAll(re)) {
      const name = normRoute(m[2] ?? "");
      if (name !== "" && !name.includes("$") && !name.includes("{")) out.add(name);
    }
    return [...out];
  };

  // 取一次模块，整个文件都问它。原来是每处调用点各自猜一遍语言
  const mod = pickModule(text);
  const depth = classifyDepth(text);
  const reexports = allBindings(text, "export");
  const forwardTo =
    depth === "forward"
      ? [...new Set([...reexports.map((r) => r.spec), ...allBindings(text, "import").map((b) => b.spec).filter((s) => s.startsWith("."))])]
      : [];
  return {
    stub: depth === "empty" || depth === "unimplemented",
    depth,
    hollowFns: hollowFunctions(text),
    imports: allBindings(text, "import"),
    delegates: delegatedCalls(text),
    trivialFns: mod.findFunctions(text).flatMap((f) => (f.name && f.reason ? [f.name] : [])),
    forwardTo,
    reexports,
    declares: allRoutes(text).map((r) => ({ kind: "route", ...r })),
    references: [...names(ROUTE_REF_FETCH), ...names(ROUTE_REF_AXIOS)].map((name) => ({ kind: "route", name })),
    clues: CLUE_PATTERNS.filter(([, re]) => re.test(text)).map(([kind]) => kind),
    routers: allRouters(text),
    mounts: allMounts(text),
  };
}

/* ── 逐 commit 汇总成区间 ── */

export interface ContractHit {
  kind: string;
  name: string;
  file: string;
  /** 没写的话不判断处理函数（旧数据，或测试里只关心路径） */
  handler?: HandlerKind;
  via?: string;
  imported?: string;
}

/** 一个代码文件在这个 commit 上的深浅，给「追到别的文件」用 */
export interface FileFact {
  file: string;
  depth: Depth;
  trivialFns: string[];
  reexports: Binding[];
  forwardTo: string[];
  imports?: Binding[];
}
export interface ClueHit {
  kind: string;
  file: string;
}

/** 一个 commit 上的层信息（由 scan.ts 附在扫描结果上） */
export interface CommitLayer {
  stubs: string[];
  facts: FileFact[];
  declares: ContractHit[];
  references: ContractHit[];
  clues: ClueHit[];
  /** 具名函数里往下看一层有问题的，带定义所在行 */
  hollowFns?: { file: string; name: string; line: number; reason: FnReason }[];
  delegates?: { file: string; name: string; line: number; callee: string; local?: boolean }[];
  /** 认得出扩展名、但没有语法模块的文件，如 .java、.go */
  unsupported?: string[];
  /** 没有 import 边，但文件名在别的文件正文里作为字面量出现过（按约定加载）。不算孤立 */
  convention?: string[];
  /** 有入口证据的文件：[文件, 理由]。这些不算孤立 */
  entry?: { file: string; why: string }[];
}

export const EMPTY_COMMIT_LAYER: CommitLayer = { stubs: [], facts: [], declares: [], references: [], clues: [] };

export interface LayerCommit {
  files: readonly string[];
  edges: readonly (readonly [string, string])[];
  layer: CommitLayer;
}

export type ShallowDepth = Exclude<Depth, "substantive">;

export interface LayersData {
  /** 曾经是空壳的文件，和它是空壳的 commit 区间（empty 与 unimplemented） */
  stubs: { file: string; alive: Interval[] }[];
  /** 不是实质代码的文件：空、写着没实现、空函数、纯转发 */
  shallow: { file: string; depth: ShallowDepth; detail: string; alive: Interval[] }[];
  /** 代码文件存在的区间，用来判断「指着的是一段有代码的实现」 */
  present: { file: string; alive: Interval[] }[];
  /** 只有测试文件引用它 */
  testOnly: { file: string; alive: Interval[] }[];
  /** 没被任何代码引用、又不是入口和测试的文件。还没减去「被说法或想法提到」的那些，那一步在 joinLayers */
  unreferenced: { file: string; alive: Interval[] }[];
  /** 没有 import 边，但文件名在别的文件正文里出现过：按约定加载的脚本、页面资产、插件。不算孤立 */
  convention: { file: string; alive: Interval[] }[];
  /** 这一份数据覆盖了多少个提交。判断「现在还成立」要用 */
  commits: number;
  /** 没有引用边、但有入口证据的文件。它们不是孤立，理由就在 why 里 */
  entry: { file: string; why: string; alive: Interval[] }[];
  contracts: ContractKind[];
  clues: { kind: string; file: string; alive: Interval[] }[];
  /** 认得出扩展名、但没有语法模块 */
  unsupported: { file: string; alive: Interval[] }[];
  /** 具名函数：往下看一层有问题。没有说法指向它也会留下 */
  down: { file: string; name: string; line: number; reason: FnReason; via: string; hops: number; alive: Interval[] }[];
}

export interface ContractKind {
  /** 契约种类，目前只有 route（HTTP 路径） */
  kind: string;
  /** 仓库里存在「声明」的 commit 区间。空数组 = 这一侧不存在 */
  declared: Interval[];
  /** 仓库里存在「引用」的 commit 区间。空数组 = 这一侧不存在 */
  referenced: Interval[];
  /**
   * 两侧都存在时，引用了一个没人声明的名字。
   * 只有一侧存在时这里一定是空的：缺一侧是项目形态，不是洞。
   */
  unmet: { name: string; files: string[]; alive: Interval[] }[];
  /** 路径声明了，但处理函数是空的，或者顺着 import 追到的也是空实现 */
  fake: { name: string; file: string; note: string; alive: Interval[] }[];
  /** 路径对上了也没用：处理函数不在声明文件里，而且没有追到本地文件 */
  unresolved: { name: string; file: string; note: string; alive: Interval[] }[];
}

function toIntervals(flags: readonly boolean[]): Interval[] {
  const out: Interval[] = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    const on = i < flags.length && flags[i] === true;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      out.push([start, i - 1]);
      start = -1;
    }
  }
  return out;
}

/** 顺着相对引用最多追两跳。追到空实现算假的，追到有代码的文件就停，追丢了返回 missing */
function resolveRel(from: string, via: string, files: ReadonlySet<string>): string | null {
  if (!via.startsWith(".")) return null;
  const env: ResolveEnv = { files: new Set(files), read: () => null };
  if (via.startsWith("./") || via.startsWith("../")) {
    const js = resolveJs(from, via, env);
    if (js) return js;
  }
  let dots = 0;
  while (via[dots] === ".") dots++;
  const rest = via.slice(dots).replace(/\./g, "/");
  const parts = from.split("/");
  parts.pop();
  for (let i = 1; i < dots; i++) parts.pop();
  const base = [...parts, rest].filter(Boolean).join("/");
  return [`${base}.py`, `${base}/__init__.py`, `${base}.ts`, `${base}.js`].find((c) => files.has(c)) ?? null;
}

function followHandler(from: string, via: string, imported: string, facts: ReadonlyMap<string, FileFact>, files: ReadonlySet<string>, hops: number): "trivial" | "substantive" | "missing" {
  if (hops <= 0) return "missing";
  const target = resolveRel(from, via, files);
  if (!target) return "missing";
  const fact = facts.get(target);
  if (!fact) return "missing";
  if (fact.depth === "empty" || fact.depth === "unimplemented" || fact.depth === "placeholder") return "trivial";
  if (fact.trivialFns.includes(imported)) return "trivial";
  if (fact.depth === "forward") {
    const next = fact.reexports.find((r) => r.local === imported || r.local === "*");
    if (!next) return "trivial";
    return followHandler(target, next.spec, next.local === "*" ? imported : next.imported, facts, files, hops - 1);
  }
  return "substantive";
}

export function buildLayers(commits: readonly LayerCommit[]): LayersData {
  const n = commits.length;
  const flagsOf = (keys: Iterable<string>): Map<string, boolean[]> => {
    const m = new Map<string, boolean[]>();
    for (const k of keys) m.set(k, new Array<boolean>(n).fill(false));
    return m;
  };

  const stubKeys = new Set<string>();
  const unrefKeys = new Set<string>();
  const convKeys = new Set<string>();
  const clueKeys = new Set<string>();
  /** 有入口证据的文件 -> 理由。只留最后一次见到的理由：证据不会随时间变得更弱 */
  const entryWhy = new Map<string, string>();
  commits.forEach((c) => {
    for (const f of c.layer.stubs) stubKeys.add(f);
    for (const f of c.layer.convention ?? []) convKeys.add(f);
    for (const e of c.layer.entry ?? []) entryWhy.set(e.file, e.why);
    for (const f of c.files) if (!isTestFile(f) && !isEntryPoint(f)) unrefKeys.add(f);
    for (const cl of c.layer.clues) clueKeys.add(`${cl.kind}\u0000${cl.file}`);
  });

  const stubFlags = flagsOf(stubKeys);
  const unrefFlags = flagsOf(unrefKeys);
  const convFlags = flagsOf(convKeys);
  const clueFlags = flagsOf(clueKeys);

  const kinds = new Set<string>();
  for (const c of commits) {
    for (const d of c.layer.declares) kinds.add(d.kind);
    for (const r of c.layer.references) kinds.add(r.kind);
  }
  const declaredFlags = new Map([...kinds].map((k) => [k, new Array<boolean>(n).fill(false)]));
  const referencedFlags = new Map([...kinds].map((k) => [k, new Array<boolean>(n).fill(false)]));
  const unmetFlags = new Map<string, boolean[]>();
  const unmetFiles = new Map<string, Set<string>>();
  const shallowFlags = new Map<string, boolean[]>();
  const presentFlags = new Map<string, boolean[]>();
  const testFlags = new Map<string, boolean[]>();
  const fakeFlags = new Map<string, boolean[]>();
  const unsupportedFlags = new Map<string, boolean[]>();
  const downFlags = new Map<string, boolean[]>();
  const downLine = new Map<string, number>();
  const downVia = new Map<string, string>();
  const downHops = new Map<string, number>();
  const fakeNote = new Map<string, string>();
  const mark = (map: Map<string, boolean[]>, key: string, i: number): void => {
    let fl = map.get(key);
    if (!fl) map.set(key, (fl = new Array<boolean>(n).fill(false)));
    fl[i] = true;
  };

  commits.forEach((c, i) => {
    for (const f of c.layer.stubs) {
      const fl = stubFlags.get(f);
      if (fl) fl[i] = true;
    }

    const incoming = new Map<string, string[]>();
    for (const [s, t] of c.edges) {
      const arr = incoming.get(t);
      if (arr) arr.push(s);
      else incoming.set(t, [s]);
    }
    const convNow = new Set(c.layer.convention ?? []);
    for (const f of c.files) {
      mark(presentFlags, f, i);
      if (isTestFile(f) || isEntryPoint(f)) continue;
      // 文件名在别的文件正文里出现过：按约定加载的脚本、页面资产、插件。
      // 没有 import 边不等于没人用，这一档单独记，不算孤立也不算「只有测试引用」
      if (convNow.has(f)) {
        mark(convFlags, f, i);
        continue;
      }
      const srcs = incoming.get(f) ?? [];
      if (srcs.length === 0) {
        const fl = unrefFlags.get(f);
        if (fl) fl[i] = true;
      } else if (srcs.every(isTestFile)) mark(testFlags, f, i);
    }

    const factDepth = new Map((c.layer.facts ?? []).map((f) => [f.file, f]));
    for (const f of c.layer.stubs) if (!factDepth.has(f)) mark(shallowFlags, `${f}\u0000unimplemented\u0000`, i);
    for (const fact of c.layer.facts ?? []) {
      if (fact.depth === "substantive") continue;
      const detail = fact.depth === "forward" ? (fact.forwardTo.length > 0 ? fact.forwardTo : fact.reexports.map((r) => r.spec)).join("、") : "";
      mark(shallowFlags, `${fact.file}\u0000${fact.depth}\u0000${detail}`, i);
    }

    const filesNow = new Set(c.files);
    for (const d of c.layer.declares) {
      if (d.kind !== "route" || d.handler === undefined) continue;
      const key = `route\u0000${d.name}\u0000${d.file}`;
      if (d.handler === "trivial") {
        mark(fakeFlags, key, i);
        fakeNote.set(key, "处理函数是空的，或只返回空值");
      } else if (d.handler === "missing") {
        const followed = d.via && d.imported ? followHandler(d.file, d.via, d.imported, factDepth, filesNow, 2) : "missing";
        if (followed === "trivial") {
          mark(fakeFlags, key, i);
          fakeNote.set(key, `顺着 ${d.via} 追过去，那边也是空实现`);
        } else if (followed === "missing") {
          mark(fakeFlags, `${key}\u0000lost`, i);
          fakeNote.set(`${key}\u0000lost`, "处理函数不在这个文件里，也没有追到本地文件");
        }
      }
    }

    for (const cl of c.layer.clues) {
      const fl = clueFlags.get(`${cl.kind}\u0000${cl.file}`);
      if (fl) fl[i] = true;
    }
    for (const f of c.layer.unsupported ?? []) mark(unsupportedFlags, f, i);
    const hollowAt = new Map<string, Map<string, FnReason>>();
    for (const h of c.layer.hollowFns ?? []) {
      // 测试里的桩函数、示例里的空 CLI，是写法本身，不是缺陷。
      // click 上「当前成立」的 47 条里 45 条在 tests/、2 条在 examples/，src/ 里一条都没有。
      // 把它们报成「需要人工复核」，等于让真正的问题排不进前 40 条。
      if (isTestFile(h.file) || ENTRY_DIR.test(h.file)) continue;
      const key = `${h.file}\u0000${h.name}\u0000${h.reason}`;
      mark(downFlags, key, i);
      downLine.set(key, h.line);
      let byName = hollowAt.get(h.file);
      if (!byName) hollowAt.set(h.file, (byName = new Map()));
      byName.set(h.name, h.reason);
    }
    // 顺着调用链往外追。原来只追两跳，真实代码里 A→B→C→D 很常见，两跳就断了。
    // 追得越远越不可信，所以每条结论记一个 hops，报告按它标置信度：
    // 1 跳是直接看到「这个函数调用了一个空实现」，4 跳是推出来的。
    // 跳数有上限，不需要额外的去重集合：环最多转到 MAX_CALL_HOPS 就停，mark 本身幂等。
    // 之前加过一个「已访问」集合，结果第一跳就把还没追到的项记成访问过，第二跳直接跳过，
    // 整条链反而断了。
    // 顺着调用链一直追到底，不设深度上限。
    //
    // 用「已访问」集合保证终止：环会转回来，转回来就跳过，所以不需要一个拍出来的上限。
    // 距离记的是真实链长：空实现本身算 0，直接调用它的是 1，再往上加一。
    // 之前记的是「第几轮追到的」，同一轮里靠后的项会少算一跳，链越长偏得越多。
    //
    // 文件内的调用（d.local）不查 import，直接就是本文件的函数 —— 原来这一类被整个丢掉了，
    // 于是「函数调用路径」只覆盖跨文件那一半。
    const dist = new Map<string, number>();
    // 只有「结构上就空的」是链的底，距离给 0。
    // calls-empty 不给 —— 它的距离要顺着「它调用的是谁」算出来，先给 0 会低估整条链。
    for (const [file, byName] of hollowAt)
      for (const [name, reason] of byName) if (reason !== "calls-empty") dist.set(`${file}\u0000${name}`, 0);
    const visitedCall = new Set<string>();
    const calls = c.layer.delegates ?? [];
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const d of calls) {
        const visit = `${d.file}\u0000${d.name}\u0000${d.callee}`;
        if (visitedCall.has(visit)) continue;
        let target: string | null;
        let imported: string;
        if (d.local === true) {
          target = d.file;
          imported = d.callee;
        } else {
          const binding = (factDepth.get(d.file)?.imports ?? []).find((b) => b.local === d.callee);
          if (!binding) continue;
          target = resolveRel(d.file, binding.spec, filesNow);
          imported = binding.imported;
        }
        if (!target) continue;
        const d0 = dist.get(`${target}\u0000${imported}`);
        if (d0 === undefined) continue;
        // 测试里的桩函数、示例里的空 CLI，是写法本身，不是缺陷。
        // click 上「当前成立」的 47 条里 45 条在 tests/、2 条在 examples/，src/ 里一条都没有 ——
        // 把这些也报出来，等于把「设计如此」当成问题。
        if (isTestFile(d.file) || ENTRY_DIR.test(d.file)) { visitedCall.add(visit); continue; }
        visitedCall.add(visit);
        const hops = d0 + 1;
        const key = `${d.file}\u0000${d.name}\0calls-other`;
        mark(downFlags, key, i);
        downLine.set(key, d.line);
        downVia.set(key, `${target}:${imported}`);
        downHops.set(key, hops);
        const self = `${d.file}\u0000${d.name}`;
        const prev = dist.get(self);
        if (prev === undefined || prev > hops) dist.set(self, hops);
        let byName = hollowAt.get(d.file);
        if (!byName) hollowAt.set(d.file, (byName = new Map()));
        byName.set(d.name, "calls-other");
        progressed = true;
      }
    }

    const byKind = (hits: readonly ContractHit[]): Map<string, ContractHit[]> => {
      const m = new Map<string, ContractHit[]>();
      for (const h of hits) {
        const arr = m.get(h.kind);
        if (arr) arr.push(h);
        else m.set(h.kind, [h]);
      }
      return m;
    };
    const decl = byKind(c.layer.declares);
    const ref = byKind(c.layer.references);
    for (const k of kinds) {
      const ds = decl.get(k) ?? [];
      const rs = ref.get(k) ?? [];
      if (ds.length > 0) declaredFlags.get(k)![i] = true;
      if (rs.length > 0) referencedFlags.get(k)![i] = true;
      // 缺任何一侧都不比较：那是项目形态，不是洞
      if (ds.length === 0 || rs.length === 0) continue;
      const have = new Set(ds.map((d) => d.name));
      for (const r of rs) {
        if (have.has(r.name)) continue;
        const key = `${k}\u0000${r.name}`;
        let fl = unmetFlags.get(key);
        if (!fl) unmetFlags.set(key, (fl = new Array<boolean>(n).fill(false)));
        fl[i] = true;
        let fs = unmetFiles.get(key);
        if (!fs) unmetFiles.set(key, (fs = new Set()));
        fs.add(r.file);
      }
    }
  });

  const intervals = (m: Map<string, boolean[]>): { key: string; alive: Interval[] }[] =>
    [...m.entries()].map(([key, fl]) => ({ key, alive: toIntervals(fl) })).filter((x) => x.alive.length > 0);

  const routeItem = (key: string, alive: Interval[]): { name: string; file: string; note: string; alive: Interval[] } => {
    const parts = key.split("\u0000");
    return { name: parts[1] ?? "", file: parts[2] ?? "", note: fakeNote.get(key) ?? "", alive };
  };

  return {
    commits: n,
    stubs: intervals(stubFlags).map(({ key, alive }) => ({ file: key, alive })),
    shallow: intervals(shallowFlags).map(({ key, alive }) => {
      const [file, depth, detail] = key.split("\u0000") as [string, ShallowDepth, string];
      return { file: file ?? "", depth, detail: detail ?? "", alive };
    }),
    present: intervals(presentFlags).map(({ key, alive }) => ({ file: key, alive })),
    testOnly: intervals(testFlags).map(({ key, alive }) => ({ file: key, alive })),
    unreferenced: intervals(unrefFlags).map(({ key, alive }) => ({ file: key, alive })),
    convention: intervals(convFlags).map(({ key, alive }) => ({ file: key, alive })),
    entry: intervals(unrefFlags)
      .filter(({ key }) => entryWhy.has(key))
      .map(({ key, alive }) => ({ file: key, why: entryWhy.get(key)!, alive })),
    contracts: [...kinds].sort().map((kind) => ({
      kind,
      declared: toIntervals(declaredFlags.get(kind)!),
      referenced: toIntervals(referencedFlags.get(kind)!),
      unmet: intervals(unmetFlags)
        .filter(({ key }) => key.startsWith(`${kind}\u0000`))
        .map(({ key, alive }) => ({ name: key.slice(kind.length + 1), files: [...(unmetFiles.get(key) ?? [])].sort(), alive })),
      fake: intervals(fakeFlags)
        .filter(({ key }) => key.startsWith(`${kind}\u0000`) && !key.endsWith("\u0000lost"))
        .map(({ key, alive }) => routeItem(key, alive)),
      unresolved: intervals(fakeFlags)
        .filter(({ key }) => key.startsWith(`${kind}\u0000`) && key.endsWith("\u0000lost"))
        .map(({ key, alive }) => routeItem(key, alive)),
    })),
    clues: intervals(clueFlags).map(({ key, alive }) => {
      const [kind, file] = key.split("\u0000") as [string, string];
      return { kind, file, alive };
    }),
    unsupported: intervals(unsupportedFlags).map(({ key, alive }) => ({ file: key, alive })),
    down: intervals(downFlags).map(({ key, alive }) => {
      const [file, name, reason] = key.split("\u0000") as [string, string, FnReason];
      return { file, name, line: downLine.get(key) ?? 1, reason, via: downVia.get(key) ?? "", hops: downHops.get(key) ?? 1, alive };
    }),
  };
}

/* ── 和上层（说法、想法）对账 ── */

export type FakeDepth = "empty" | "unimplemented" | "placeholder";

export interface LayerReport {
  /** 说法为真或想法已完成，但指着的文件是假实现：空的、写着没实现、或函数只返回空值 */
  hollow: { kind: "claim" | "idea"; label: string; file: string; depth: FakeDepth; alive: Interval[] }[];
  /**
   * 看起来成立，其实是被另一种方式盖住的。
   * forward 只是转到别的文件；test-only 只有测试引用；loose-compare 靠下限/上限措辞才成立；
   * alias 别名解析不了；handler-unresolved 路由的处理函数没追到。
   */
  covers: { how: "forward" | "test-only" | "loose-compare" | "alias" | "handler-unresolved" | "range" | "one-sided"; label: string; detail: string; alive: Interval[] }[];
  /** 指着的文件有实质代码。这不是「真的实现了」，只是排除了上面两类 */
  unproven: { kind: "claim" | "idea"; label: string; file: string; alive: Interval[] }[];
  /** 没人引用、也没被任何说法或想法提到 */
  orphans: { file: string; alive: Interval[] }[];
  /** 没有 import 边，但文件名在别的文件正文里出现过：按约定加载的脚本、页面资产、插件。不算孤立 */
  convention: { file: string; alive: Interval[] }[];
  /** 没有 import 边，但有入口证据（目录角色、包归属、清单声明、shebang）。不是孤立，理由在 why 里 */
  entry: { file: string; why: string; alive: Interval[] }[];
  contracts: ContractKind[];
  clues: { kind: string; file: string; alive: Interval[] }[];
  unsupported: { file: string; alive: Interval[] }[];
  down: { file: string; name: string; line: number; reason: FnReason; via: string; hops: number; holds: string[]; atHead: boolean; alive: Interval[] }[];
}

const HOLDS = 0; // 说法的「真」和想法的「已满足」都是 0
const UNMEASURED = 3;
/**
 * 措辞把差额盖住：相对差额和绝对差额都要够。
 * 只有百分比时，「共 5 关、实际 6」也会被记上一笔，和「1600+、实际 1899」不是一回事。
 * 15% 沿用原来的比例；绝对差额至少 2，是为了去掉只差 1 的小计数。两个数都是人为定的，不是从样本估出来的。
 */
const LOOSE_GAP = 0.15;
const LOOSE_ABS = 2;

export interface UpperLayer {
  kind: "claim" | "idea";
  label: string;
  states: readonly number[];
  files: readonly string[];
  compare?: "eq" | "gte" | "lte" | "approx";
  claimed?: readonly (number | null)[];
  actual?: readonly (number | null)[];
  /** 引用边界判不了时的原因 */
  blind?: string | null;
  /** 文档里那一行，用来看是不是写成了区间 */
  verbatim?: string;
}

const coversCommit = (alive: readonly Interval[], i: number): boolean => alive.some(([a, b]) => i >= a && i <= b);

/**
 * 把层信息同上层的结论对在一起。
 * 成立的结论分成三档：假实现、被别的方式盖住、有实质代码但还不能算真实现。
 * 被任何一条提到的文件不再算孤立。
 */
export function joinLayers(data: LayersData, upper: readonly UpperLayer[]): LayerReport {
  const shallowAt = (file: string, i: number): { depth: ShallowDepth; detail: string } | null => {
    for (const s of data.shallow) if (s.file === file && coversCommit(s.alive, i)) return { depth: s.depth, detail: s.detail };
    return null;
  };
  const stubAt = (file: string, i: number): boolean => data.stubs.some((s) => s.file === file && coversCommit(s.alive, i));
  const presentAt = (file: string, i: number): boolean => data.present.some((p) => p.file === file && coversCommit(p.alive, i));

  const hollow: LayerReport["hollow"] = [];
  const covers: LayerReport["covers"] = [];
  const unproven: LayerReport["unproven"] = [];

  for (const u of upper) {
    for (const f of u.files) {
      const byDepth = new Map<FakeDepth, boolean[]>();
      const forward = new Array<boolean>(u.states.length).fill(false);
      const real = new Array<boolean>(u.states.length).fill(false);
      u.states.forEach((s, i) => {
        if (s !== HOLDS) return;
        const shallow = shallowAt(f, i);
        const depth: ShallowDepth | null = shallow?.depth ?? (stubAt(f, i) ? "unimplemented" : null);
        if (depth === "forward") forward[i] = true;
        else if (depth === "empty" || depth === "unimplemented" || depth === "placeholder") {
          let fl = byDepth.get(depth);
          if (!fl) byDepth.set(depth, (fl = new Array<boolean>(u.states.length).fill(false)));
          fl[i] = true;
        } else if (presentAt(f, i)) real[i] = true;
      });
      for (const [depth, flags] of byDepth) {
        const alive = toIntervals(flags);
        if (alive.length > 0) hollow.push({ kind: u.kind, label: u.label, file: f, depth, alive });
      }
      const forwarded = toIntervals(forward);
      if (forwarded.length > 0) {
        const detail = data.shallow.find((s) => s.file === f && s.depth === "forward")?.detail ?? "";
        covers.push({ how: "forward", label: u.label, detail: detail === "" ? f : `${f} 只转到 ${detail}`, alive: forwarded });
      }
      const proven = toIntervals(real);
      if (proven.length > 0) unproven.push({ kind: u.kind, label: u.label, file: f, alive: proven });
    }

    if ((u.compare === "gte" || u.compare === "lte" || u.compare === "approx") && u.claimed && u.actual) {
      const flags = u.states.map((s, i) => {
        const want = u.claimed![i];
        const got = u.actual![i];
        if (s !== HOLDS || want === null || want === undefined || got === null || got === undefined) return false;
        const abs = Math.abs(got - want);
        const gap = abs / Math.max(Math.abs(want), 1);
        const direction = u.compare === "approx" || (u.compare === "gte" && got > want) || (u.compare === "lte" && got < want);
        return abs >= LOOSE_ABS && gap >= LOOSE_GAP && direction;
      });
      const alive = toIntervals(flags);
      if (alive.length > 0) {
        const i = flags.findIndex(Boolean);
        const symbol = u.compare === "gte" ? "≥" : u.compare === "lte" ? "≤" : "≈";
        covers.push({
          how: "loose-compare",
          label: u.label,
          detail: `按 ${symbol} 比较才成立：文档写 ${u.claimed[i] ?? "?"}，实际 ${u.actual[i] ?? "?"}`,
          alive,
        });
      }
    }
    if (u.verbatim && /\d[\d,.]*\s*(?:-|–|~|～|到|至)\s*\d/.test(u.verbatim)) {
      const alive = toIntervals(u.states.map((s) => s === HOLDS || s === 1));
      if (alive.length > 0) {
        covers.push({ how: "range", label: u.label, detail: `文档像是区间（${u.verbatim.trim().slice(0, 80)}），这条说法只捕获了一个数`, alive });
      }
    }
    if (u.blind) {
      const alive = toIntervals(u.states.map((s) => s === UNMEASURED));
      if (alive.length > 0) covers.push({ how: "alias", label: u.label, detail: u.blind, alive });
    }
  }

  for (const t of data.testOnly) covers.push({ how: "test-only", label: t.file, detail: "只有测试引用它，生产代码没有用它", alive: t.alive });
  for (const c of data.contracts) {
    for (const u of c.unresolved) covers.push({ how: "handler-unresolved", label: u.name, detail: `${u.file}：${u.note}`, alive: u.alive });
    const declared = c.declared.length > 0;
    const referenced = c.referenced.length > 0;
    if (declared !== referenced) {
      covers.push({
        how: "one-sided",
        label: c.kind,
        detail: declared ? "只有声明、没有仓库内的引用。不把它当成洞，调用方可以在仓库外" : "只有引用、没有声明。不把它当成洞，可能是在调外部服务",
        alive: declared ? c.declared : c.referenced,
      });
    }
  }

  const mentioned = new Set(upper.flatMap((u) => u.files));
  // 孤立 = 没有引用边，也不是按约定加载，也没有任何入口证据。
  // 前两条以前就有；第三条是这一版新增的 —— 「没有入边」在库项目里几乎总是「这是出口」，
  // 不是缺陷。有证据的单独放进 entry，报告里能看到它是靠什么被排除的。
  const entryBy = new Map(data.entry.map((e) => [e.file, e.why]));
  const orphans = data.unreferenced.filter((u) => !mentioned.has(u.file) && !entryBy.has(u.file));
  const entry = data.entry.filter((e) => !mentioned.has(e.file));

  // 只存在于历史的条目不能当成当前问题。click 上 100 条里有 53 条是 2014 年的骨架，
  // 和现存的 47 条混在一起，前 40 条截断后全是历史噪声。
  const lastCommit = Math.max(0, data.commits - 1);
  const down = data.down.map((d) => ({
    ...d,
    atHead: d.alive.some(([, b]) => b >= lastCommit),
    holds: upper
      .filter((u) => u.files.includes(d.file) && d.alive.some(([a, b]) => u.states.slice(a, b + 1).some((s) => s === HOLDS)))
      .map((u) => u.label),
  }));

  return {
    hollow,
    covers,
    unproven,
    orphans,
    entry,
    // 被说法或想法提到的不再叫「按约定」——那已经是明确的证据了
    convention: data.convention.filter((c) => !mentioned.has(c.file)),
    contracts: data.contracts,
    clues: data.clues,
    unsupported: data.unsupported,
    down,
  };
}
