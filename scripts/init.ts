#!/usr/bin/env node
/**
 * laminae —— 从文档里挑说法，核一遍，写成 claims.json
 *
 *   node <laminae>/scripts/init.ts             交互式：逐条问，收的写进 .laminae/claims.json
 *   node <laminae>/scripts/init.ts --dry-run   只看候选和核对结果，不写文件
 *   node <laminae>/scripts/init.ts --yes       全收（不交互），适合脚本或 agent 调用
 *   node <laminae>/scripts/init.ts --out d.json  写到别处
 *   node <laminae>/scripts/init.ts --all         候选多的时候全看（默认只看前 20 条）
 *
 * 为什么要这个命令：
 *
 * 上手最难的一步是**从空白文件开始写 claims.json** —— 得会写正则、得知道事实类型、
 * 还得记得捕获组要包住那个数。多数人到这一步就不写了。
 *
 * 这条命令把已有的两个零件串起来：
 *
 *   suggest.ts  从 Markdown 里挑出「像是有数」的句子，出草稿
 *   lookup.ts   在 HEAD 上查一遍：locator 捕获到了什么、事实量出什么值
 *
 * 串起来之后，人只看两列：**捕获到的是不是那句话**、**事实量出来的是什么**。
 *
 * 有一条边界必须写死：**这一步只提议和核对，不判真假。**
 * 草稿里的 fact 多半是占位（数所有文件、到 package.json 找键），
 * 所以「一致」这个结论在这里几乎不会出现，出现了也说明不了什么。
 * 真正要人做的是**把 fact 改成该数的东西** —— 命令只保证 locator 抓对了文字。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { assertBoundRepo, REPO } from "../src/core/config.ts";
import { git, openTrees } from "../src/core/gitutil.ts";
import { CLAIMS_PATH } from "../src/core/paths.ts";
import { factFiles } from "../src/measure/facts.ts";
import { lookClaim } from "../src/measure/lookup.ts";
import type { HeadLook } from "../src/measure/lookup.ts";
import { draftsFromGrep } from "../src/output/suggest.ts";
import type { ClaimDraft } from "../src/output/suggest.ts";
import type { ClaimDef, ClaimInput } from "../src/core/types.ts";

const flag = (name: string): boolean => process.argv.includes(name);
const arg = (name: string): string | null => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

/** 草稿里的事实是不是占位。占位的意思：量出来的数和文档那句话没有关系 */
const PLACEHOLDER = (d: ClaimDraft): boolean =>
  (d.fact.type === "count-files" && (d.fact.glob === "**/*" || d.fact.glob === undefined)) ||
  (d.fact.type === "json-has-key" && d.fact.path === "scripts");

function toClaim(d: ClaimDraft): ClaimInput {
  return {
    id: d.id,
    label: d.label,
    file: d.file,
    locator: d.locator,
    ...(d.compare ? { compare: d.compare } : {}),
    fact: d.fact as ClaimInput["fact"],
  };
}

interface Row {
  draft: ClaimDraft;
  look: HeadLook;
  placeholder: boolean;
}

/** 一条候选值不值得收：locator 在那份文档里真的抓到了东西 */
const usable = (r: Row): boolean => r.look.captured !== null;

function print(r: Row, n: number, mark: string): void {
  const cap = r.look.captured === null ? "（没抓到）" : JSON.stringify(r.look.captured);
  const got = r.look.actual === null ? "—" : String(r.look.actual);
  console.log(`  ${mark} ${String(n).padStart(2)}  ${r.draft.label}`);
  console.log(`        ${r.draft.file}  →  捕获 ${cap}   事实 ${got}${r.placeholder ? "（占位）" : ""}`);
}

async function ask(rl: readline.Interface): Promise<string> {
  return new Promise((resolve) => rl.question("  收这条吗？[y/N/q] ", (a) => resolve(a.trim().toLowerCase())));
}

async function main(): Promise<void> {
  assertBoundRepo();
  const head = git(["rev-parse", "HEAD"]);
  if (!head) {
    console.error("取不到 HEAD（仓库里还没有提交？）");
    process.exit(1);
  }

  const all = draftsFromGrep(REPO);
  // 真实的 README / CHANGELOG 能挑出几十条候选，一次全铺开看不动。
  // 默认只显示前 20 条，--limit 可以改，--all 全看。
  const limit = flag("--all") ? all.length : Number(arg("--limit") ?? 20);
  const drafts = all.slice(0, Math.max(1, limit));
  if (drafts.length < all.length) {
    console.log(`挑出 ${all.length} 条候选，先看前 ${drafts.length} 条。--all 看全部，--limit N 改条数。\n`);
  }
  if (drafts.length === 0) {
    console.log("文档里没找到「像是有个数字」的句子。");
    console.log("这不是失败：这个仓库的文档可能本来就没有可核对的数，");
    console.log("或者写法不在现有规则里（例如只有英文的词数、没有阿拉伯数字）。");
    console.log("要手写说法的话，照着 docs/PATTERNS.md 挑。");
    return;
  }

  // 在 HEAD 上逐条核对。要用到事实点名的文件，所以整批一次读出来
  const trees = openTrees();
  const files = [...new Set(drafts.flatMap((d) => [d.file, ...factFiles(d.fact as ClaimInput["fact"])]))];
  const tree = trees.at(head.trim(), () => files);
  const rows: Row[] = drafts.map((d) => ({
    draft: d,
    look: lookClaim(toClaim(d) as ClaimDef, tree.read(d.file) ?? "", tree),
    placeholder: PLACEHOLDER(d),
  }));

  const good = rows.filter(usable);
  const bad = rows.filter((r) => !usable(r));

  console.log(`从文档里挑出 ${rows.length} 条候选。先看核对结果，再决定收哪些：\n`);
  rows.forEach((r, i) => print(r, i + 1, usable(r) ? "·" : "×"));

  if (bad.length > 0) {
    console.log(`\n  标 × 的 ${bad.length} 条：locator 在那份文档里没抓到东西。`);
    console.log("  多半是文档里那句话的写法变了。**不要收**，收了整段历史都会是「尚未写入文档」。");
  }
  const placeholders = good.filter((r) => r.placeholder).length;
  if (placeholders > 0) {
    console.log(`\n  标「占位」的 ${placeholders} 条：事实类型还是数所有文件那类默认值，`);
    console.log("  量出来的数和文档那句话没关系。**locator 可以收，fact 必须改。**");
    console.log("  改哪个字段见 docs/PATTERNS.md。");
  }
  console.log("\n  这一步只提议和核对，不判真假 —— 真假要跑完流水线才算得出来。\n");

  const dryRun = flag("--dry-run");
  const assumeYes = flag("--yes");
  const outFile = arg("--out") ?? CLAIMS_PATH;

  if (dryRun) {
    console.log(`--dry-run：不写文件。去掉这个参数就会写 ${path.relative(REPO, outFile)}。`);
    return;
  }
  if (good.length === 0) {
    console.log("没有一条能收（locator 全都没抓到）。不写文件。");
    return;
  }

  // 不是 TTY 又没给 --yes 时不写 —— 不能让一条自动化命令悄悄改掉用户的输入文件
  const interactive = process.stdin.isTTY === true && !assumeYes;
  if (!interactive && !assumeYes) {
    console.log("当前不是交互环境，也没有 --yes，所以不写文件。");
    console.log("  确认要全收就加 --yes；只想看就加 --dry-run。");
    return;
  }

  const chosen: ClaimDraft[] = [];
  if (assumeYes) {
    chosen.push(...good.map((r) => r.draft));
    console.log(`--yes：收下全部 ${chosen.length} 条能用的。`);
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (const [i, r] of rows.entries()) {
        if (!usable(r)) continue;
        const a = await ask(rl);
        if (a === "q") break;
        if (a === "y") chosen.push(r.draft);
        void i;
      }
    } finally {
      rl.close();
    }
  }

  if (chosen.length === 0) {
    console.log("一条都没收，不写文件。");
    return;
  }

  if (fs.existsSync(outFile)) {
    console.error(`\n${path.relative(REPO, outFile)} 已经存在。`);
    console.error("  这是你的输入文件，不覆盖。要重新生成，先自己挪走或删掉它。");
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(chosen.map(toClaim), null, 2)}\n`, "utf8");
  console.log(`\n已写入 ${path.relative(REPO, outFile)}，${chosen.length} 条。`);
  console.log("  下一步：把标「占位」的 fact 改成该数的东西，然后跑");
  console.log("    node <laminae>/src/lookup.ts       在 HEAD 上再核一遍");
  console.log("    node <laminae>/scripts/run.ts      跑完整流水线");
}

void main();
