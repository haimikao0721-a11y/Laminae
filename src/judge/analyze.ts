#!/usr/bin/env node
/**
 * laminae —— 时序分析器
 *
 *   node <laminae>/src/analyze.ts      在要核验的项目目录下运行
 *
 * 读 .laminae/data/facts.json 与 docs-by-commit.json，对每条说法在每个 commit 上判定真假，
 * 算出 hiatus（变假后挂了多久）与 outcome（怎么收场的），并汇总分布。
 *
 * 产物：.laminae/data/timeline.json
 */
import fs from "node:fs";
import path from "node:path";
import { loadClaims } from "../measure/claims.ts";
import { isHold, isReferential } from "../measure/facts.ts";
import { alignToBaseline } from "../measure/observe.ts";
import { CLAIMS_PATH, DATA_DIR } from "../core/paths.ts";
import { ABSENT, FALSE, TRUE, UNMEASURED, OUTCOME_TEXT } from "../core/types.ts";
import type { ClaimDef, MeasuredCommit, Outcome, State } from "../core/types.ts";
import { assertBoundRepo, VERBOSE } from "../core/config.ts";
import { comparePrefix, inexactWording } from "../measure/compare.ts";
import { classify, isCensored, judgeState, parseClaimedNumber, segment } from "./classify.ts";
import type { Judged } from "./classify.ts";
import { kaplanMeier } from "./survival.ts";

assertBoundRepo();

const DATA = DATA_DIR;

interface FactsFile {
  repo: string;
  generatedAt: string;
  commitCount: number;
  commits: MeasuredCommit[];
}
interface DocBody {
  sha: string;
  short: string;
  /** 文件路径 → 该 commit 上的正文；读不到的文件为空串 */
  files: Record<string, string>;
}

const factsFile = JSON.parse(fs.readFileSync(path.join(DATA, "facts.json"), "utf8")) as FactsFile;
const docBodies = JSON.parse(fs.readFileSync(path.join(DATA, "docs-by-commit.json"), "utf8")) as DocBody[];
let claims: ClaimDef[];
try {
  claims = loadClaims(CLAIMS_PATH);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const commits = factsFile.commits;
const docOf = new Map(docBodies.map((d) => [d.sha, d]));

/* ── 逐 commit 判定 ── */

function judge(claim: ClaimDef): Judged & { texts: (string | null)[]; inexact: string | null } {
  const re = new RegExp(claim.locator);
  const referential = isReferential(claim.fact);
  const hold = isHold(claim.fact);
  const stable = claim.fact.type === "output-unchanged";
  const states: State[] = [];
  const claimed: (number | null)[] = [];
  const actual: (number | null)[] = [];
  const lines: (string | null)[] = [];
  /** 引用型、测试、输出差分：文档里捕获到的文本 */
  const texts: (string | null)[] = [];
  /** 引用文本或口径词 → 编号，同一段文本编号相同，供结局判定看声称有没有改过 */
  const textIds = new Map<string, number>();
  /** 测试 / 不变量：说法文件（或 fact.source）正文 → 编号。改断言会换编号，改被测代码不会 */
  const bodyIds = new Map<string, number>();
  const aligned = stable
    ? alignToBaseline(
        commits.map((c) => {
          const body = docOf.get(c.sha)?.files[claim.file] ?? "";
          const m = body ? re.exec(body) : null;
          return m?.[1]?.trim() || null;
        }),
        commits.map((c) => c.values[claim.id] ?? null),
      )
    : null;
  let commitAt = 0;
  /** 严格相等的数值说法，文档措辞里有「N+」「约」「至少」这类字样：取最近一次，提醒使用者 */
  let inexact: string | null = null;

  for (const c of commits) {
    const doc = docOf.get(c.sha);
    if (!doc || !(claim.file in doc.files)) {
      // 测量时没有读过这个文件，说明 data/ 与 claims.json 不同步，不能悄悄当作「还不存在」
      console.error(`${claim.id}：测量数据里没有 ${claim.file}。claims.json 改过，请重新运行 measure.ts`);
      process.exit(1);
    }
    if (!(claim.id in c.values)) {
      console.error(`${claim.id}：测量数据里没有这条说法的事实。claims.json 改过，请重新运行 measure.ts`);
      process.exit(1);
    }
    const body = doc.files[claim.file];
    const m = body ? re.exec(body) : null;
    const raw = m?.[1]?.trim();

    // 数值型：文档写的数。引用型断言「它存在」。测试、不变量、输出差分断言「应该成立」，都恒为 1
    let want: number | null;
    if (referential || hold || stable) {
      want = raw ? 1 : null;
    } else {
      want = m?.[1] === undefined ? null : parseClaimedNumber(m[1]);
    }

    // 文档里找不到，或找到的不是个数（引用型：捕获为空）：当作该 commit 上还没有这条说法
    if (m === null || want === null) {
      states.push(ABSENT);
      claimed.push(null);
      actual.push(null);
      lines.push(null);
      texts.push(null);
      commitAt++;
      continue;
    }

    // 把命中的整行取出来，抽屉里要显示「那个 commit 上文档到底怎么写的」
    const lineText = (body ?? "")
      .split("\n")
      .find((l) => re.test(l))
      ?.trim() ?? null;

    if (!referential && !hold && !stable && claim.compare === "eq" && m !== null) {
      // 看数前后各 8 个字符，「约 2000」「N+」这类措辞紧贴着数
      const ctx = (body ?? "").slice(Math.max(0, m.index - 8), m.index + m[0].length + 8);
      if (inexactWording(ctx) !== null) {
        // 取命中所在的那一行；太长就截取数前后各 30 个字符，两头标省略号
        const text = body ?? "";
        const start = text.lastIndexOf("\n", m.index) + 1;
        const end = text.indexOf("\n", m.index + m[0].length);
        const full = text.slice(start, end === -1 ? undefined : end);
        const at = m.index - start;
        inexact = (full.length <= 90 ? full : `${at > 30 ? "…" : ""}${full.slice(Math.max(0, at - 30), at + m[0].length + 30)}…`).replace(/\s+/g, " ").trim();
      }
    }
    const got = stable ? aligned![commitAt]! : (c.values[claim.id] ?? null);
    let id = want;
    if ((referential || stable) && raw) {
      if (!textIds.has(raw)) textIds.set(raw, textIds.size + 1);
      id = textIds.get(raw)!;
      texts.push(raw);
    } else if (hold && raw) {
      const src = "source" in claim.fact && typeof claim.fact.source === "string" ? claim.fact.source : claim.file;
      const srcBody = doc.files[src];
      if (srcBody === undefined) {
        console.error(`${claim.id}：测量数据里没有 ${src}。claims.json 改过，请重新运行 measure.ts`);
        process.exit(1);
      }
      if (!bodyIds.has(srcBody)) bodyIds.set(srcBody, bodyIds.size + 1);
      id = bodyIds.get(srcBody)!;
      texts.push(raw);
    } else {
      texts.push(null);
    }
    // 判真假用 want（引用型恒为 1）；claimed 这一列给结局判定看「文档有没有改过」，
    // 引用型用文本编号，这样文档改了引用目标会被识别为文档变了
    claimed.push(id);
    actual.push(got);
    lines.push(lineText);
    states.push(judgeState(want, got, claim.compare, claim.tolerance));
    commitAt++;
  }
  return { states, claimed, actual, lines, texts, inexact };
}

/* ── 逐条分析（分段与结局判定见 classify.ts） ── */

const referential = (claim: ClaimDef): boolean => isReferential(claim.fact);

const results = claims.map((claim) => {
  const j = judge(claim);
  const runs = segment(j.states);
  const falseRuns = runs.filter((r) => r.state === FALSE);
  for (const r of falseRuns) r.outcome = classify(r, j);

  const firstTrue = j.states.indexOf(TRUE);
  const firstFalse = j.states.indexOf(FALSE);
  const bornFalse = firstFalse !== -1 && (firstTrue === -1 || firstFalse < firstTrue);

  return {
    id: claim.id,
    impact: claim.impact,
    compare: claim.compare,
    tolerance: claim.tolerance,
    label: claim.label,
    file: claim.file,
    states: j.states,
    claimed: j.claimed,
    actual: j.actual,
    verbatimByCommit: j.lines,
    inexact: j.inexact,
    kind: (isHold(claim.fact) ? "holds" : claim.fact.type === "output-unchanged" ? "stable" : referential(claim) ? "exists" : "number") as
      | "holds"
      | "stable"
      | "exists"
      | "number",
    claimedText: referential(claim) || isHold(claim.fact) || claim.fact.type === "output-unchanged" ? j.texts : [],
    falseRuns,
    outcomes: falseRuns.map((r) => r.outcome!),
    bornFalse,
    firstTrue,
    firstFalse,
    totalFalse: falseRuns.reduce((s, r) => s + r.len, 0),
    atHead: j.states.at(-1)!,
    headClaimed: j.claimed.at(-1) ?? null,
    headActual: j.actual.at(-1) ?? null,
  };
});

/* ── 输出 ── */

const glyph = (s: State): string => (s === TRUE ? "T" : s === FALSE ? "F" : s === UNMEASURED ? "?" : ".");

/** 紧凑输出里每张表最多列几行；--verbose 不限 */
const TOP = 10;
const capped = <T>(rows: T[], n: number): T[] => (VERBOSE ? rows : rows.slice(0, n));
const more = (total: number, shown: number): string =>
  total > shown ? `  （另有 ${total - shown} 条，加 --verbose 查看）` : "";

/** HEAD 上「文档写的 → 实际的」。引用型写成「文档写「xxx」→ 存在 / 不存在」 */
const nowText = (r: (typeof results)[number]): string => {
  if (r.headClaimed === null) return "(无)";
  if (r.kind === "exists" || r.kind === "holds" || r.kind === "stable") {
    const ref = r.claimedText.at(-1) ?? "?";
    const word =
      r.kind === "holds"
        ? r.headActual === 1
          ? "通过"
          : r.headActual === 0
            ? "失败"
            : "测不出来"
        : r.kind === "stable"
          ? r.headActual === 1
            ? "没变"
            : r.headActual === 0
              ? "变了"
              : "测不出来"
          : r.headActual === 1
            ? "存在"
            : r.headActual === 0
              ? "不存在"
              : "测不出来";
    return `「${ref}」→ ${word}`;
  }
  return `${comparePrefix(r.compare)}${r.headClaimed} → ${r.headActual}`;
};

/* 措辞像下限 / 近似，却在按严格相等比较的说法 */
const inexactList = results.filter((r) => r.inexact !== null && r.compare === "eq");

const everFalse = results.filter((r) => r.totalFalse > 0);
const hang = results.filter((r) => r.atHead === FALSE);
const bornFalseList = results.filter((r) => r.bornFalse);
const driftedList = results.filter((r) => !r.bornFalse && r.firstFalse !== -1);

console.log("");
console.log(`目标仓库 ${factsFile.repo}`);
console.log(`${commits.length} 个 commit，${commits[0]?.date} → ${commits.at(-1)?.date}；${results.length} 条说法`);

if (VERBOSE) {
  console.log("");
  console.log("每格一个 commit，从左到右是时间顺序：");
  console.log("  . = 该 commit 上文档里还没有这条说法   T = 真   F = 假   ? = 说法在、事实测不出来");
  console.log("");
  console.log("  " + "说法".padEnd(26) + "文档写的 → 实际的".padEnd(20) + "时间线");
  console.log("  " + "─".repeat(112));
  for (const r of results) {
    console.log("  " + r.label.padEnd(26) + nowText(r).padEnd(20) + r.states.map(glyph).join("") + (r.atHead === FALSE ? "   仍为假" : ""));
  }
} else if (hang.length > 0) {
  console.log("");
  console.log("HEAD 上仍为假的说法（文档写的 → 实际的）：");
  for (const r of capped(hang, TOP)) {
    console.log(`  ${r.label.padEnd(26)} ${nowText(r)}　已假 ${r.totalFalse} 个 commit`);
  }
  const rest = more(hang.length, TOP);
  if (rest) console.log(rest);
}

console.log("");
console.log("── 汇总 ──");
console.log(`  参与核验　　　　　：${results.length} 条`);
console.log(`  曾经为假　　　　　：${everFalse.length} 条`);
console.log(`  HEAD 上仍为假　　 ：${hang.length} 条`);
console.log(`  写下即假（从未真过）：${bornFalseList.length} 条  ${bornFalseList.map((r) => r.id).join(", ")}`);
console.log(`  先真后假（真漂移）　：${driftedList.length} 条`);
if (inexactList.length > 0) {
  console.log("");
  console.log("  提示：下面这些说法的措辞像是下限 / 上限 / 近似，现在按严格相等比较，真假可能不是本意。");
  console.log("        如果文档写的不是精确值，在 claims.json 里加 compare（gte / lte / approx）：");
  for (const r of inexactList) console.log(`    ${r.label}  「${r.inexact}」`);
}

const outcomeCount: Partial<Record<Outcome, number>> = {};
for (const r of results) for (const o of r.outcomes) outcomeCount[o] = (outcomeCount[o] ?? 0) + 1;

console.log("");
console.log("  结局分布：");
for (const [k, v] of Object.entries(outcomeCount).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${(OUTCOME_TEXT[k as Outcome] ?? k).padEnd(30)} ${v}`);
}

console.log("");
console.log("── hiatus（先真后假的假段，不含写下即假）──");

// 样本：每条说法的假段里，去掉「写下即假」的那一段
const sample: { len: number; censored: boolean; line: string }[] = [];
for (const r of results) {
  r.falseRuns.forEach((run, k) => {
    if (r.bornFalse && k === 0) return;
    sample.push({
      len: run.len,
      censored: isCensored(run, r.states),
      line:
        "  " + r.label.padEnd(26) + `c${String(run.from).padStart(2)}`.padEnd(9) +
        String(run.len).padStart(8) + "      " + (OUTCOME_TEXT[r.outcomes[k]!] ?? ""),
    });
  });
}

if (sample.length === 0) {
  console.log("  没有「先真后假」的假段。");
} else {
  // 紧凑输出只列最长的几段；--verbose 按出现顺序列全部
  const listed = VERBOSE ? sample : [...sample].sort((a, b) => b.len - a.len).slice(0, TOP);
  console.log("  说法".padEnd(26) + "变假于   长度(commit)  结局");
  console.log("  " + "─".repeat(80));
  for (const x of listed) console.log(x.line);
  const rest = more(sample.length, listed.length);
  if (rest) console.log(rest.replace("条", "段"));

  // 中位数用 Kaplan-Meier：仍挂着的段是右删失的，直接取中位数会偏小，见 survival.ts
  const km = kaplanMeier(sample.map((x) => ({ time: x.len, event: !x.censored })));
  console.log("");
  console.log(`  样本 ${km.n} 段，其中 ${km.censored} 段右删失（仍挂着，或之后事实测不出来）`);
  console.log(
    km.median === null
      ? "  中位 hiatus：无法估计（生存曲线没降到 50%，删失的段太多）"
      : `  中位 hiatus（Kaplan-Meier）= ${km.median} commit`,
  );
}

fs.writeFileSync(
  path.join(DATA, "timeline.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      commitCount: commits.length,
      commits: commits.map((c) => ({ short: c.short, date: c.date, subject: c.subject })),
      results,
    },
    null,
    2,
  ) + "\n",
  "utf8",
);
console.log(`\n已写入 ${path.join(DATA, "timeline.json")}${VERBOSE ? "" : "（逐 commit 的完整时间线在里面，或加 --verbose 打印）"}`);
