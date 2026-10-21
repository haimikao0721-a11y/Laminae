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
import { git } from "../src/gitutil.ts";
import { isCodeFile } from "../src/imports.ts";
import { delegatedCalls, hollowFunctions } from "../src/layers-core.ts";
import { BlobReader } from "../src/scan.ts";
import { pickModule } from "../src/syntax-registry.ts";

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

async function main(): Promise<void> {
  const at = value("--at");
  const file = value("--file");
  if (!at && !file) {
    console.log("用法：--file <路径> | --at <文件>#<函数>   加 --json 输出机器可读");
    process.exitCode = 1;
    return;
  }
  const { byFile, edges } = await loadAll();
  const asJson = flag("--json");

  let roots: Fn[] = [];
  if (at) {
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

  if (asJson) {
    console.log(JSON.stringify(results.map(toJson), null, 2));
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

