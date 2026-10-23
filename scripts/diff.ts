#!/usr/bin/env node
/**
 * laminae —— 比较两次运行：改了一条规则之后，结论从哪一条开始不一样
 *
 *   node <laminae>/scripts/diff.ts <旧运行> <新运行>
 *   node <laminae>/scripts/diff.ts vue2 vue9         运行 id
 *   node <laminae>/scripts/diff.ts a.json b.json     payload 路径
 *   node <laminae>/scripts/diff.ts --json            机器可读
 *   node <laminae>/scripts/diff.ts --out d.json      写文件（避开 PowerShell 的 BOM）
 *
 * 为什么要有这个：
 *
 * 这个工具的维护成本几乎全在结构识别那一侧 —— 语法模块、入口表、引用图、空壳判定。
 * 那一侧的工作循环是「再摁一个真仓库、对完红格、补一条有出处的规则」。
 * 可这个循环缺一件东西：**改完一条规则，怎么看它影响了哪些结论。**
 *
 * 以前只能翻两份 payload.json，几千条状态逐个对。看不见影响，就不敢改规则；
 * 不敢改，那一侧就停在那儿。这个命令就是那把尺子。
 *
 * 比四类：
 *   说法   每条的状态序列在哪一段不同、从哪个 commit 开始、影响多少格
 *   层     孤立、按约定加载、入口、往下看一层这几档的增减，列到具体文件
 *   图     节点与边的增减
 *   汇总   真 / 假 / 尚未写入文档 / 测不出来 的格子数
 *
 * 提交序列不一致时按 sha 对齐，并把「只在一侧出现的提交」明说出来 —— 不能静默错位。
 */
import fs from "node:fs";
import path from "node:path";
import { assertBoundRepo } from "../src/core/config.ts";
import { RUNS_DIR } from "../src/core/paths.ts";
import { git } from "../src/core/gitutil.ts";
import type { Payload } from "../src/core/types.ts";

const STATE_NAME = ["真", "假", "尚未写入文档", "测不出来"] as const;

interface Loaded {
  payload: Payload;
  name: string;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const flag = (name: string): boolean => process.argv.includes(name);

/** 运行 id 或 payload 路径都能给。给 id 时去 .laminae/runs/<id>/payload.json 找 */
function load(spec: string): Loaded {
  const direct = path.isAbsolute(spec) || spec.endsWith(".json");
  const file = direct ? spec : path.join(RUNS_DIR, spec, "payload.json");
  if (!fs.existsSync(file)) {
    const known = fs.existsSync(RUNS_DIR)
      ? fs.readdirSync(RUNS_DIR).filter((d) => fs.existsSync(path.join(RUNS_DIR, d, "payload.json")))
      : [];
    throw new Error(`找不到 ${file}。已知的运行：${known.length === 0 ? "（还没有）" : known.join(", ")}`);
  }
  const payload = JSON.parse(fs.readFileSync(file, "utf8")) as Payload;
  return { payload, name: direct ? path.basename(spec, ".json") : spec };
}

/**
 * 按 sha 对齐两次运行的提交序列。
 *
 * 同一个仓库、历史没改写时两边应该完全一样，直接按下标比就行。
 * 但历史可能被改写（rebase、force push），或者两次运行之间多了新提交。
 * 那时候静默按下标比会把整条时间线错开一位 —— 那种错比任何误报都难查。
 */
interface Align {
  pairs: [number, number][];
  onlyOld: string[];
  onlyNew: string[];
  identical: boolean;
}

function align(a: Payload, b: Payload): Align {
  const oldShas = a.commits.map((c) => c.sha);
  const newShas = b.commits.map((c) => c.sha);
  if (oldShas.length === newShas.length && oldShas.every((s, i) => s === newShas[i])) {
    return { pairs: oldShas.map((_, i) => [i, i] as [number, number]), onlyOld: [], onlyNew: [], identical: true };
  }
  const atNew = new Map(newShas.map((s, i) => [s, i]));
  const pairs: [number, number][] = [];
  const onlyOld: string[] = [];
  for (let i = 0; i < oldShas.length; i++) {
    const j = atNew.get(oldShas[i]!);
    if (j === undefined) onlyOld.push(oldShas[i]!);
    else pairs.push([i, j]);
  }
  const atOld = new Set(oldShas);
  const onlyNew = newShas.filter((s) => !atOld.has(s));
  return { pairs, onlyOld, onlyNew, identical: false };
}

interface ClaimDiff {
  id: string;
  label: string;
  /** 只在一侧有的说法 */
  missing: "old" | "new" | null;
  /** 第一个不同的位置（payload 里的下标），没有不同就是 null */
  firstAt: number | null;
  /** 影响的格子数 */
  cells: number;
  /** 差异分成几段 */
  segments: { from: number; to: number; old: number; new: number }[];
}

function diffClaim(
  oldC: Payload["claims"][number] | undefined,
  newC: Payload["claims"][number] | undefined,
  pairs: readonly [number, number][],
): ClaimDiff {
  const id = (oldC ?? newC)!.id;
  const label = (oldC ?? newC)!.label;
  if (!oldC || !newC) return { id, label, missing: oldC ? "new" : "old", firstAt: null, cells: 0, segments: [] };

  const segments: ClaimDiff["segments"] = [];
  let cells = 0;
  let firstAt: number | null = null;
  let open: ClaimDiff["segments"][number] | null = null;

  for (const [i, j] of pairs) {
    const a = oldC.states[i];
    const b = newC.states[j];
    if (a === b) {
      if (open) {
        segments.push(open);
        open = null;
      }
      continue;
    }
    cells++;
    if (firstAt === null) firstAt = j;
    if (open && open.old === a && open.new === b) open.to = j;
    else {
      if (open) segments.push(open);
      open = { from: j, to: j, old: a ?? 2, new: b ?? 2 };
    }
  }
  if (open) segments.push(open);
  return { id, label, missing: null, firstAt, cells, segments };
}

/** 集合差异：两个数组按 key 取出可读标签，比出增删 */
function setDiff<T>(oldItems: readonly T[], newItems: readonly T[], key: (x: T) => string, show: (x: T) => string): { added: string[]; removed: string[] } {
  const oldMap = new Map(oldItems.map((x) => [key(x), x]));
  const newMap = new Map(newItems.map((x) => [key(x), x]));
  const added: string[] = [];
  const removed: string[] = [];
  for (const [k, v] of newMap) if (!oldMap.has(k)) added.push(show(v));
  for (const [k, v] of oldMap) if (!newMap.has(k)) removed.push(show(v));
  return { added, removed };
}

const downKey = (d: { file: string; name: string }): string => `${d.file}\u0000${d.name}`;
const downShow = (d: { file: string; name: string; line: number; reason: string }): string => `${d.file}:${d.line} ${d.name}（${d.reason}）`;

function main(): void {
  assertBoundRepo();
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--") && !process.argv[process.argv.indexOf(a) - 1]?.startsWith("--"));
  const oldSpec = arg("--from") ?? positional[0];
  const newSpec = arg("--to") ?? positional[1];
  if (!oldSpec || !newSpec) {
    throw new Error("要给两次运行：node scripts/diff.ts <旧运行> <新运行>（运行 id 或 payload 路径）");
  }

  const A = load(oldSpec);
  const B = load(newSpec);
  const al = align(A.payload, B.payload);

  const claimIds = [...new Set([...A.payload.claims.map((c) => c.id), ...B.payload.claims.map((c) => c.id)])];
  const claims = claimIds.map((id) =>
    diffClaim(
      A.payload.claims.find((c) => c.id === id),
      B.payload.claims.find((c) => c.id === id),
      al.pairs,
    ),
  );

  const la = A.payload.layers as unknown as Record<string, { file?: string; name?: string; line?: number; reason?: string; label?: string }[]> | undefined;
  const lb = B.payload.layers as unknown as Record<string, { file?: string; name?: string; line?: number; reason?: string; label?: string }[]> | undefined;
  const buckets = ["orphans", "convention", "entry", "down", "hollow", "unsupported"] as const;
  const layers = buckets.map((k) => {
    const o = la?.[k] ?? [];
    const n = lb?.[k] ?? [];
    const isDown = k === "down";
    const d = isDown
      ? setDiff(o as never[], n as never[], (x: never) => downKey(x), (x: never) => downShow(x))
      : setDiff(o as never[], n as never[], (x: never) => (x as { file: string }).file, (x: never) => (x as { file: string }).file);
    return { bucket: k, oldCount: o.length, newCount: n.length, ...d };
  });

  const ga = A.payload.graph;
  const gb = B.payload.graph;
  const graph = ga && gb
    ? (() => {
        const nodes = setDiff(
          (ga.nodes ?? []) as { id?: string; file?: string }[],
          (gb.nodes ?? []) as { id?: string; file?: string }[],
          (x) => x.id ?? x.file ?? "",
          (x) => x.id ?? x.file ?? "",
        );
        // 边在 payload 里是 {s, t} 下标对，标签要拿节点名回查
        const nameOf = (g: NonNullable<Payload["graph"]>, i: number): string =>
          (g.nodes ?? [])[i]?.id ?? `#${i}`;
        const edges = setDiff(
          (ga.edges ?? []) as { s: number; t: number }[],
          (gb.edges ?? []) as { s: number; t: number }[],
          (e) => `${e.s}\u0000${e.t}`,
          (e) => `${nameOf(gb, e.s)} → ${nameOf(gb, e.t)}`,
        );
        return { oldNodes: (ga.nodes ?? []).length, newNodes: (gb.nodes ?? []).length, oldEdges: (ga.edges ?? []).length, newEdges: (gb.edges ?? []).length, ...nodes, ...edges, nodesAdded: nodes.added, nodesRemoved: nodes.removed, edgesAdded: edges.added, edgesRemoved: edges.removed };
      })()
    : null;

  // 汇总口径：按对齐后的位置重数一遍四态格子
  const tally = (p: Payload, idx: number[]): number[] => {
    const out = [0, 0, 0, 0];
    for (const c of p.claims) for (const i of idx) out[c.states[i] ?? 2]!++;
    return out;
  };
  const oldIdx = al.pairs.map(([i]) => i);
  const newIdx = al.pairs.map(([, j]) => j);
  const tallyOld = tally(A.payload, oldIdx);
  const tallyNew = tally(B.payload, newIdx);

  const anyClaim = claims.some((c) => c.missing !== null || c.cells > 0);
  const anyLayer = layers.some((l) => l.added.length > 0 || l.removed.length > 0);
  const anyGraph = graph ? graph.nodesAdded.length + graph.nodesRemoved.length + graph.edgesAdded.length + graph.edgesRemoved.length > 0 : false;
  const anyTally = tallyOld.some((v, i) => v !== tallyNew[i]);
  const clean = !anyClaim && !anyLayer && !anyGraph && !anyTally && al.identical;

  if (flag("--json")) {
    const out = { from: A.name, to: B.name, align: { identical: al.identical, onlyOld: al.onlyOld, onlyNew: al.onlyNew, pairs: al.pairs.length }, claims, layers, graph, tally: { old: tallyOld, new: tallyNew }, clean };
    const text = JSON.stringify(out, null, 2);
    const file = arg("--out");
    if (file) {
      fs.writeFileSync(file, `${text}\n`, "utf8");
      console.log(`已写入 ${file}`);
    } else console.log(text);
    return;
  }

  const lines: string[] = [];
  lines.push(`比较 ${A.name} → ${B.name}`);
  if (al.identical) lines.push(`  提交 ${A.payload.commits.length} → ${B.payload.commits.length}，序列完全一样`);
  else {
    lines.push(`  提交 ${A.payload.commits.length} → ${B.payload.commits.length}`);
    lines.push(`  **两次的提交序列不一样**，按 sha 对齐后能比的 ${al.pairs.length} 个`);
    if (al.onlyOld.length > 0) lines.push(`  只在旧的那次里有 ${al.onlyOld.length} 个（历史被改写过？）：${al.onlyOld.slice(0, 3).map((s) => s.slice(0, 7)).join(", ")}${al.onlyOld.length > 3 ? " …" : ""}`);
    if (al.onlyNew.length > 0) lines.push(`  只在新的一次里有 ${al.onlyNew.length} 个：${al.onlyNew.slice(0, 3).map((s) => s.slice(0, 7)).join(", ")}${al.onlyNew.length > 3 ? " …" : ""}`);
  }
  lines.push("");

  if (clean) {
    lines.push("没有差异。两边的说法判定、层的几档、图、汇总口径完全一致。");
    console.log(lines.join("\n"));
    return;
  }

  lines.push("说法");
  if (!anyClaim) lines.push("  一致");
  else {
    for (const c of claims) {
      if (c.missing === "old") {
        lines.push(`  ${c.label}：只在新的那边有这条说法`);
        continue;
      }
      if (c.missing === "new") {
        lines.push(`  ${c.label}：旧的那边有，新的这边没有了`);
        continue;
      }
      if (c.cells === 0) continue;
      const at = c.firstAt === null ? "" : `（#${c.firstAt} ${B.payload.commits[c.firstAt]?.short.slice(0, 7) ?? ""} ${B.payload.commits[c.firstAt]?.date ?? ""}）`;
      lines.push(`  ${c.label}：${c.cells} 格不同，第一个从 #${c.firstAt} 起${at}`);
      for (const s of c.segments.slice(0, 6)) {
        const span = s.from === s.to ? `#${s.from}` : `#${s.from}–#${s.to}`;
        lines.push(`    ${span}  ${STATE_NAME[s.old]} → ${STATE_NAME[s.new]}`);
      }
      if (c.segments.length > 6) lines.push(`    另有 ${c.segments.length - 6} 段`);
    }
  }
  lines.push("");

  if (anyLayer) {
    lines.push("层");
    for (const l of layers) {
      if (l.added.length === 0 && l.removed.length === 0) continue;
      lines.push(`  ${l.bucket}  ${l.oldCount} → ${l.newCount}`);
      for (const x of l.added.slice(0, 5)) lines.push(`    + ${x}`);
      if (l.added.length > 5) lines.push(`    + 另有 ${l.added.length - 5} 条`);
      for (const x of l.removed.slice(0, 5)) lines.push(`    - ${x}`);
      if (l.removed.length > 5) lines.push(`    - 另有 ${l.removed.length - 5} 条`);
    }
    lines.push("");
  }

  if (anyGraph && graph) {
    lines.push("图");
    lines.push(`  节点 ${graph.oldNodes} → ${graph.newNodes}   边 ${graph.oldEdges} → ${graph.newEdges}`);
    for (const x of graph.nodesAdded.slice(0, 5)) lines.push(`    + 节点 ${x}`);
    for (const x of graph.nodesRemoved.slice(0, 5)) lines.push(`    - 节点 ${x}`);
    for (const x of graph.edgesAdded.slice(0, 5)) lines.push(`    + 边 ${x}`);
    for (const x of graph.edgesRemoved.slice(0, 5)) lines.push(`    - 边 ${x}`);
    lines.push("");
  }

  if (anyTally) {
    lines.push("汇总口径（对齐后能比的提交上的格子数）");
    for (let i = 0; i < 4; i++) if (tallyOld[i] !== tallyNew[i]) lines.push(`  ${STATE_NAME[i]}  ${tallyOld[i]} → ${tallyNew[i]}（${tallyNew[i]! - tallyOld[i]! > 0 ? "+" : ""}${tallyNew[i]! - tallyOld[i]!}）`);
    lines.push("");
  }

  const text = lines.join("\n").trimEnd();
  const file = arg("--out");
  if (file) {
    fs.writeFileSync(file, `${text}\n`, "utf8");
    console.log(`已写入 ${file}`);
  } else console.log(text);
}

main();

void git;
