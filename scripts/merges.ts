#!/usr/bin/env node
/**
 * laminae —— 合并有没有把一个修复弄丢
 *
 *   node <laminae>/scripts/merges.ts            看每次合并前后的取值
 *   node <laminae>/scripts/merges.ts --json     机器可读
 *
 * 回答的问题：**分支上已经把某条说法改成真的了，合并之后它还在吗。**
 *
 * 为什么这条能查 —— 分支删了也没关系：
 *
 *   merge --no-ff  的合并提交有两个父。`<M>^1` 是合并前的 main，`<M>^2` 是那条分支的头。
 *   分支被 `git branch -d` 删掉、远端也删了，`<M>^2` 这个提交仍然挂在合并提交上，
 *   `git show <M>^2:<路径>` 照读不误。**不需要切分支，也不需要那个分支还存在。**
 *
 * 查不到的情况要说清楚（这三类是真的丢了）：
 *
 *   - **squash merge**：分支的提交被压成一个新提交，原始的成了孤儿，gc 之后没了。
 *     能看到的只有压出来的那一个，中间状态永久丢失。
 *   - **rebase merge**：同上，原提交被新写的提交取代。
 *   - **fast-forward**：不产生合并提交，分支提交直接进了 main 的主线 ——
 *     它们本来就在 run 的时间线里，不需要在这里找。
 *
 * 所以这个命令只对 --no-ff 的合并有效，其余在输出里单独计数，不假装查到了。
 */
import fs from "node:fs";
import { parseClaims } from "../src/claims.ts";
import { evalFact, isObserved, isReferential } from "../src/facts.ts";
import { git, openTrees } from "../src/gitutil.ts";
import { CLAIMS_PATH } from "../src/paths.ts";

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(n);
const value = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

type Truth = "真" | "假" | "测不出来";
const truth = (v: number | null): Truth => (v === null ? "测不出来" : v === 1 ? "真" : "假");

interface MergeRow {
  claim: string;
  label: string;
  before: Truth;
  branch: Truth;
  after: Truth;
  /** 分支上是真、合并前是假、合并后还是假 —— 修好了，被合并弄丢了 */
  lost: boolean;
  /** 分支上是假、合并后仍为真 —— 合并挡住了分支的坏改动 */
  kept: boolean;
}

interface MergeResult {
  sha: string;
  short: string;
  date: string;
  subject: string;
  /** 第二父，即被合并那条分支的提交。分支本身可能早就不存在了 */
  branchParent: string;
  rows: MergeRow[];
}

function evaluate(sha: string, claims: ReturnType<typeof parseClaims>, locators: Map<string, RegExp>, trees: ReturnType<typeof openTrees>): Map<string, number | null> {
  const tree = trees.at(sha, () => []);
  const vals = new Map<string, number | null>();
  for (const c of claims) {
    if (isObserved(c.fact)) {
      vals.set(c.id, null);
      continue;
    }
    if (isReferential(c.fact)) {
      const m = locators.get(c.id)?.exec(tree.read(c.file) ?? "");
      vals.set(c.id, m ? evalFact(c.fact, tree, m[1] ?? null) : null);
    } else {
      vals.set(c.id, evalFact(c.fact, tree));
    }
  }
  return vals;
}

function main(): void {
  if (!fs.existsSync(CLAIMS_PATH)) throw new Error(`找不到 ${CLAIMS_PATH}`);
  const claims = parseClaims(JSON.parse(fs.readFileSync(CLAIMS_PATH, "utf8")));
  if (claims.length === 0) throw new Error("claims.json 里没有说法");

  const observed = claims.filter((c) => isObserved(c.fact)).length;
  if (observed > 0) console.log(`注意：${observed} 条说法要靠跑命令，这里不跑，记成「测不出来」。\n`);

  const head = git(["rev-parse", "HEAD"])?.trim();
  if (!head) throw new Error("读不到 HEAD");

  // 只走主线上的合并。--first-parent 保证拿到的是真合进 main 的那些
  const raw = git(["rev-list", "--first-parent", "--merges", "--reverse", head]) ?? "";
  const merges = raw.split("\n").map((s) => s.trim()).filter(Boolean);

  const trees = openTrees();
  const locators = new Map(claims.map((c) => [c.id, new RegExp(c.locator)]));
  const results: MergeResult[] = [];
  let noSecondParent = 0;

  for (const m of merges) {
    const parents = (git(["rev-list", "--parents", "-n", "1", m]) ?? "").trim().split(/\s+/).slice(1);
    if (parents.length < 2) {
      noSecondParent++;
      continue;
    }
    const p1 = parents[0]!;
    const p2 = parents[1]!;
    const before = evaluate(p1, claims, locators, trees);
    const branch = evaluate(p2, claims, locators, trees);
    const after = evaluate(m, claims, locators, trees);

    const rows: MergeRow[] = [];
    for (const c of claims) {
      const b = truth(before.get(c.id) ?? null);
      const br = truth(branch.get(c.id) ?? null);
      const a = truth(after.get(c.id) ?? null);
      // 只留下「三边不全一样」的那些，全一样说明这次合并和这条说法无关
      if (b === br && br === a) continue;
      rows.push({
        claim: c.id,
        label: c.label,
        before: b,
        branch: br,
        after: a,
        // 分支上是真、合并结果不是真 —— 就是丢了。
        // 「合并前」不必是假：文档里那句话可能当时根本还没写（测不出来），也算没修好
        lost: br === "真" && a !== "真",
        kept: br === "假" && b === "真" && a === "真",
      });
    }
    if (rows.length === 0) continue;

    const date = git(["log", "-1", "--format=%ad", "--date=short", m])?.trim() ?? "";
    const subject = git(["log", "-1", "--format=%s", m])?.trim() ?? "";
    results.push({ sha: m, short: m.slice(0, 7), date, subject, branchParent: p2, rows });
  }

  const payload = { head, merges: merges.length, noSecondParent, results };
  const out = value("--out");
  if (flag("--json") || out) {
    const text = JSON.stringify(payload, null, 2);
    if (out) {
      fs.writeFileSync(out, text.endsWith("\n") ? text : `${text}\n`, "utf8");
      console.log(`已写出 ${out}`);
    } else console.log(text);
    return;
  }

  console.log(`主线上 ${merges.length} 次合并${noSecondParent > 0 ? `（${noSecondParent} 次拿不到第二父，跳过）` : ""}`);
  console.log("");
  if (results.length === 0) {
    console.log("没有哪次合并碰到这些说法的真假。");
    return;
  }
  const lost = results.flatMap((r) => r.rows.filter((x) => x.lost).map((x) => ({ r, x })));
  for (const r of results) {
    console.log(`${r.short}  ${r.date}  ${r.subject}`);
    console.log(`  分支提交 ${r.branchParent.slice(0, 7)}（分支可能早就不存在了，这个提交还挂在合并上）`);
    for (const x of r.rows) {
      const mark = x.lost ? "← 分支上修好了，合并后又没了" : x.kept ? "← 分支上是假的，合并保住了 main 的真" : "（三边不全一样）";
      console.log(`  ${x.label}  合并前=${x.before}  分支上=${x.branch}  合并后=${x.after}  ${mark}`);
    }
    console.log("");
  }
  console.log(lost.length === 0 ? "没有合并把修复弄丢。" : `${lost.length} 处修复在合并里被弄丢了。`);
}

main();
