#!/usr/bin/env node
/**
 * laminae —— 顺着函数调用链查到最底，给 agent 拿去解释
 *
 *   node <laminae>/scripts/trace.ts --file src/top.ts        这个文件里每个函数的调用链
 *   node <laminae>/scripts/trace.ts --at src/top.ts#top      只看这一条
 *   node <laminae>/scripts/trace.ts --file src/top.ts --json 机器可读，交给 agent
 *
 * 和 run 的分工：run 出的是判定（哪些函数有问题），trace 出的是**路径**。
 * 一个问题函数往往要从入口顺下来才能说清，而这条路径跨文件、跨层，靠读代码很难走全。
 *
 * 不设深度上限。用已访问集合保证终止：环会转回来，转回来就停。
 *
 * 每一跳都带 evidence —— 一条能直接跑的 shell 命令，看得到这段函数体。
 * agent 拿这条命令自己去看，而不是信这里的结论。
 */
import fs from "node:fs";
import { git } from "../src/core/gitutil.ts";
import { isCodeFile } from "../src/layers/imports.ts";
import { delegatedCalls, hollowFunctions } from "../src/layers/layers-core.ts";
import { BlobReader } from "../src/layers/scan.ts";
import { pickModule } from "../src/layers/syntax-registry.ts";

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(n);
const value = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

interface Fn {
  file: string;
  name: string;
  line: number;
  lines: number;
  kind: "hollow" | "code";
  reason: string | null;
}

interface Edge {
  to: Fn;
  /** 这一跳是文件内调用，还是通过 import 跨文件 */
  how: "local" | "import";
  spec?: string;
}

async function loadAll(): Promise<{ fns: Map<string, Fn>; byFile: Map<string, Fn[]>; edges: Map<string, Edge[]>; texts: Map<string, string> }> {
  const out = git(["ls-tree", "-r", "HEAD"]);
  if (out === null) throw new Error("读不到 HEAD，先在目标仓库目录下运行");
  const oidOf = new Map<string, string>();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const file = line.slice(tab + 1);
    if (isCodeFile(file)) oidOf.set(file, line.slice(0, tab).split(" ")[2] ?? "");
  }
  const reader = new BlobReader();
  let blobs: Map<string, string | null>;
  try {
    blobs = await reader.read([...new Set(oidOf.values())]);
  } finally {
    reader.close();
  }

  const texts = new Map<string, string>();
  for (const [file, oid] of oidOf) {
    const t = blobs.get(oid);
    if (typeof t === "string") texts.set(file, t);
  }

  const fns = new Map<string, Fn>();
  const byFile = new Map<string, Fn[]>();
  const edges = new Map<string, Edge[]>();
  const importsOf = new Map<string, { local: string; imported: string; spec: string }[]>();

  for (const [file, text] of texts) {
    const mod = pickModule(text);
    const hollow = new Map(hollowFunctions(text).map((h) => [h.name, h.reason]));
    const list: Fn[] = [];
    for (const f of mod.findFunctions(text)) {
      if (!f.name) continue;
      const line = text.slice(0, f.start).split("\n").length;
      const fn: Fn = {
        file,
        name: f.name,
        line,
        lines: text.slice(f.start, f.end).split("\n").length,
        kind: hollow.has(f.name) ? "hollow" : "code",
        reason: hollow.get(f.name) ?? null,
      };
      fns.set(`${file}#${f.name}`, fn);
      list.push(fn);
    }
    byFile.set(file, list);
    importsOf.set(file, mod.parseBindings(text, "import"));
  }

  // 建边：文件内的直接连；跨文件的按 import 解析到文件，再在一行里匹配同名的函数
  const resolveImport = (from: string, spec: string): string | null => {
    if (!spec.startsWith(".")) return null;
    const dir = from.slice(0, from.lastIndexOf("/") + 1);
    const raw = spec.split("/");
    const out: string[] = dir === "" ? [] : dir.slice(0, -1).split("/");
    for (const seg of raw) {
      if (seg === "." || seg === "") continue;
      if (seg === "..") out.pop();
      else out.push(seg);
    }
    const base = out.join("/");
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.js"]) {
      if (texts.has(base + ext)) return base + ext;
    }
    return null;
  };

  for (const [file, list] of byFile) {
    const imps = importsOf.get(file) ?? [];
    for (const d of delegatedCalls(texts.get(file) ?? "")) {
      const from = list.find((f) => f.name === d.name);
      if (!from) continue;
      const localFn = list.find((f) => f.name === d.callee);
      const key = `${file}#${d.name}`;
      const push = (e: Edge): void => {
        const arr = edges.get(key);
        if (arr) arr.push(e);
        else edges.set(key, [e]);
      };
      if (localFn) {
        push({ to: localFn, how: "local" });
        continue;
      }
      const b = imps.find((x) => x.local === d.callee);
      if (!b) continue;
      const target = resolveImport(file, b.spec);
      if (!target) continue;
      const to = byFile.get(target)?.find((f) => f.name === b.imported);
      if (to) push({ to, how: "import", spec: b.spec });
    }
  }
  return { fns, byFile, edges, texts };
}

const evidence = (f: Fn): string => `git show HEAD:${f.file} | sed -n '${Math.max(1, f.line - 2)},${f.line + f.lines}p'`;

interface Node {
  fn: Fn;
  depth: number;
  how: "root" | "local" | "import";
  spec?: string;
  children: Node[];
  cycle?: boolean;
}

function walk(start: Fn, edges: Map<string, Edge[]>, seen: Set<string>, depth: number, how: Node["how"], spec?: string): Node {
  const key = `${start.file}#${start.name}`;
  const node: Node = { fn: start, depth, how, children: [] };
  if (spec) node.spec = spec;
  if (seen.has(key)) {
    node.cycle = true;
    return node;
  }
  seen.add(key);
  for (const e of edges.get(key) ?? []) {
    node.children.push(walk(e.to, edges, seen, depth + 1, e.how, e.spec));
  }
  return node;
}

function toJson(n: Node): unknown {
  return {
    file: n.fn.file,
    function: n.fn.name,
    line: n.fn.line,
    kind: n.fn.kind,
    reason: n.fn.reason,
    depth: n.depth,
    how: n.how,
    ...(n.spec ? { spec: n.spec } : {}),
    ...(n.cycle ? { cycle: true } : {}),
    evidence: evidence(n.fn),
    children: n.children.map(toJson),
  };
}

function print(n: Node, indent = 0): void {
  const pad = "  ".repeat(indent);
  const mark = n.fn.kind === "hollow" ? (n.fn.reason === "unimplemented" ? "  ← 写着没实现" : "  ← 空实现") : "";
  const via = n.how === "import" ? `  (import ${n.spec})` : n.how === "local" ? "  (同文件)" : "";
  const cyc = n.cycle ? "  (环，已返回)" : "";
  console.log(`${pad}${indent === 0 ? "" : "└─ "}${n.fn.file}#${n.fn.name}:${n.fn.line}${via}${mark}${cyc}`);
  for (const c of n.children) print(c, indent + 1);
}

/* ── 拆成子任务 ──
 *
 * 一条链走到几百个函数时，一个 agent 读不完，也没必要一次读完。
 * 这里把树切成若干块，每块带三样东西就能独立执行：
 *   1. 它自己要看的那批节点，每个都带 evidence 命令
 *   2. 它是怎么走到这儿的（ancestry），这样解释起来有上下文
 *   3. 一句要求：逐层说明这些函数在做什么、空在哪
 *
 * 切法是从根往下按顺序走，攒够一批就断开，下一批从下一个还没访问的分支起。
 * 不按深度切，因为一条深链本来就该一起看；按数量切，才是按「一个 agent 一次能读多少」切。
 */
interface Subtask {
  id: string;
  /** 这个任务从哪个函数起 */
  root: unknown;
  /** 从全局根走到这里的路径，不含 root 自己 */
  ancestry: unknown[];
  /** 这个任务要看的全部节点，扁平列表，每个都带 evidence */
  nodes: unknown[];
  /** 交给 agent 的一句话要求 */
  instruction: string;
}

function nodeBrief(n: Node): unknown {
  return {
    file: n.fn.file,
    function: n.fn.name,
    line: n.fn.line,
    kind: n.fn.kind,
    reason: n.fn.reason,
    depth: n.depth,
    how: n.how,
    ...(n.spec ? { spec: n.spec } : {}),
    evidence: evidence(n.fn),
  };
}

function subtreeSize(n: Node): number {
  return 1 + n.children.reduce((a, c) => a + subtreeSize(c), 0);
}

function flatten(n: Node, out: Node[] = []): Node[] {
  out.push(n);
  for (const c of n.children) flatten(c, out);
  return out;
}

/**
 * 按**子树**切，不按节点数硬切。
 *
 * 硬切的后果是分支被从中间截断：一条任务的尾巴和另一条分支的开头被塞进同一块，
 * 交给谁都不好读。按子树切就不会：整棵子树放得下就一起给，放不下就把根单独一条、
 * 每个子分支各自成条。这样每一块都是一条完整的路，ancestry 交代它从哪来。
 */
function split(root: Node, maxNodes: number): Subtask[] {
  const groups: { root: Node; ancestry: Node[]; nodes: Node[] }[] = [];

  const go = (n: Node, ancestry: Node[]): void => {
    if (subtreeSize(n) <= maxNodes) {
      groups.push({ root: n, ancestry: ancestry.slice(), nodes: flatten(n) });
      return;
    }
    groups.push({ root: n, ancestry: ancestry.slice(), nodes: [n] });
    const next = [...ancestry, n];
    for (const c of n.children) go(c, next);
  };
  go(root, []);

  return groups.map((g, i) => {
    const hollow = g.nodes.filter((x) => x.fn.kind === "hollow");
    return {
      id: String(i),
      root: nodeBrief(g.root),
      ancestry: g.ancestry.map(nodeBrief),
      nodes: g.nodes.map(nodeBrief),
      instruction:
        "对 nodes 里每一项跑它的 evidence 命令，看懂那个函数在做什么，然后按链路顺序写说明，不要逐个复述代码。" +
        (hollow.length > 0
          ? "这一批里有 " + hollow.length + " 个结构上是空的（" + hollow.map((x) => x.fn.name).join("、") + "），说明它空在哪、被谁用着。"
          : "这一批里没有结构上空的函数，说明这条路最终靠什么实现。") +
        (g.ancestry.length > 0 ? " ancestry 是从入口走到这里的路径，引用它交代上下文。" : ""),
    };
  });
}

async function main(): Promise<void> {
  const at = value("--at");
  const file = value("--file");
  if (!at && !file && !value("--find")) {
    console.log("用法：");
    console.log("  --file <路径>              这个文件里每个函数的调用链");
    console.log("  --at <文件>#<函数>         只看这一条");
    console.log("  --find <关键词>            按名字或路径找（只做字面匹配）");
    console.log("  --json                     机器可读");
    console.log("  --split <每块节点数>       拆成子任务，每块自带 evidence 与上下文");
    console.log("  --out <文件>               结果写文件（UTF-8，免得 PowerShell 的 > 写成 UTF-16）");
    process.exitCode = 1;
    return;
  }
  const { byFile, edges } = await loadAll();
  const asJson = flag("--json");

  // --find：从关键词找链。只做名字和路径的字面匹配，不懂语义 ——
  // 找不到时会把候选列出来，而不会假装匹配上了。
  const find = value("--find");
  let roots: Fn[] = [];
  if (find) {
    const k = find.toLowerCase();
    const all = [...byFile.values()].flat().filter((f) => f.name.toLowerCase().includes(k) || f.file.toLowerCase().includes(k));
    if (all.length === 0) throw new Error(`没有名字或路径包含「${find}」的函数`);
    if (all.length > 20) throw new Error(`「${find}」匹配到 ${all.length} 个函数，太宽了。换个更具体的词，或者用 --file`);
    roots = all;
  } else if (at) {
    const [f, name] = at.split("#");
    const hit = (byFile.get(f ?? "") ?? []).find((x) => x.name === name);
    if (!hit) throw new Error(`找不到 ${at}`);
    roots = [hit];
  } else {
    roots = byFile.get(file ?? "") ?? [];
    if (roots.length === 0) throw new Error(`没有可分析的函数：${file}`);
  }

  const results = roots.map((r) => walk(r, edges, new Set(), 0, "root"));
  const deepest = (n: Node): number => (n.children.length === 0 ? n.depth : Math.max(...n.children.map(deepest)));

  // 拆成子任务：给「一个 agent 读不完」的链用。每块自带 evidence 和上下文，可以分头跑
  // --out：自己写 UTF-8 无 BOM 的文件。
  // PowerShell 的 `>` 会把输出写成 UTF-16，JSON.parse 读不了，agent 那边很容易踩。
  const emit = (data: unknown): void => {
    const text = JSON.stringify(data, null, 2);
    const out = value("--out");
    if (out) {
      fs.writeFileSync(out, text.endsWith("\n") ? text : text + "\n", "utf8");
      console.log("已写出 " + out);
    } else console.log(text);
  };

  const splitSize = Number(value("--split") ?? "");
  if (Number.isInteger(splitSize) && splitSize > 0) {
    emit(results.flatMap((r) => split(r, splitSize)));
    return;
  }

  if (asJson) {
    emit(results.map(toJson));
    return;
  }
  for (const r of results) {
    print(r);
    const d = deepest(r);
    console.log(`   ${d === 0 ? "没有往下的调用" : `往下 ${d} 层`}；每一跳的命令在 --json 里`);
    console.log("");
  }
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});

