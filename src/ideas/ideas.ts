#!/usr/bin/env node
/**
 * laminae —— 想法、边界与线索
 *
 *   node <laminae>/src/ideas.ts      在要核验的项目目录下运行
 *
 * 两件事，都只读 git 对象：
 *   1. 读 .laminae/ideas.json（选填），逐 commit 核对每条想法或边界的证据满不满足
 *   2. 提取路线图清单（- [ ]）与代码里的 TODO，作为「尚未确认的线索」，并沿历史抽样看数量趋势
 *
 * 产物：.laminae/data/ideas-timeline.json、candidates.json
 */
import fs from "node:fs";
import path from "node:path";
import {
  CHECKLIST_PATTERN,
  TODO_EXCLUDES,
  TODO_PATTERN,
  collectChecklist,
  collectTodos,
  sampleIndexes,
} from "./candidates.ts";
import { assertBoundRepo, LOG_ARGS, VERBOSE } from "../core/config.ts";
import { factFiles } from "../measure/facts.ts";
import { ensureExcluded } from "../core/exclude.ts";
import { commitShas, git, openTrees } from "../core/gitutil.ts";
import { describeIdea, evalEdge, ideaStateAt, isEdge, parseIdeas, summarizeIdea } from "./ideas-core.ts";
import type { EdgeEval, EdgeScan } from "./ideas-core.ts";
import { DATA_DIR, IDEAS_PATH } from "../core/paths.ts";
import { ImportScanner } from "../layers/scan.ts";
import type { Candidates, IdeaState, IdeaTimeline } from "../core/types.ts";

assertBoundRepo();
ensureExcluded();

const shas = commitShas(LOG_ARGS);
if (shas.length === 0) {
  console.error("取不到提交历史（仓库里没有提交？）");
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ── 1. 想法与边界 ── */

const timelineFile = path.join(DATA_DIR, "ideas-timeline.json");

if (!fs.existsSync(IDEAS_PATH)) {
  fs.rmSync(timelineFile, { force: true }); // 别让上一次留下的旧结果混进报告
  console.log(`没有 ${IDEAS_PATH}，跳过想法与边界（要用的话见 SKILL.md）`);
} else {
  let defs;
  try {
    // 容忍 BOM（Windows PowerShell 5 写出的 UTF-8）
    defs = parseIdeas(JSON.parse(fs.readFileSync(IDEAS_PATH, "utf8").replace(/^\uFEFF/, "")));
  } catch (e) {
    console.error(`${IDEAS_PATH} 读不了：${(e as Error).message}`);
    process.exit(1);
  }

  const states: IdeaState[][] = defs.map(() => []);
  const trees = openTrees();
  const ideaFiles = [...new Set(defs.flatMap((d) => (isEdge(d.fact) ? [] : factFiles(d.fact))))];
  /** 引用边界在 HEAD 上的求值结果（符合的引用、判不了的原因） */
  const headEdge = new Map<number, EdgeEval>();

  // 只有声明了引用边界才需要扫描代码文件之间的引用（和画引用图用的是同一份扫描）
  const scanner = defs.some((d) => isEdge(d.fact)) ? new ImportScanner() : null;

  for (const [i, sha] of shas.entries()) {
    const tree = trees.at(sha, () => ideaFiles);
    const scan = scanner ? await scanner.scan(sha) : null;
    const edgeScan: EdgeScan | null = scan ? { allFiles: [...scan.all.keys()], edges: scan.graph.edges, unresolved: scan.unresolved } : null;
    defs.forEach((d, k) => {
      if (isEdge(d.fact)) {
        const r = evalEdge({ fact: d.fact, expect: d.expect }, edgeScan!);
        states[k]!.push(r.state);
        if (i === shas.length - 1) headEdge.set(k, r);
      } else {
        states[k]!.push(ideaStateAt(d, tree));
      }
    });
    const every = VERBOSE ? 10 : 500;
    if ((i + 1) % every === 0 && i + 1 < shas.length) console.log(`  想法已测 ${i + 1}/${shas.length}`);
  }
  scanner?.close();

  const out: IdeaTimeline[] = defs.map((d, k) => {
    const st = states[k]!;
    const e = headEdge.get(k);
    return {
      id: d.id,
      text: d.text,
      boundary: d.boundary,
      expect: d.expect,
      target: d.target,
      evidence: isEdge(d.fact) ? [] : factFiles(d.fact),
      ...(isEdge(d.fact) ? { edge: { from: d.fact.from, to: d.fact.to } } : {}),
      ...(e ? { hits: e.hits.slice(0, 30), hitsTotal: e.hits.length, unsure: e.unsure } : {}),
      check: describeIdea(d),
      source: d.source,
      states: st,
      atHead: st.at(-1) ?? 3,
      ...summarizeIdea(st),
    };
  });
  fs.writeFileSync(timelineFile, JSON.stringify(out) + "\n", "utf8");

  const ideas = out.filter((o) => !o.boundary);
  const bounds = out.filter((o) => o.boundary);
  console.log(`想法 ${ideas.length} 条：HEAD 上已完成 ${ideas.filter((o) => o.atHead === 0).length}，未完成 ${ideas.filter((o) => o.atHead === 1).length}`);
  console.log(`边界 ${bounds.length} 条：HEAD 上守住 ${bounds.filter((o) => o.atHead === 0).length}，越界 ${bounds.filter((o) => o.atHead === 1).length}`);
  const back = out.filter((o) => o.regressions > 0);
  if (back.length) console.log(`  做完又退回去过：${back.map((o) => o.id).join("、")}`);
  const blind = out.filter((o) => o.atHead === 3);
  if (blind.length) console.log(`  HEAD 上测不出来：${blind.map((o) => o.id).join("、")}（证据所在的文件读不到，或引用图判不了，原因见页面）`);
}

/* ── 2. 线索 ── */

const head = shas.at(-1)!;
const checklist = collectChecklist(head, git(["grep", "-I", "-n", "-E", CHECKLIST_PATTERN, head, "--", "*.md"]));
const todos = collectTodos(head, git(["grep", "-I", "-n", "-E", TODO_PATTERN, head, "--", ".", ...TODO_EXCLUDES]));

/** 某个 commit 上三种线索各有多少条 */
function countsAt(sha: string): { todo: number; open: number; done: number } {
  const lines = (out: string | null): string[] => (out ?? "").split("\n").filter(Boolean);
  const todo = lines(git(["grep", "-I", "-E", TODO_PATTERN, sha, "--", ".", ...TODO_EXCLUDES])).length;
  const list = lines(git(["grep", "-I", "-E", CHECKLIST_PATTERN, sha, "--", "*.md"]));
  const done = list.filter((l) => /\[[xX]\]/.test(l)).length;
  return { todo, open: list.length - done, done };
}

const at = sampleIndexes(shas.length, 40);
const trend: Candidates["trend"] = { at, todo: [], open: [], done: [] };
for (const i of at) {
  const c = countsAt(shas[i]!);
  trend.todo.push(c.todo);
  trend.open.push(c.open);
  trend.done.push(c.done);
}

const CAP = 40;
const candidates: Candidates = {
  checklist: {
    open: checklist.filter((c) => !c.done).length,
    done: checklist.filter((c) => c.done).length,
    items: checklist.slice(0, CAP),
  },
  todos: { total: todos.length, items: todos.slice(0, CAP) },
  trend,
};
const candFile = path.join(DATA_DIR, "candidates.json");
fs.writeFileSync(candFile, JSON.stringify(candidates) + "\n", "utf8");

console.log(
  `线索：路线图清单 ${checklist.length} 项（未勾 ${candidates.checklist.open}，已勾 ${candidates.checklist.done}），代码里 TODO 类标记 ${todos.length} 处`,
);
console.log("  这些只是线索：没勾不等于没做，TODO 也可能已过时。确认过的写进 ideas.json 才算数");
console.log(`\n已写入 ${candFile}`);
