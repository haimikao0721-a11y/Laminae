#!/usr/bin/env node
/**
 * laminae —— 产物校验：报告里的每个数，都得能从仓库重新算出来
 *
 *   node <laminae>/scripts/verify.ts              校验最近一次运行
 *   node <laminae>/scripts/verify.ts --run <id>   指定运行
 *   node <laminae>/scripts/verify.ts --json       机器可读
 *
 * 为什么要有这个：报告是可以被伪造的。伪造有两种，看起来都很像真的。
 *
 *   一、**手改产物**。数字对不上就直接改 HTML 里的字。肉眼看不出区别。
 *   二、**伪造数据**。不跑流水线，直接写一份 payload.json，让 HTML 看起来是生成的。
 *
 * 两条都靠同一件事识破：**一切必须能从源头重算。**
 *
 *   一 → 拿 payload 重渲一遍 HTML，逐字节比。手改过的对不上。
 *   二 → 从 git 重算每条说法在 HEAD 的取值、提交数、HEAD 号。编号的对不上。
 *
 * 这个思路和 laminae 本身是同一件事：**别信结论，去核对它的来源。**
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { judgeState, parseClaimedNumber } from "../src/judge/classify.ts";
import { parseClaims } from "../src/measure/claims.ts";
import { evalFact, isObserved, isReferential } from "../src/measure/facts.ts";
import { git, openTrees } from "../src/core/gitutil.ts";
import { CLAIMS_PATH, RUNS_DIR, RUN_DIR, SKILL_ROOT } from "../src/core/paths.ts";
import { entryScript } from "../src/core/entry.ts";
import type { Payload } from "../src/core/types.ts";

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(n);
const value = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

interface Finding {
  level: "fail" | "warn" | "pass";
  check: string;
  detail: string;
}

/** 四种状态的中文名，和界面用同一套说法 */
const STATE_TEXT = ["真", "假", "尚未写入文档", "测不出来"] as const;

const findings: Finding[] = [];
const add = (level: Finding["level"], check: string, detail: string): void => {
  findings.push({ level, check, detail });
};

/* ── 一、产物必须是数据的纯函数 ──
 *
 * 同一份 payload 重渲一次，逐字节比对。手改过的 HTML 一定对不上，
 * 因为渲染器不会产生“那个数”。
 */
function checkReplay(payloadPath: string, htmlPath: string): void {
  if (!fs.existsSync(htmlPath)) {
    add("warn", "可重放", `没有找到 ${path.basename(htmlPath)}，跳过`);
    return;
  }
  // 先看这份报告是哪个版本的渲染器生成的。对不上只说明报告比渲染器旧，
  // 不能说成「有人改过」—— 每次都喊狼来了，这个检查很快就没人看了。
  const stored = fs.readFileSync(htmlPath, "utf8");
  const storedFp = /<meta name="laminae-renderer" content="([0-9a-f]+)">/.exec(stored)?.[1];
  const nowFp = createHash("sha1")
    .update(fs.readFileSync(path.join(SKILL_ROOT, "dist", "app.js")))
    .update(fs.readFileSync(path.join(SKILL_ROOT, "web", "style.css")))
    .update(fs.readFileSync(fileURLToPath(import.meta.url).replace(/scripts\\verify\.ts$/, "src/output/render.ts")))
    .digest("hex")
    .slice(0, 16);
  if (storedFp === undefined) {
    add("warn", "可重放", "这份报告是旧版渲染器产出的（没有指纹），跳过逐字节比对。重跑一次就能查");
    return;
  }
  if (storedFp !== nowFp) {
    add("warn", "可重放", `报告由渲染器 ${storedFp} 生成，当前是 ${nowFp}，整套重跑之后才能逐字节比对`);
    return;
  }

  const tmp = path.join(os.tmpdir(), `laminae-replay-${process.pid}.html`);
  const r = spawnSync(
    process.execPath,
    [entryScript("src/output/render.ts"), "--payload", payloadPath, "--out", tmp],
    { cwd: process.cwd(), encoding: "utf8", timeout: 300_000 },
  );
  if (r.status !== 0) {
    add("fail", "可重放", `重渲失败，没法确认产物来自数据：${(r.stderr ?? "").split("\n")[0]}`);
    return;
  }
  const want = fs.readFileSync(htmlPath);
  const got = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  if (Buffer.compare(want, got) === 0) {
    add("pass", "可重放", "报告和「用同一份数据重渲一次」逐字节一致");
    return;
  }
  // 找出第一处不同的位置，给出上下文，比只说「不一致」有用
  const a = want.toString("utf8");
  const b = got.toString("utf8");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const near = (s: string): string => JSON.stringify(s.slice(Math.max(0, i - 40), i + 40));
  add(
    "fail",
    "可重放",
    `报告和重渲结果不一致（第 ${i} 个字符起）。这个 HTML 不是纯粹由数据算出来的 —— ` +
      `要么有人手改过，要么数据被改过之后没有重渲。\n      现存：${near(a)}\n      重渲：${near(b)}`,
  );
}

/* ── 二、数据必须能从 git 重算 ──
 *
 * 伪造 payload 的人不会去改 git。所以从仓库重新算一遍每条说法在 HEAD 的取值，
 * 跟报告里的对照。编号的、多出来的、少掉的，都对不上。
 */
function checkAgainstGit(payload: Payload): void {
  if (!fs.existsSync(CLAIMS_PATH)) {
    add("warn", "与仓库一致", "没有 claims.json，跳过");
    return;
  }
  let claims;
  try {
    claims = parseClaims(JSON.parse(fs.readFileSync(CLAIMS_PATH, "utf8").replace(/^\uFEFF/, "")));
  } catch (e) {
    add("fail", "与仓库一致", `claims.json 读不出来：${(e as Error).message}`);
    return;
  }

  // 提交数与 HEAD：最容易被编造、也最容易核对的两个数
  const headSha = git(["rev-parse", "HEAD"])?.trim() ?? "";
  const count = Number(git(["rev-list", "--first-parent", "--count", "HEAD"])?.trim() ?? "0");
  const pCommits = payload.commits.length;
  if (count > 0 && pCommits !== count) {
    add("fail", "与仓库一致", `报告里有 ${pCommits} 个提交，从 git 数出来是 ${count} 个`);
  } else if (count > 0) {
    const last = payload.commits[pCommits - 1];
    if (last && !headSha.startsWith(last.short.slice(0, 7)) && last.short !== headSha.slice(0, 7)) {
      add("fail", "与仓库一致", `报告最后一个提交是 ${last.short}，但 HEAD 是 ${headSha.slice(0, 7)}`);
    } else {
      add("pass", "与仓库一致", `${pCommits} 个提交，最后一个就是 HEAD`);
    }
  }

  // 每条说法在 HEAD 的取值，从 git 重新算
  const trees = openTrees();
  let tree;
  try {
    tree = trees.at(headSha, () => []);
  } catch {
    add("warn", "与仓库一致", "读不到 HEAD 的文件树，跳过逐条核对");
    return;
  }

  let checked = 0;
  let mismatched = 0;
  for (const c of claims) {
    const reported = payload.claims.find((x) => x.id === c.id);
    if (!reported) {
      add("fail", "与仓库一致", `claims.json 里有「${c.label}」，报告里没有 —— 这份报告不是用现在这份 claims 跑出来的`);
      continue;
    }
    if (isObserved(c.fact)) continue; // 命令类事实要工作区，这里不跑
    let actual: number | null;
    if (isReferential(c.fact)) {
      const m = new RegExp(c.locator).exec(tree.read(c.file) ?? "");
      actual = m ? evalFact(c.fact, tree, m[1] ?? null) : null;
    } else {
      actual = evalFact(c.fact, tree);
    }
    checked++;
    // 比的是**结论**，不是中间值。
    // analyze 有一条设计成这样：文档里的数读不成数时，整格按「尚未写入文档」处理，
    // 实测值也一并记成 null（不保留）。拿 actual 逐字比对会把它当成不一致，
    // 那是误报 —— 状态才对得上，因为两边都是 ABSENT。
    const docBody = tree.read(c.file) ?? "";
    const m = new RegExp(c.locator).exec(docBody);
    const raw = m?.[1]?.trim();
    // 和 analyze 的规则保持一致：引用型和命令类断言「它存在 / 应当成立」，恒为 1；
    // 数值型从捕获组里读；读不成数就是 null（那时整格按「尚未写入文档」处理）
    const want = isReferential(c.fact) || isObserved(c.fact) ? (raw ? 1 : null) : m ? parseClaimedNumber(m[1] ?? "") : null;
    const wantState = judgeState(want, actual, c.compare, c.tolerance);
    const reportedState = Array.isArray(reported.states) ? reported.states[reported.states.length - 1] : undefined;
    if (reportedState !== undefined && reportedState !== wantState) {
      mismatched++;
      add(
        "fail",
        "与仓库一致",
        `「${c.label}」在 HEAD 上从 git 算出来的状态是 ${STATE_TEXT[wantState] ?? wantState}，报告里是 ${STATE_TEXT[reportedState] ?? reportedState}`,
      );
    }
  }
  if (checked > 0 && mismatched === 0) add("pass", "与仓库一致", `${checked} 条说法在 HEAD 的取值全部对得上`);
}

/* ── 三、报告里的结论不能超出数据 ──
 *
 * 一个便宜的交叉检查：payload 说「HEAD 仍为假 N 条」，那就得真的能数出 N 条。
 * 编造的人常常只改显眼的汇总数，忘了让明细跟着变。
 */
function checkInternalConsistency(payload: Payload): void {
  const s = payload.summary;
  const headFalse = payload.claims.filter((c) => c.states[c.states.length - 1] === 1).length;
  if (s.falseAtHead !== headFalse) {
    add("fail", "汇总自洽", `汇总说 HEAD 仍为假 ${s.falseAtHead} 条，逐条数出来是 ${headFalse} 条`);
  } else {
    add("pass", "汇总自洽", `HEAD 仍为假 ${headFalse} 条，与汇总一致`);
  }
  if (s.claimCount !== payload.claims.length) {
    add("fail", "汇总自洽", `汇总说 ${s.claimCount} 条说法，实际 ${payload.claims.length} 条`);
  }
}

function main(): void {
  const runId = value("--run");
  const runDir = runId ? path.join(RUNS_DIR, runId) : RUN_DIR;
  const payloadPath = path.join(runDir, "payload.json");
  const htmlPath = path.join(runDir, "laminae.html");

  if (!fs.existsSync(payloadPath)) {
    console.error(`找不到 ${payloadPath}`);
    console.error("先跑一次 run.ts，或者在目标仓库目录下运行本命令。");
    process.exitCode = 1;
    return;
  }

  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8")) as Payload;

  checkReplay(payloadPath, htmlPath);
  checkAgainstGit(payload);
  checkInternalConsistency(payload);

  const failed = findings.filter((f) => f.level === "fail");
  const warned = findings.filter((f) => f.level === "warn");

  if (flag("--json")) {
    console.log(JSON.stringify({ runId: runId ?? "(最近一次)", ok: failed.length === 0, findings }, null, 2));
  } else {
    console.log(`校验 ${payload.repo}（${path.basename(runDir)}）`);
    console.log("");
    for (const f of findings) {
      const mark = f.level === "fail" ? "✗" : f.level === "warn" ? "!" : "✓";
      console.log(`  ${mark} ${f.check}：${f.detail}`);
    }
    console.log("");
    console.log(
      failed.length === 0
        ? `通过：${findings.length} 项检查，没有发现伪造或对不上的地方${warned.length > 0 ? `（${warned.length} 项跳过）` : ""}。`
        : `不通过：${failed.length} 项。这份报告不能当作仓库的真实情况。`,
    );
  }
  if (failed.length > 0) process.exitCode = 1;
}

main();
