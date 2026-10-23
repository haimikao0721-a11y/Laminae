#!/usr/bin/env node
/**
 * laminae —— 未合并分支上的事实翻转
 *
 *   node <laminae>/scripts/branches.ts            看哪些分支改了判定依据
 *   node <laminae>/scripts/branches.ts --json     机器可读
 *   node <laminae>/scripts/branches.ts --all      连已合并的分支也列出来（只是列，不判）
 *
 * 只回答一个问题：**有没有哪个分支已经把某条说法改成真的了，但没合进 main。**
 *
 * 三件事故意不做：
 *
 *   1. **不切分支。** 引用型事实全是从 git 对象里读的，`git cat-file` 能读任意 commit，
 *      工作区一次都不动。只有命令类事实（test-passes 等）才需要工作区 —— 这里直接跳过，
 *      并说明跳过了几条。
 *
 *   2. **不判合并语义。** 「分支上改过的东西在 main 是保留、删除、还是被覆盖」是 diff3 级别的
 *      问题，判错的代价比不判高。这里只比两个 commit 上同一个事实的取值，翻没翻。
 *
 *   3. **不查已合并的分支。** main 已经包含它们的结果，再查没有新增信息。
 *      合并时解冲突解坏的情况，会体现在 main 自己的时间线上，不需要在这里找。
 *
 * 一句话：只查「未被 main 包含」的分支，只判事实翻转。
 */
import fs from "node:fs";
import { parseClaims } from "../src/measure/claims.ts";
import { DEFAULT_TOLERANCE } from "../src/measure/compare.ts";
import { evalFact, isObserved, isReferential } from "../src/measure/facts.ts";
import { nextObservation, openWorktree, runCommand } from "../src/measure/observe.ts";
import type { ObserveCache } from "../src/measure/observe.ts";
import { git, openTrees } from "../src/core/gitutil.ts";
import { CLAIMS_PATH } from "../src/core/paths.ts";

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(n);
const value = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

interface Row {
  claim: string;
  label: string;
  file: string;
  main: string;
  branch: string;
  /** 分支上为真、main 上为假 —— 最值得看的那一格 */
  fixed: boolean;
  /** 分支上为假、main 上为真 */
  broke: boolean;
  /** 两边取值不同但不是真假翻转，例如数字变了 */
  moved: boolean;
}

interface BranchResult {
  name: string;
  sha: string;
  date: string;
  ahead: number;
  behind: number;
  rows: Row[];
}

const MAIN = ["main", "master"];

function branches(): { name: string; sha: string }[] {
  const out = git(["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads", "refs/remotes"]) ?? "";
  const seen = new Map<string, string>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const sp = line.lastIndexOf(" ");
    const name = line.slice(0, sp).replace(/^origin\//, "");
    const sha = line.slice(sp + 1);
    if (name === "HEAD" || MAIN.includes(name) || name.endsWith("/HEAD")) continue;
    if (!seen.has(name)) seen.set(name, sha.trim());
  }
  return [...seen.entries()].map(([name, sha]) => ({ name, sha }));
}

/** 这个 commit 是否已经在 main 的历史里 */
function mergedInto(target: string, main: string): boolean {
  const r = git(["merge-base", "--is-ancestor", target, main]);
  return r !== null;
}

/** 领先 / 落后多少个提交 */
function aheadBehind(a: string, b: string): { ahead: number; behind: number } {
  const out = git(["rev-list", "--left-right", "--count", `${a}...${b}`]) ?? "0\t0";
  const [left, right] = out.trim().split(/\s+/);
  return { ahead: Number(left ?? 0), behind: Number(right ?? 0) };
}

/** 这个事实在这里算「真」「假」「测不出来」 */
function truth(v: number | null): "真" | "假" | "测不出来" {
  if (v === null) return "测不出来";
  return v === 1 ? "真" : "假";
}

async function evaluate(
  sha: string,
  claims: ReturnType<typeof parseClaims>,
  locators: Map<string, RegExp>,
  trees: ReturnType<typeof openTrees>,
  observer: { at(sha: string): string | null; caches: Map<string, ObserveCache | undefined> },
): Promise<Map<string, number | null>> {
  const tree = trees.at(sha, () => []);
  const vals = new Map<string, number | null>();
  for (const c of claims) {
    // 命令类事实：检出到临时 worktree 再跑。
    //
    // 原来这里是直接记 null（测不出来）。但那等于「这一版看不见」，
    // 不是「测不出来」—— 分支上到底跑不跑得通，是能测的，只是要付一次检出。
    // 所以现在真跑；watch 指定的文件没变就不重跑，靠 nextObservation 的缓存。
    if (isObserved(c.fact)) {
      const observed = await nextObservation({
        fact: c.fact,
        sha,
        paths: c.fact.watch ?? [],
        read: (file) => tree.read(file),
        cache: observer.caches.get(c.id),
        materialize: observer.at,
        run: runCommand,
      });
      observer.caches.set(c.id, observed.cache);
      vals.set(c.id, observed.value);
      continue;
    }
    if (isReferential(c.fact)) {
      const doc = tree.read(c.file) ?? "";
      const m = locators.get(c.id)?.exec(doc);
      vals.set(c.id, m ? evalFact(c.fact, tree, m[1] ?? null) : null);
    } else {
      vals.set(c.id, evalFact(c.fact, tree));
    }
  }
  return vals;
}

async function main(): Promise<void> {
  if (!fs.existsSync(CLAIMS_PATH)) throw new Error(`找不到 ${CLAIMS_PATH}`);
  const claims = parseClaims(JSON.parse(fs.readFileSync(CLAIMS_PATH, "utf8")));
  if (claims.length === 0) throw new Error("claims.json 里没有说法");

  const observed = claims.filter((c) => isObserved(c.fact)).length;
  const observer = {
    ...openWorktree(process.cwd()),
    caches: new Map<string, ObserveCache | undefined>(),
  };
  if (observed > 0) {
    console.log(`要靠跑命令的说法：${observed} 条。会检出到临时工作区执行，跑完删掉，不动主目录。`);
    console.log("");
  }

  const mainRef = MAIN.find((m) => git(["rev-parse", "--verify", `refs/heads/${m}`]) !== null) ?? "HEAD";
  const mainSha = git(["rev-parse", mainRef])?.trim() ?? null;
  if (mainSha === null) throw new Error("读不到 main");
  const short = (s: string): string => s.slice(0, 7);

  const trees = openTrees();
  const locators = new Map(claims.map((c) => [c.id, new RegExp(c.locator)]));
  const mainVals = await evaluate(mainSha, claims, locators, trees, observer);

  const all = branches();
  const results: BranchResult[] = [];
  let skippedMerged = 0;

  for (const b of all) {
    if (!flag("--all") && mergedInto(b.sha, mainSha)) {
      skippedMerged++;
      continue;
    }
    const vals = await evaluate(b.sha, claims, locators, trees, observer);
    const { ahead, behind } = aheadBehind(mainSha, b.sha);
    const date = git(["log", "-1", "--format=%ad", "--date=short", b.sha])?.trim() ?? "";
    const rows: Row[] = [];
    for (const c of claims) {
      const a = mainVals.get(c.id) ?? null;
      const ab = vals.get(c.id) ?? null;
      const ta = truth(a);
      const tb = truth(ab);
      if (ta === tb && a === ab) continue;
      rows.push({
        claim: c.id,
        label: c.label,
        file: c.file,
        main: ta,
        branch: tb,
        fixed: ta === "假" && tb === "真",
        broke: ta === "真" && tb === "假",
        moved: ta === tb && a !== ab,
      });
    }
    results.push({ name: b.name, sha: b.sha, date, ahead, behind, rows });
  }

  // 临时工作区要收掉。放在这里是因为下面还有写文件、打印，出错提前返回也不会漏
  observer.close();

  const payload = { main: { ref: mainRef, sha: mainSha }, skippedMerged, branches: results };

  const out = value("--out");
  if (flag("--json") || out) {
    const text = JSON.stringify(payload, null, 2);
    if (out) {
      fs.writeFileSync(out, text.endsWith("\n") ? text : `${text}\n`, "utf8");
      console.log(`已写出 ${out}`);
    } else console.log(text);
    return;
  }

  console.log(`main = ${short(mainSha)}，共 ${all.length} 个分支，其中已被 main 包含的 ${skippedMerged} 个跳过`);
  console.log("");
  if (results.length === 0) {
    console.log("没有未合并的分支。");
    return;
  }

  const interesting = results.filter((r) => r.rows.some((x) => x.fixed || x.broke));
  for (const r of results) {
    const head = `${r.name}  ${short(r.sha)}  ${r.date}  领先 ${r.ahead} 落后 ${r.behind}`;
    if (r.rows.length === 0) {
      console.log(`${head}\n  和 main 没有差别`);
      continue;
    }
    console.log(head);
    for (const x of r.rows) {
      const mark = x.fixed ? "← 分支上修好了，没合进来" : x.broke ? "← 分支上新坏" : "（值变了，真假没变）";
      console.log(`  ${x.label}  main=${x.main}  分支=${x.branch}  ${mark}`);
    }
  }
  console.log("");
  console.log(interesting.length === 0 ? "没有分支改变某条说法的真假。" : `${interesting.length} 个分支改变了某条说法的真假。`);
}

void main();
void DEFAULT_TOLERANCE;
