/**
 * laminae —— 分批推测想法
 *
 * 说法现在只能从文档里来。文档写错，整条链就跟着错。这一层让 agent 直接读代码，
 * 逐个函数问「它该做什么」，然后把答案变成一条可测量的事实。
 *
 * 分工是硬的：
 *   - **工具负责挑、给命令、验**：挑哪些函数值得看、给出取证要跑的命令、接收结果
 *   - **agent 负责跑和写**：用 shell 查证，说出这个函数在算什么
 *   - **判定还是工具做**：agent 的结论必须表达成一条事实（path-exists / text-in-file /
 *     json-has-key / import-edge，或能跑的命令）。表达不成的进 notes，永不上色
 *
 * 为什么要最后这条：如果让 agent 直接说「这里没问题」，就等于又加了一层不可核对的
 * 判断，和这个项目想解决的问题是同一件事。**推断可以是模糊的，判定不行。**
 *
 * 状态写在 .laminae/derive/state.json，断点可续。已接受的写进 .laminae/ideas.json，
 * source 记为 `inferred:<文件>#<函数>`，和人工写的区分开。
 */
import fs from "node:fs";
import path from "node:path";
import { git } from "./gitutil.ts";
import { parseIdeas } from "./ideas-core.ts";
import { isCodeFile, isTestFile } from "./imports.ts";
import { IDEAS_PATH, WORK_DIR } from "./paths.ts";
import { BlobReader } from "./scan.ts";
import { pickModule } from "./syntax-registry.ts";

export const DERIVE_DIR = path.join(WORK_DIR, "derive");
export const STATE_PATH = path.join(DERIVE_DIR, "state.json");
export const NOTES_PATH = path.join(DERIVE_DIR, "notes.json");

const DEFAULT_BATCH = 15;
const DEFAULT_MAX = 300;

/** 名字像在算东西的，优先看。判断错的代价最大 */
const FORMULA_NAME =
  /(calc|compute|total|subtotal|sum|rate|ratio|percent|bonus|score|price|amount|cost|fee|tax|weight|average|avg|median|count|format|fmt|round|convert|normalize|validate|derive|aggregate|prorate|recalc)/i;

export interface Candidate {
  id: string;
  file: string;
  function: string;
  line: number;
  /** 函数体有多少行 */
  lines: number;
  /** 这个名字在全仓库出现多少次（含定义本身） */
  hits: number;
  why: string;
}

export interface DeriveState {
  schemaVersion: 1;
  /** 已经排好序的完整计划。生成一次，之后只按批次切片 */
  plan: Candidate[];
  nextBatch: number;
  batchSize: number;
  accepted: string[];
  noted: string[];
}

function readState(): DeriveState | null {
  if (!fs.existsSync(STATE_PATH)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as DeriveState;
    if (s.schemaVersion !== 1 || !Array.isArray(s.plan)) return null;
    return s;
  } catch {
    return null;
  }
}

export function readStateOrNull(): DeriveState | null {
  return readState();
}

function writeState(s: DeriveState): void {
  fs.mkdirSync(DERIVE_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(s, null, 2)}\n`, "utf8");
}

/**
 * 把 HEAD 上的所有函数摊平，按「错了损失最大」排序。
 *
 * 排序依据（都能机械算出来，不靠猜）：
 *   1. 名字像在算东西：calc / total / rate / format …
 *   2. 名字在全仓库出现多少次（入度的近似）—— 被调用得越多越值得看
 *   3. 函数体行数 —— 一行函数没什么可推的
 */
export async function collectCandidates(max = DEFAULT_MAX): Promise<Candidate[]> {
  const out = git(["ls-tree", "-r", "HEAD"]);
  if (out === null) throw new Error("读不到 HEAD，先确认这是一个 git 仓库");

  const files = new Map<string, string>();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const oid = line.slice(0, tab).split(" ")[2] ?? "";
    const file = line.slice(tab + 1);
    // 测试文件里的函数不进计划：问「测试辅助函数该做什么」没有产出
    if (isCodeFile(file) && !isTestFile(file)) files.set(file, oid);
  }
  if (files.size === 0) return [];

  const reader = new BlobReader();
  let texts: Map<string, string | null>;
  try {
    texts = await reader.read([...new Set(files.values())]);
  } finally {
    reader.close();
  }

  const byFile = new Map<string, string>();
  for (const [file, oid] of files) {
    const t = texts.get(oid);
    if (typeof t === "string") byFile.set(file, t);
  }

  /** 名字出现在多少个文件里。用来剔掉 normalize / validate 这类通用词 */
  const filesWithName = new Map<string, number>();
  const totalHits = new Map<string, number>();
  for (const text of byFile.values()) {
    const seen = new Set<string>();
    for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
      const n = m[1]!;
      totalHits.set(n, (totalHits.get(n) ?? 0) + 1);
      if (!seen.has(n)) {
        seen.add(n);
        filesWithName.set(n, (filesWithName.get(n) ?? 0) + 1);
      }
    }
  }

  // 通用词门槛：出现在超过 10% 的代码文件里，就不是「某个函数的名字」，是语言的常用词
  const genericCap = Math.max(3, Math.floor(byFile.size * 0.1));
  const isGeneric = (name: string): boolean => (filesWithName.get(name) ?? 0) > genericCap;

  const raw: Candidate[] = [];
  for (const [file, text] of byFile) {
    const mod = pickModule(text);
    for (const fn of mod.findFunctions(text)) {
      if (!fn.name || fn.reason !== null) continue;
      if (fn.name.length < 3) continue;
      if (isGeneric(fn.name)) continue;
      const line = text.slice(0, fn.start).split("\n").length;
      const body = text.slice(fn.start, fn.end);
      const lines = body.split("\n").length;
      if (lines < 3) continue;
      const hits = totalHits.get(fn.name) ?? 1;
      const spread = filesWithName.get(fn.name) ?? 1;
      const formula = FORMULA_NAME.test(fn.name);
      if (!formula && hits < 3 && lines < 12) continue;
      raw.push({
        id: `${file}#${fn.name}`,
        file,
        function: fn.name,
        line,
        lines,
        hits,
        why: [
          formula ? "名字像在算东西" : null,
          spread >= 2 ? `被 ${spread} 个文件提到` : null,
          lines >= 12 ? `函数体 ${lines} 行` : null,
        ]
          .filter(Boolean)
          .join("，"),
      });
    }
  }

  const score = (c: Candidate): number =>
    (FORMULA_NAME.test(c.function) ? 1000 : 0) + Math.min(c.hits, 40) * 20 + Math.min(c.lines, 80);
  raw.sort((a, b) => score(b) - score(a) || a.file.localeCompare(b.file) || a.line - b.line);
  return raw.slice(0, max);
}

/** 取计划；没有就现算一份并落盘 */
export async function ensurePlan(batchSize = DEFAULT_BATCH, max = DEFAULT_MAX): Promise<DeriveState> {
  const existing = readState();
  if (existing) return existing;
  const plan = await collectCandidates(max);
  const s: DeriveState = { schemaVersion: 1, plan, nextBatch: 0, batchSize, accepted: [], noted: [] };
  writeState(s);
  return s;
}

export interface BatchItem extends Candidate {
  context: string;
  hints: string[];
}

export interface Batch {
  batch: number;
  of: number;
  /** 还剩多少个函数没看 */
  remaining: number;
  items: BatchItem[];
}

const sliceCommand = (file: string, line: number, lines: number): string =>
  `git show HEAD:${file} | sed -n '${Math.max(1, line - 4)},${line + lines}p'`;

/** 第 n 批（从 0 开始）要做什么 */
export function batchAt(state: DeriveState, n: number): Batch {
  const size = state.batchSize > 0 ? state.batchSize : DEFAULT_BATCH;
  const of = Math.max(1, Math.ceil(state.plan.length / size));
  const items = state.plan.slice(n * size, n * size + size).map((c) => ({
    ...c,
    context: sliceCommand(c.file, c.line, c.lines),
    hints: [`git grep -n "${c.function}" -- .`, `git log --oneline -3 -- ${c.file}`],
  }));
  return { batch: n, of, remaining: Math.max(0, state.plan.length - n * size), items };
}

export interface AcceptResult {
  accepted: number;
  noted: number;
  rejected: { id: string; reason: string }[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 收一批结果。
 *
 * 每条结果必须带三样：id（在计划里）、text（这个函数在做什么）、fact（怎么量）。
 * **fact 是最硬的门槛**：表达不成一条可测量事实的，进 notes，不进 ideas。
 */
export function acceptBatch(raw: unknown, state: DeriveState, batchNo: number): { state: DeriveState; result: AcceptResult } {
  if (!isObj(raw)) throw new Error("结果文件必须是对象：{ batch, results, notes }");
  const results = raw["results"];
  const notes = raw["notes"];
  if (results !== undefined && !Array.isArray(results)) throw new Error("results 必须是数组");
  if (notes !== undefined && !Array.isArray(notes)) throw new Error("notes 必须是数组");

  const known = new Set(state.plan.map((c) => c.id));
  const batchIds = new Set(batchAt(state, batchNo).items.map((c) => c.id));

  const incoming: unknown[] = [];
  const rejected: AcceptResult["rejected"] = [];
  let notedNow = 0;

  for (const item of (results ?? []) as unknown[]) {
    if (!isObj(item)) {
      rejected.push({ id: "(未命名)", reason: "不是对象" });
      continue;
    }
    const id = typeof item["id"] === "string" ? item["id"] : "";
    if (!known.has(id)) {
      rejected.push({ id: id || "(未命名)", reason: "不在计划里" });
      continue;
    }
    if (!batchIds.has(id)) {
      rejected.push({ id, reason: `不属于第 ${batchNo} 批` });
      continue;
    }
    const evidence = item["evidence"];
    if (!Array.isArray(evidence) || evidence.filter((e) => typeof e === "string" && e.trim() !== "").length === 0) {
      rejected.push({ id, reason: "没有证据命令。推断必须能指出你是用哪条命令看出来的" });
      continue;
    }
    const target = typeof item["target"] === "string" ? item["target"] : "";
    const cand = state.plan.find((c) => c.id === id)!;
    incoming.push({
      id: `inferred-${id.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
      text: item["text"],
      target,
      fact: item["fact"],
      expect: item["expect"],
      boundary: item["boundary"],
      source: `inferred:${cand.file}#${cand.function}`,
    });
  }

  // 用 ideas.json 的校验器验一遍，不合格的逐条退回
  const ok: unknown[] = [];
  for (const item of incoming) {
    try {
      parseIdeas([item]);
      ok.push(item);
    } catch (e) {
      rejected.push({ id: (item as Record<string, unknown>)["id"] as string, reason: (e as Error).message });
    }
  }

  // 写回 ideas.json，和已有的合并
  let existing: unknown[] = [];
  if (fs.existsSync(IDEAS_PATH)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(IDEAS_PATH, "utf8"));
      existing = Array.isArray(parsed) ? parsed : [];
      parseIdeas(existing);
    } catch (e) {
      throw new Error(`${IDEAS_PATH} 现在就不合法，先修好再收推断结果：${(e as Error).message}`);
    }
  }
  const ids = new Set(existing.map((e) => (isObj(e) ? String(e["id"] ?? "") : "")));
  const added = ok.filter((o) => !ids.has((o as Record<string, unknown>)["id"] as string));
  if (added.length > 0) {
    fs.mkdirSync(path.dirname(IDEAS_PATH), { recursive: true });
    fs.writeFileSync(IDEAS_PATH, `${JSON.stringify([...existing, ...added], null, 2)}\n`, "utf8");
  }

  // 笔记：写不成事实的推断留在这里，永远不上色
  const allNotes: unknown[] = fs.existsSync(NOTES_PATH)
    ? (JSON.parse(fs.readFileSync(NOTES_PATH, "utf8")) as unknown[])
    : [];
  for (const n of (notes ?? []) as unknown[]) {
    if (!isObj(n)) continue;
    const id = typeof n["id"] === "string" ? n["id"] : "";
    if (!known.has(id)) continue;
    allNotes.push({ ...n, batch: batchNo, at: new Date().toISOString() });
    notedNow++;
  }
  for (const r of rejected) {
    allNotes.push({ id: r.id, why: r.reason, batch: batchNo, at: new Date().toISOString(), rejected: true });
  }
  if (allNotes.length > 0) {
    fs.mkdirSync(DERIVE_DIR, { recursive: true });
    fs.writeFileSync(NOTES_PATH, `${JSON.stringify(allNotes, null, 2)}\n`, "utf8");
  }

  // 这一批里被处理过的计划 id：接受的不算「笔记」，其余（写了笔记或被退回的）都算
  const handled = new Set<string>();
  for (const r of (results ?? []) as unknown[]) if (isObj(r) && typeof r["id"] === "string") handled.add(r["id"] as string);
  for (const n of (notes ?? []) as unknown[]) if (isObj(n) && typeof n["id"] === "string") handled.add(n["id"] as string);

  const acceptedPlanIds = new Set(
    added.map((a) => String((a as Record<string, unknown>)["source"] ?? "").replace(/^inferred:/, "")),
  );
  const next: DeriveState = {
    ...state,
    nextBatch: Math.max(state.nextBatch, batchNo + 1),
    accepted: [...new Set([...state.accepted, ...added.map((a) => (a as Record<string, unknown>)["id"] as string)])],
    noted: [...new Set([...state.noted, ...[...handled].filter((i) => !acceptedPlanIds.has(i))])],
  };
  writeState(next);
  return { state: next, result: { accepted: added.length, noted: notedNow, rejected } };
}

export function readNotes(): unknown[] {
  if (!fs.existsSync(NOTES_PATH)) return [];
  try {
    const v: unknown = JSON.parse(fs.readFileSync(NOTES_PATH, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
