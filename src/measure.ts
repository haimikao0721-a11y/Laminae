#!/usr/bin/env node
/**
 * laminae —— 逐 commit 测量引擎
 *
 *   node <laminae>/src/measure.ts      在要核验的项目目录下运行
 *
 * 对目标仓库主线上的每一个 commit，从 git 对象库直接读（ls-tree，正文用一次 cat-file）：
 *   - claims.json 里每条说法所在文档的正文
 *   - claims.json 里每条说法声明的事实（见 facts.ts）
 * 数仓库的事实不检出、不写主工作区。
 * test-passes / invariant-holds / output-unchanged 在临时 worktree 里执行命令，测完即删。
 *
 * 产物：<目标仓库>/.laminae/data/facts.json、docs-by-commit.json
 */
import fs from "node:fs";
import path from "node:path";
import { loadClaims } from "./claims.ts";
import { assertBoundRepo, REPO, LOG_ARGS, VERBOSE } from "./config.ts";
import { ensureExcluded } from "./exclude.ts";
import { evalFact, factFiles, globToRegExp, isHold, isObserved, isReferential } from "./facts.ts";
import { git, openTrees } from "./gitutil.ts";
import { nextObservation, openWorktree, runCommand } from "./observe.ts";
import type { ObserveCache } from "./observe.ts";
import { CLAIMS_PATH, DATA_DIR } from "./paths.ts";
import type { MeasuredCommit } from "./types.ts";

assertBoundRepo();

let claims;
try {
  claims = loadClaims(CLAIMS_PATH);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

// 说法定义读取成功之后才开始产生生成物：先把它们登记为本地忽略，避免出现在目标仓库的 git status 里
ensureExcluded();

/* ── 1. 提交序列 ── */

const logRaw = git(["log", ...LOG_ARGS, "--format=%H%x1f%h%x1f%ad%x1f%s", "--date=short"]);
if (!logRaw) {
  console.error(`取不到提交历史：${REPO}（仓库里没有提交？）`);
  process.exit(1);
}
const commits = logRaw
  .split("\n")
  .filter(Boolean)
  .map((line, i) => {
    const [sha = "", short = "", date = "", subject = ""] = line.split("\x1f");
    return { i, sha, short, date, subject };
  });

console.log(`目标仓库：${REPO}`);
console.log(`提交数：${commits.length}　${commits[0]?.date ?? "?"} → ${commits.at(-1)?.date ?? "?"}`);
console.log(`说法：${claims.length} 条`);

/* ── 2. 每个 commit：文件树、文档正文、事实 ── */

/** 需要读正文的文档：说法所在文件，以及测试/不变量用来判断「声称有没有改」的 source */
const docFiles = [
  ...new Set(
    claims.flatMap((d) => {
      if (isHold(d.fact) && d.fact.source) return [d.file, d.fact.source];
      return [d.file];
    }),
  ),
];

/** 引用型说法要在每个 commit 上用定位正则取文本，正则只编译一次 */
const locators = new Map(claims.map((c) => [c.id, new RegExp(c.locator)]));

const measured: MeasuredCommit[] = [];
const docBodies: { sha: string; short: string; files: Record<string, string> }[] = [];

const observed = claims.filter((c) => isObserved(c.fact));
const work = observed.length > 0 ? openWorktree(REPO) : null;
const trees = openTrees();
/** 这个 commit 上真正要读正文的文件：说法点名的，再加上 watch 命中的 */
const pickFiles = (paths: readonly string[]): string[] => {
  const need = new Set<string>(docFiles);
  for (const claim of claims) {
    for (const file of factFiles(claim.fact)) need.add(file);
    if (isObserved(claim.fact) && claim.fact.watch) {
      const res = claim.fact.watch.map((g) => globToRegExp(g));
      for (const p of paths) if (res.some((r) => r.test(p))) need.add(p);
    }
  }
  return [...need];
};
const observeCache = new Map<string, ObserveCache>();
if (observed.length > 0) {
  console.log(`要跑的事实：${observed.length} 条（临时工作区，不改主目录）`);
}

try {
  for (const c of commits) {
    const tree = trees.at(c.sha, pickFiles);

    // 文档正文单独存，避免 facts.json 过大。该 commit 上读不到的文件记为空串。
    const files: Record<string, string> = {};
    for (const f of docFiles) files[f] = tree.read(f) ?? "";
    docBodies.push({ sha: c.sha, short: c.short, files });

    const values: Record<string, number | null> = {};
    for (const claim of claims) {
      if (isObserved(claim.fact)) {
        const fact = claim.fact;
        const step = nextObservation({
          fact,
          sha: c.sha,
          paths: tree.paths(),
          read: (file) => tree.read(file),
          cache: observeCache.get(claim.id),
          materialize: (sha) => (work ? work.at(sha) : null),
          run: runCommand,
        });
        if (step.cache) observeCache.set(claim.id, step.cache);
        values[claim.id] = step.value;
        if (step.ran) console.log(`  跑 ${claim.label} @ ${c.short}`);
      } else if (isReferential(claim.fact)) {
        // 引用型：事实取决于文档在该 commit 上写的是什么，先把文档里的引用文本取出来
        const m = locators.get(claim.id)!.exec(files[claim.file] ?? "");
        values[claim.id] = evalFact(claim.fact, tree, m?.[1] ?? null);
      } else {
        values[claim.id] = evalFact(claim.fact, tree);
      }
    }

    measured.push({ sha: c.sha, short: c.short, date: c.date, subject: c.subject, tracked: tree.paths().length, values });

    // 历史长时每个 commit 约几十毫秒（Windows 上进程启动慢），上千个要等一两分钟，给个进度免得像卡住
    const every = VERBOSE ? 10 : 500;
    if ((c.i + 1) % every === 0 && c.i + 1 < commits.length) console.log(`  已测 ${c.i + 1}/${commits.length}`);
  }
} finally {
  work?.close();
}

/* ── 3. 输出 ── */

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(
  path.join(DATA_DIR, "facts.json"),
  JSON.stringify({ repo: REPO, generatedAt: new Date().toISOString(), commitCount: commits.length, commits: measured }, null, 2) + "\n",
  "utf8",
);
fs.writeFileSync(path.join(DATA_DIR, "docs-by-commit.json"), JSON.stringify(docBodies) + "\n", "utf8");

const first = measured[0];
const last = measured.at(-1);
const SHOWN = VERBOSE ? claims.length : 10;
console.log("\n首尾对照（说法 → 首个 commit 上的事实 / 最新 commit 上的事实）：");
for (const claim of claims.slice(0, SHOWN)) {
  const a = first?.values[claim.id] ?? "-";
  const b = last?.values[claim.id] ?? "-";
  console.log(`  ${claim.label.padEnd(28)} ${String(a).padStart(6)} → ${String(b).padStart(6)}`);
}
if (claims.length > SHOWN) console.log(`  （另有 ${claims.length - SHOWN} 条，加 --verbose 查看）`);
console.log(`\n已写入 ${path.join(DATA_DIR, "facts.json")}`);
