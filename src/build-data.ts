#!/usr/bin/env node
/**
 * laminae —— 构建期数据处理
 *
 *   node <laminae>/src/build-data.ts      在要核验的项目目录下运行
 *
 * 把 .laminae/data/timeline.json 加工成可以直接内联进 HTML 的形态：
 *   - 补上每条说法在 HEAD 上的逐字原文
 *   - 补上每个 commit 的墙上时间与相对小时数
 *   - 把 hiatus 的 commit 数与小时数都算好
 *   - 汇总数字算好
 *
 * 前端不做任何计算，只渲染。
 *
 * 产物：.laminae/runs/<id>/payload.json
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assertBoundRepo, REPO, REPO_NAME, REPO_URL, LOG_ARGS } from "./config.ts";
import { loadClaims } from "./claims.ts";
import { DEFAULT_TOLERANCE } from "./compare.ts";
import type { Compare } from "./compare.ts";
import { describeFact, factFiles } from "./facts.ts";
import { CLAIMS_PATH, DATA_DIR, PAYLOAD_PATH, RUN_DIR } from "./paths.ts";
import { didRealityMove, isCensored } from "./classify.ts";
import { joinLayers } from "./layers-core.ts";
import type { LayersData } from "./layers-core.ts";
import { kaplanMeier, summarizeClosure } from "./survival.ts";
import type { Candidates, ClaimDef, ClaimTimeline, Commit, GraphData, IdeaTimeline, Impact, Outcome, Payload, Run, State, Summary, VerbatimRun } from "./types.ts";

assertBoundRepo();

const DATA = DATA_DIR;

interface TimelineRun {
  state: State;
  from: number;
  to: number;
  len: number;
  outcome: Outcome;
}
interface TimelineResult {
  id: string;
  impact?: Impact;
  compare?: Compare;
  tolerance?: number;
  inexact?: string | null;
  label: string;
  file: string;
  states: State[];
  kind: "number" | "exists" | "holds" | "stable";
  claimed: (number | null)[];
  claimedText: (string | null)[];
  actual: (number | null)[];
  verbatimByCommit: (string | null)[];
  falseRuns: TimelineRun[];
  outcomes: Outcome[];
  bornFalse: boolean;
  atHead: State;
  headClaimed: number | null;
  headActual: number | null;
  totalFalse: number;
}
interface Timeline {
  commitCount: number;
  commits: { short: string; date: string; subject: string }[];
  results: TimelineResult[];
}

const timeline = JSON.parse(fs.readFileSync(path.join(DATA, "timeline.json"), "utf8")) as Timeline;
let claims: ClaimDef[];
try {
  claims = loadClaims(CLAIMS_PATH);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

/* ── 1. commit 时间戳 ── */

const logOut = execFileSync("git", ["-C", REPO, "log", ...LOG_ARGS, "--format=%H%x1f%aI%x1f%s"], {
  encoding: "utf8",
  maxBuffer: 1 << 26,
});
const meta = logOut
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    const [sha = "", iso = "", subject = ""] = l.split("\x1f");
    return { sha, iso, t: new Date(iso).getTime(), subject };
  });

const t0 = meta[0]?.t ?? 0;
const H = 3600e3;

const commits: Commit[] = timeline.commits.map((c, i) => ({
  i,
  sha: meta[i]?.sha ?? "",
  short: c.short,
  date: c.date,
  subject: meta[i]?.subject ?? c.subject,
  hours: +(((meta[i]?.t ?? t0) - t0) / H).toFixed(2),
}));
const spanHours = +(((meta.at(-1)?.t ?? t0) - t0) / H).toFixed(2);

/* ── 2. 每条说法在 HEAD 上的逐字原文与行号 ── */

function headOf(claim: ClaimDef): { text: string; line: number } {
  try {
    const body = execFileSync("git", ["-c", "core.quotepath=false", "-C", REPO, "show", `HEAD:${claim.file}`], {
      encoding: "utf8",
      maxBuffer: 1 << 26,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const re = new RegExp(claim.locator);
    const lines = body.split("\n");
    for (const [i, line] of lines.entries()) if (re.test(line)) return { text: line.trim(), line: i + 1 };
  } catch {
    /* 文件不存在 */
  }
  return { text: "（HEAD 上找不到匹配行）", line: 0 };
}
const headInfo = new Map(claims.map((c) => [c.id, headOf(c)]));

/**
 * HEAD 上的全部文件。只用来回答一个问题：把捕获到的文本去掉首尾标点之后，
 * 有没有一个同名的文件确实存在。存在就说明多半是 locator 的捕获组多带了字符。
 */
const HEAD_PATHS = ((): Set<string> => {
  try {
    const out = execFileSync("git", ["-c", "core.quotepath=false", "-C", REPO, "ls-tree", "-r", "--name-only", "HEAD"], {
      encoding: "utf8",
      maxBuffer: 1 << 26,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(out.split("\n").filter(Boolean));
  } catch {
    return new Set<string>();
  }
})();

/** 捕获到的文本去掉首尾标点（反引号、引号、括号、逗号、句号、冒号） */
function edgeTrimmed(s: string): string {
  return s.replace(/^[\s`'"([{]+/, "").replace(/[\s`'")\]},.;:]+$/, "");
}

/* ── 3. 组装 ── */

function toRun(
  run: TimelineRun,
  outcome: Outcome,
  states: State[],
  claimed: (number | null)[],
  actual: (number | null)[],
  bornFalse: boolean,
): Run {
  const after = run.to + 1;
  const at = Math.min(after, commits.length - 1);

  return {
    from: run.from,
    to: run.to,
    len: run.len,
    hoursFrom: commits[run.from]?.hours ?? 0,
    hoursTo: commits[at]?.hours ?? 0,
    hours: +(((commits[at]?.hours ?? 0) - (commits[run.from]?.hours ?? 0))).toFixed(2),
    outcome,
    // 右删失的定义见 classify.ts 的 isCensored
    censored: isCensored(run, states),
    bornFalse,
    realityMoved: didRealityMove(run, actual),
    claimedAtStart: claimed[run.from] ?? null,
    actualAtStart: actual[run.from] ?? null,
    actualAtEnd: actual[run.to] ?? null,
    claimedAfter: after < states.length ? (claimed[after] ?? null) : null,
  };
}

/**
 * 把逐 commit 的措辞折成行程编码。
 *
 * 同一行原文在整个历史上通常只变过一两次，逐 commit 存会把同一个字符串
 * 重复几十遍（实测占掉 127 KB）。折成区间之后只剩几 KB。
 */
function toVerbatimRuns(lines: (string | null)[]): VerbatimRun[] {
  const runs: VerbatimRun[] = [];
  for (const [i, text] of lines.entries()) {
    const last = runs.at(-1);
    if (last && last.text === (text ?? null)) last.to = i;
    else runs.push({ from: i, to: i, text: text ?? null });
  }
  return runs;
}

const outClaims: ClaimTimeline[] = timeline.results.map((r) => {
  const def = claims.find((c) => c.id === r.id);
  const head = headInfo.get(r.id) ?? { text: "", line: 0 };
  const verbatimRuns = toVerbatimRuns(r.verbatimByCommit ?? []);
  // locator 在整段历史里一次都没匹配到。分不清是文档没写还是规则写错，只把这件事标出来。
  // 注意：永不匹配时 verbatimRuns 不是空的，而是每一段的 text 都是 null
  const ruleMiss = verbatimRuns.length === 0 || verbatimRuns.every((x) => x.text === null);
  // 引用型说法判假，但捕获文本去掉首尾标点之后文件确实存在 —— 多半是捕获组多带了字符
  const capturedHead = (r.claimedText ?? []).at(-1) ?? "";
  const trimmed = typeof capturedHead === "string" ? edgeTrimmed(capturedHead) : "";
  const captureHint =
    r.kind === "exists" && r.atHead === 1 && trimmed !== "" && trimmed !== capturedHead && HEAD_PATHS.has(trimmed)
      ? trimmed
      : null;
  return {
    id: r.id,
    impact: r.impact ?? "normal",
    inexact: r.compare === undefined || r.compare === "eq" ? (r.inexact ?? null) : null,
    compare: r.compare ?? "eq",
    tolerance: r.tolerance ?? DEFAULT_TOLERANCE,
    label: r.label,
    file: def?.file ?? r.file,
    asserts: def ? describeFact(def.fact) : "",
    locator: def?.locator ?? "",
    verbatim: head.text,
    line: head.line,
    verbatimRuns,
    ruleMiss,
    captureHint,
    // 写下即假的那一段一定是第一段假段
    runs: r.falseRuns.map((run, k) =>
      toRun(run, r.outcomes[k] ?? "anomaly", r.states, r.claimed, r.actual, r.bornFalse && k === 0),
    ),
    states: r.states,
    kind: r.kind ?? "number",
    claimed: r.claimed,
    claimedText: r.claimedText ?? [],
    actual: r.actual,
    bornFalse: r.bornFalse,
    atHead: r.atHead,
    headClaimed: r.headClaimed,
    headActual: r.headActual,
    totalFalse: r.totalFalse,
    evidence: def ? factFiles(def.fact) : [],
  };
});

/* ── 4. 汇总 ── */

const allRuns = outClaims.flatMap((c) => c.runs);

const outcomes: Partial<Record<Outcome, number>> = {};
for (const r of allRuns) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;

// hiatus 的中位数用 Kaplan-Meier 估计，样本是「先真后假」的假段；仍挂着的段按右删失处理。
// 写下即假的段不进样本：它量的是「文档一开始就写错了多久」，不是「真的说法漂移后挂了多久」。
const drifted = allRuns.filter((r) => !r.bornFalse);
const kmCommits = kaplanMeier(drifted.map((r) => ({ time: r.len, event: !r.censored })));
const kmHours = kaplanMeier(drifted.map((r) => ({ time: r.hours, event: !r.censored })));

const summary: Summary = {
  claimCount: outClaims.length,
  commitCount: commits.length,
  spanHours,
  everFalse: outClaims.filter((c) => c.totalFalse > 0).length,
  falseAtHead: outClaims.filter((c) => c.atHead === 1).length,
  bornFalse: outClaims.filter((c) => c.bornFalse).length,
  drifted: outClaims.filter((c) => !c.bornFalse && c.totalFalse > 0).length,
  runCount: allRuns.length,
  censored: allRuns.filter((r) => r.censored).length,
  survival: {
    n: kmCommits.n,
    events: kmCommits.events,
    censored: kmCommits.censored,
    medianCommits: kmCommits.median,
    medianHours: kmHours.median === null ? null : +kmHours.median.toFixed(1),
  },
  outcomes,
  closure: summarizeClosure(outcomes),
};

/* ── 5. 可选的几块：引用关系、想法与边界、线索。前面的步骤没产出就没有 ── */

function readOptional<T>(name: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8")) as T;
  } catch {
    return undefined;
  }
}
const graph = readOptional<GraphData>("graph.json");
const ideas = readOptional<IdeaTimeline[]>("ideas-timeline.json");
const candidates = readOptional<Candidates>("candidates.json");
const layersRaw = readOptional<LayersData>("layers.json");

// 层与层对账：上层（说法、想法）成立，但支撑它的文件是空壳；以及没人引用也没人提到的模块
const layers = layersRaw
  ? joinLayers(layersRaw, [
      ...outClaims.map((c) => ({
        kind: "claim" as const,
        label: c.label,
        states: c.states,
        files: c.evidence,
        compare: c.compare,
        claimed: c.claimed,
        actual: c.actual,
        verbatim: c.verbatim,
      })),
      ...(ideas ?? []).map((it) => ({
        kind: "idea" as const,
        label: it.text,
        states: it.states,
        // 引用边界不指向单个文件；其余想法把它的证据文件和目标都算上
        files: it.edge ? [] : [...it.evidence, it.target],
        blind: it.edge ? (it.unsure ?? null) : null,
      })),
    ])
  : undefined;

const payload: Payload = {
  title: "laminae",
  subtitle: `${timeline.results.length} 条说法 · ${commits.length} 个 commit · ${spanHours} 小时 · ${REPO_NAME}`,
  repo: REPO_NAME,
  repoUrl: REPO_URL,
  generatedAt: new Date().toISOString(),
  commits,
  claims: outClaims,
  summary,
  ...(graph && graph.nodes.length > 0 ? { graph } : {}),
  ...(ideas && ideas.length > 0 ? { ideas } : {}),
  ...(candidates ? { candidates } : {}),
  ...(layers ? { layers } : {}),
};

fs.mkdirSync(RUN_DIR, { recursive: true });
fs.writeFileSync(PAYLOAD_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");

console.log("构建期处理完成");
console.log(`  commit ${commits.length} 个，跨度 ${spanHours} 小时`);
console.log(`  说法 ${outClaims.length} 条，假段 ${allRuns.length} 段`);
const sv = summary.survival;
console.log(
  sv.medianCommits === null
    ? `  中位 hiatus 无法估计（${sv.n} 段中 ${sv.censored} 段仍挂着，生存曲线没降到 50%）`
    : `  中位 hiatus ${sv.medianCommits} commit / ${sv.medianHours} 小时（Kaplan-Meier，${sv.n} 段，${sv.censored} 段右删失）`,
);
console.log(`  HEAD 仍为假 ${summary.falseAtHead} 条，其中写下即假 ${summary.bornFalse} 条`);
if (payload.graph) console.log(`  引用关系：${payload.graph.nodes.length} 个节点、${payload.graph.edges.length} 条边`);
if (payload.ideas) console.log(`  想法与边界：${payload.ideas.length} 条`);
if (layers) {
  const unmet = layers.contracts.reduce((s, c) => s + c.unmet.length, 0);
  const fake = layers.contracts.reduce((s, c) => s + c.fake.length, 0);
  console.log(`  层与层对账：假实现 ${layers.hollow.length + fake} 处，被盖住 ${layers.covers.length} 处，有代码但未证实 ${layers.unproven.length} 处，孤立模块 ${layers.orphans.length} 个，契约对不上 ${unmet} 处`);
}
console.log(`\n已写入 ${PAYLOAD_PATH}`);
