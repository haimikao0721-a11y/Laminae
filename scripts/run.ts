#!/usr/bin/env node
/**
 * laminae —— 全流程
 *
 * 单仓库（在要核验的项目目录下）：
 *   node <laminae>/scripts/run.ts
 *   node <laminae>/scripts/run.ts --run before-refactor
 *   node <laminae>/scripts/run.ts data          只跑到数据，不渲染 HTML
 *
 * 只跑其中几步（改了解析或规则之后用，跳过最贵的逐 commit 测量）：
 *   node <laminae>/scripts/run.ts --from 2               从第 2 步起
 *   node <laminae>/scripts/run.ts --from analyze --to 5  名字里的一段也认
 *   node <laminae>/scripts/run.ts --from 5               只重算构建期加工和渲染
 *
 * 跳过的步骤依赖的中间数据不在时，会停下来告诉你先跑哪一步 ——
 * 不会让后面几步读到空文件、产出一份「看起来正常」的空报告。
 *
 * 多仓库（在包含多个子仓库的项目文件夹下）：
 *   node <laminae>/scripts/run.ts                自动读 .laminae/repos.json
 *   node <laminae>/scripts/run.ts --repos api,web
 *   node <laminae>/scripts/run.ts --jobs 4
 *
 * 每个仓库仍然是独立的一次运行：单绑、互不碰 git 对象、各写各的 .laminae/runs/<id>/。
 * 只有编排是并行的，「一次只绑一个仓库」那条约束没有放宽。
 *
 * 并行有一条硬限制：只要任何一个仓库用了 test-passes / invariant-holds / output-unchanged，
 * 就自动改成串行。那些命令会起服务、连测试库、占端口，两个仓库同时跑会互相打架，
 * 而且失败会被记成「测不出来」——看起来像工具的问题，其实是并发造成的。
 * 确定互不干扰时用 --allow-parallel-commands 强制并行。
 */
import { spawn } from "node:child_process";
import { entryScript } from "../src/core/entry.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkRunId, defaultRunId, uniqueRunId, writeLatest } from "../src/core/runid.ts";
import { dedupe, findSubRepos, parseRepoList, readReposFile } from "../src/core/repos.ts";
import type { RepoSpec } from "../src/core/repos.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/* ────────────── 参数 ────────────── */

const argv = process.argv.slice(2);
const has = (f: string): boolean => argv.includes(f);
const value = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  if (i === -1 || i + 1 >= argv.length) return undefined;
  const v = argv[i + 1]!;
  return v.startsWith("--") ? undefined : v;
};

const STAGE = argv.includes("data") ? "data" : "all";
const VERBOSE = has("--verbose");
const ALLOW_PARALLEL_COMMANDS = has("--allow-parallel-commands");

/** 原样传给每一步的参数：去掉编排器自己消费的那些 */
const CONSUMER_FLAGS = new Set(["--repo", "--repos", "--run", "--jobs", "--all", "--allow-parallel-commands"]);
function passThrough(): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "data") continue;
    if (CONSUMER_FLAGS.has(a)) {
      i++; // 跳过它的值
      continue;
    }
    out.push(a);
  }
  return out;
}

/* ────────────── 仓库清单 ────────────── */

const CWD = process.cwd();

function resolveTargets(): RepoSpec[] {
  const fromArgs = value("--repos") ?? process.env["LAMINAE_REPOS"];

  if (fromArgs) return dedupe(parseRepoList(CWD, fromArgs));

  const fromFile = readReposFile(CWD);
  if (fromFile) return dedupe(fromFile);

  const explicit = value("--repo");
  const abs = path.resolve(CWD, explicit ?? process.env["LAMINAE_REPO"] ?? ".");
  const name = (explicit ?? process.env["LAMINAE_REPO"]) ? path.basename(abs) : path.basename(abs) || abs;
  return [{ abs, name }];
}

let targets: RepoSpec[];
try {
  targets = resolveTargets();
} catch (e) {
  console.error(`仓库清单有问题：${(e as Error).message}`);
  process.exit(1);
}

/**
 * 父目录本身不是仓库、也没给清单时的处理。
 *
 * 这是最容易踩的一步：在包含几个子仓库的项目文件夹里直接跑，以前只会得到
 * 「不在 git 仓库里」。现在把下面的仓库列出来，并给出能直接粘的命令。
 * --all 则直接全跑。
 */
function isRepoRoot(dir: string): boolean {
  try {
    const st = fs.statSync(path.join(dir, ".git"));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

if (targets.length === 1 && !isRepoRoot(targets[0]!.abs) && !value("--repo") && !process.env["LAMINAE_REPO"]) {
  const subs = findSubRepos(targets[0]!.abs);
  if (subs.length > 0) {
    if (has("--all")) {
      targets = subs.map((s) => ({ abs: s.abs, name: path.basename(s.abs) }));
      console.log(`当前目录不是仓库，按 --all 跑它下面的 ${targets.length} 个：${targets.map((t) => t.name).join("、")}\n`);
    } else {
      console.error(
        [
          `${targets[0]!.abs} 本身不是 git 仓库，但它下面有 ${subs.length} 个：`,
          ...subs.map((s) => `  ${s.rel}/`),
          "",
          "全跑：",
          `  node ${path.relative(CWD, path.join(ROOT, "scripts", "run.ts")) || "scripts/run.ts"} --all`,
          "",
          "只跑一个：",
          `  node <laminae>/scripts/run.ts --repo ${subs[0]!.rel}`,
          "",
          "或者把清单写进 .laminae/repos.json（数组，每项是仓库路径或 {name, path}），",
          "以后直接 node <laminae>/scripts/run.ts。",
        ].join("\n"),
      );
      process.exit(1);
    }
  }
}

/** 工具自己不能被当成核验对象。各步骤也会查一次，这里先挡是为了给出更清楚的提示 */
const selfReal = fs.realpathSync.native(ROOT);
targets = targets.filter((t) => {
  try {
    return fs.realpathSync.native(t.abs) !== selfReal;
  } catch {
    return true;
  }
});
if (targets.length === 0) {
  console.error(`${ROOT} 是 laminae 自己的仓库，不能当被核验的项目。`);
  process.exit(1);
}

/* ────────────── 运行 id ────────────── */

function takenIn(repo: string): (id: string) => boolean {
  return (id) => fs.existsSync(path.join(repo, ".laminae", "runs", id));
}

let RUN_ID: string;
const explicitRun = value("--run") ?? process.env["LAMINAE_RUN"];
if (explicitRun !== undefined && explicitRun !== "") {
  const c = checkRunId(explicitRun);
  if (!c.ok) {
    console.error(`--run ${JSON.stringify(explicitRun)} 不合法：${c.reason}`);
    process.exit(1);
  }
  RUN_ID = c.id;
  // 显式指定就是显式覆盖：同一个名字再跑一次，是「用新的结果替换那一次的记录」
  const clashing = targets.filter((t) => takenIn(t.abs)(RUN_ID));
  if (clashing.length > 0) {
    console.log(`注意：${clashing.map((t) => t.name).join("、")} 已有名为 ${RUN_ID} 的运行，会被覆盖。`);
  }
} else {
  // 默认按时间。多个仓库共用同一个 id，汇总页才认得出来是同一次
  const base = defaultRunId();
  const anyTaken = (id: string): boolean => targets.some((t) => takenIn(t.abs)(id));
  RUN_ID = uniqueRunId(base, anyTaken);
}

/* ────────────── 并发保护 ────────────── */

const OBSERVED = new Set(["test-passes", "invariant-holds", "output-unchanged"]);

/** 这个仓库里有没有会执行命令的说法 */
function usesObservedFact(repo: string): boolean {
  const file = path.join(repo, ".laminae", "claims.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { claims?: unknown[] })?.claims;
    if (!Array.isArray(list)) return false;
    return list.some((c) => OBSERVED.has(String((c as { fact?: { type?: string } })?.fact?.type ?? "")));
  } catch {
    return false;
  }
}

const observedRepos = targets.filter((t) => usesObservedFact(t.abs));
const cpus = Math.max(1, Math.min(8, os.cpus().length));

function resolveJobs(): number {
  const raw = value("--jobs") ?? process.env["LAMINAE_JOBS"];
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      console.error(`--jobs 要正整数，收到 ${JSON.stringify(raw)}`);
      process.exit(1);
    }
    return n;
  }
  return Math.min(cpus, Math.max(1, targets.length));
}

let JOBS = Math.min(resolveJobs(), targets.length);

if (targets.length > 1 && JOBS > 1 && observedRepos.length > 0 && !ALLOW_PARALLEL_COMMANDS) {
  console.log(
    `注意：${observedRepos.map((t) => t.name).join("、")} 里有会执行命令的说法（测试 / 不变量 / 输出差分），` +
      `改成串行跑，免得互相抢端口和测试库。互不干扰的话加 --allow-parallel-commands。`,
  );
  JOBS = 1;
}

/* ────────────── 跑一个仓库 ────────────── */

// file 是**仓库相对路径**，不是相对 src/ 的裸文件名。
// 裸名加隐式前缀的写法会让「搬文件」变成猜谜 —— 改的人记不住前缀是什么。
const STEPS: { name: string; file: string; data: boolean }[] = [
  { name: "1/6 逐 commit 测量", file: "src/measure/measure.ts", data: true },
  { name: "2/6 时序分析", file: "src/judge/analyze.ts", data: true },
  { name: "3/6 模块引用关系", file: "src/layers/graph.ts", data: true },
  { name: "4/6 想法、边界与线索", file: "src/ideas/ideas.ts", data: true },
  { name: "5/6 构建期加工", file: "src/output/build-data.ts", data: true },
  { name: "6/6 渲染 HTML", file: "src/output/render.ts", data: false },
];

/**
 * 每一步跑之前，磁盘上必须已经有什么。
 *
 * 为什么要有这张表：加了 --from 之后，人可以直接从第 2 步开始跑，跳过最贵的测量。
 * 但中间数据不在的时候，后面几步会读到空文件然后写出一份**看起来正常**的报告 ——
 * 空的引用图、零条说法。那种产物比报错危险得多，因为 verify 只核对「能不能重算」，
 * 而空数据重算出来也是空的，一路对得上。
 *
 * 所以：宁可停下来告诉人先跑哪一步。
 */
const NEEDS: readonly (readonly string[])[] = [
  [], // 1 measure 自己从 git 读
  ["facts.json", "docs-by-commit.json"],
  ["facts.json"],
  ["facts.json"],
  ["timeline.json", "graph.json", "layers.json"],
  ["payload.json"],
];

/** 把 --from / --to 的值解析成 STEPS 的下标。接受步号，也接受名字里的一段 */
function resolveStep(spec: string, which: string): number {
  const n = Number(spec);
  if (Number.isInteger(n) && n >= 1 && n <= STEPS.length) return n - 1;
  const hit = STEPS.findIndex((s) => s.name.includes(spec) || s.file.includes(spec));
  if (hit >= 0) return hit;
  throw new Error(
    `${which} 认不出「${spec}」。可以给步号 1..${STEPS.length}，或者名字里的一段：\n` +
      STEPS.map((s, i) => `  ${i + 1}  ${s.name}`).join("\n"),
  );
}

const FROM_SPEC = has("--from") ? (argv[argv.indexOf("--from") + 1] ?? "") : null;
const TO_SPEC = has("--to") ? (argv[argv.indexOf("--to") + 1] ?? "") : null;
const FROM = FROM_SPEC === null ? 0 : resolveStep(FROM_SPEC, "--from");
const TO = TO_SPEC === null ? STEPS.length - 1 : resolveStep(TO_SPEC, "--to");
if (FROM > TO) throw new Error(`--from 在第 ${FROM + 1} 步，--to 在第 ${TO + 1} 步，区间是空的`);

/** 从哪一步开始跑，就得先确认那一步要读的东西已经在 */
function assertInputs(repo: string, from: number): void {
  const need = NEEDS[from] ?? [];
  const missing: string[] = [];
  for (const f of need) {
    const file = f === "payload.json" ? path.join(repo, ".laminae", "runs", RUN_ID, "payload.json") : path.join(repo, ".laminae", "data", f);
    if (!fs.existsSync(file)) missing.push(file);
  }
  if (missing.length > 0) {
    throw new Error(
      `从第 ${from + 1} 步（${STEPS[from]!.name}）开始跑，但缺这些文件：\n` +
        missing.map((m) => `  ${m}`).join("\n") +
        `\n\n先跑完整的一遍，或者从这里之前的那一步开始：\n  node scripts/run.ts --from 1`,
    );
  }
}

const stepsFor = (): typeof STEPS => {
  const base = STAGE === "data" ? STEPS.filter((s) => s.data) : STEPS;
  // --from / --to 按 STEPS 的绝对下标切，再和 data 过滤取交集 ——
  // 这样「--data --from 3」仍然是「只到数据，并从第 3 步起」，两个开关不互相打架
  return base.filter((s) => STEPS.indexOf(s) >= FROM && STEPS.indexOf(s) <= TO);
};

interface StepResult {
  ok: boolean;
  /** 子进程的 stdout。按仓库缓冲，免得多个仓库的输出搅在一起 */
  out: string;
  /** 子进程的 stderr。错误要留在 stderr 上，不能被我们吞成 stdout */
  err: string;
}

/**
 * 非 verbose 时也要透出来的行。
 *
 * 「N 条说法的写法有问题」说的是**这份报告的哪些格子不可信**，
 * 和「哪几条说法写得不对」是同一件事。藏在 --verbose 后面等于没说。
 */
function emitNotices(spec: RepoSpec, r: StepResult): void {
  const keep = r.out
    .split("\n")
    .filter((l) => /条说法的写法有问题|^\s*[✗!] |有 .* 处引用|回溯|可能卡住/.test(l));
  if (keep.length > 0) console.log(keep.map((l) => `  [${spec.name}] ${l.trim()}`).join("\n"));
}

function runStep(repo: string, file: string, passArgs: string[]): Promise<StepResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entryScript(file), ...passArgs], {
      cwd: repo,
      env: { ...process.env, LAMINAE_REPO: repo, LAMINAE_RUN: RUN_ID },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => (err += b.toString("utf8")));
    child.on("error", (e) => resolve({ ok: false, out, err: err + `启动失败：${e.message}\n` }));
    child.on("close", (code) => resolve({ ok: code === 0, out, err }));
  });
}

async function runRepo(spec: RepoSpec, passArgs: string[]): Promise<{ ok: boolean; seconds: number }> {
  const t0 = Date.now();
  try {
    assertInputs(spec.abs, FROM);
  } catch (e) {
    emitErr(spec, (e as Error).message);
    return { ok: false, seconds: (Date.now() - t0) / 1000 };
  }
  for (const step of stepsFor()) {
    const r = await runStep(spec.abs, step.file, passArgs);
    if (!r.ok) {
      emitLog(spec, r);
      emitErr(spec, `「${step.name}」失败`);
      return { ok: false, seconds: (Date.now() - t0) / 1000 };
    }
    if (VERBOSE) emitLog(spec, r);
    else emitNotices(spec, r);
  }

  // 最后一步：校验产物。
  //
  // 放在流水线里的理由：**不依赖人记得去跑**。报告可以被伪造 —— 手改 HTML，
  // 或者不跑流水线直接写 payload。放在这里，伪造的产物当场退出码非 0，
  // 而不是等到有人想起来才去查。
  //
  // 这一步会重新渲染一遍（一份报告几十毫秒），比它挡住的麻烦便宜得多。
  // 没跑到最后一步就没有新报告，没什么可校验的 —— 硬跑会去校上一份旧产物，
  // 得到一个和这次运行无关的结论。
  if (TO < STEPS.length - 1) return { ok: true, seconds: (Date.now() - t0) / 1000 };
  const v = await runStep(spec.abs, "scripts/verify.ts", []);
  if (!v.ok) {
    emitLog(spec, v);
    emitErr(spec, "「校验产物」不通过：这份报告不能当作仓库的真实情况");
    return { ok: false, seconds: (Date.now() - t0) / 1000 };
  }
  if (VERBOSE) emitLog(spec, v);

  const seconds = (Date.now() - t0) / 1000;
  return { ok: true, seconds };
}

/* ────────────── 输出 ────────────── */

const multi = targets.length > 1;
const pad = targets.reduce((m, t) => Math.max(m, t.name.length), 0);

/** 多仓库时给每行加仓库名前缀，单仓库时不加，输出保持原样 */
function prefix(spec: RepoSpec): string {
  return multi ? `[${spec.name.padEnd(pad)}] ` : "";
}

function emitLog(spec: RepoSpec, r: StepResult): void {
  const tag = prefix(spec);
  if (r.out.trim() !== "") {
    for (const line of r.out.trimEnd().split("\n")) console.log(`${tag}${line}`);
  }
  if (r.err.trim() !== "") {
    for (const line of r.err.trimEnd().split("\n")) console.error(`${tag}${line}`);
  }
}

function emitErr(spec: RepoSpec, what: string): void {
  console.error(`${prefix(spec)}${what}`);
}

/* ────────────── 执行 ────────────── */

const passArgs = passThrough();

console.log(
  multi
    ? `核验 ${targets.length} 个仓库，运行 id ${RUN_ID}，并行度 ${JOBS}${STAGE === "data" ? "（只到数据）" : ""}`
    : `核验 ${targets[0]!.abs}，运行 id ${RUN_ID}${STAGE === "data" ? "（只到数据）" : ""}`,
);
if (multi) console.log(targets.map((t) => `  ${t.name.padEnd(pad)}  ${path.relative(CWD, t.abs) || "."}`).join("\n"));
console.log("");

interface Done {
  spec: RepoSpec;
  ok: boolean;
  seconds: number;
}

const done: Done[] = [];
const queue = [...targets];

async function worker(): Promise<void> {
  for (;;) {
    const spec = queue.shift();
    if (!spec) return;
    const r = await runRepo(spec, passArgs);
    done.push({ spec, ...r });
  }
}

await Promise.all(Array.from({ length: JOBS }, () => worker()));

/* ────────────── 汇总与 latest ────────────── */

for (const d of done) {
  if (!d.ok) continue;
  try {
    writeLatest(path.join(d.spec.abs, ".laminae"), RUN_ID);
  } catch (e) {
    console.error(`提示：没能写 ${d.spec.name} 的 latest 指针（${(e as Error).message}）`);
  }
}

const failed = done.filter((d) => !d.ok);
console.log("");
if (multi) {
  console.log("结果：");
  for (const d of [...done].sort((a, b) => a.spec.name.localeCompare(b.spec.name))) {
    console.log(`  ${d.ok ? "完成" : "失败"}  ${d.spec.name.padEnd(pad)}  ${d.seconds.toFixed(1)} 秒`);
  }
  console.log("");
}

/* 多仓库时生成一份汇总页，放在父目录的 .laminae/runs/<id>/ 下 */
if (multi && failed.length === 0 && STAGE !== "data") {
  const { buildIndex } = await import("../src/output/indexhtml.ts");
  const out = buildIndex({
    parent: CWD,
    runId: RUN_ID,
    repos: done.map((d) => ({
      name: d.spec.name,
      abs: d.spec.abs,
      htmlPath: path.join(d.spec.abs, ".laminae", "runs", RUN_ID, "laminae.html"),
      payloadPath: path.join(d.spec.abs, ".laminae", "runs", RUN_ID, "payload.json"),
    })),
  });
  console.log(`汇总页：${out}`);
  console.log("");
}

if (failed.length > 0) {
  console.error(`${failed.length} 个仓库失败：${failed.map((d) => d.spec.name).join("、")}`);
  process.exit(1);
}

console.log(STAGE === "data" ? "只跑到数据，停在这里。" : "完成");
