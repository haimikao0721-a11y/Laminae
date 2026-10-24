#!/usr/bin/env node
/**
 * laminae —— 写 claims.json 之前，在 HEAD 上把每条说法查一遍
 *
 *   node <laminae>/src/lookup.ts 草稿.json
 *   node <laminae>/src/lookup.ts            读 .laminae/claims.json
 *
 * 不把文件读进调用方的上下文：文档用 git 里的那一版，JSON 键和数组长度也在这里查。
 * 要跑命令才知道的事实（测试、不变量、输出差分）这里不执行。
 */
import fs from "node:fs";
import { parseClaims } from "./claims.ts";
import { judgeState, parseClaimedNumber } from "../judge/classify.ts";
import { evalFact, factFiles, isObserved, isReferential } from "./facts.ts";
import type { Tree } from "./facts.ts";
import { assertBoundRepo } from "../core/config.ts";
import { git, openTrees } from "../core/gitutil.ts";
import { CLAIMS_PATH } from "../core/paths.ts";
import type { ClaimDef } from "../core/types.ts";
import { FALSE, TRUE, UNMEASURED } from "../core/types.ts";
import { isEntry } from "../core/entry.ts";

export interface HeadLook {
  id: string;
  label: string;
  file: string;
  /** 捕获到的文本；文档里没有这句为 null */
  captured: string | null;
  /** 事实的数；测不出来、或这条要跑命令，为 null */
  actual: number | null;
  /** 一致 / 不一致 / 测不出来 / 文档里没有 / 要跑命令 */
  verdict: string;
}

/** 一条说法在当前这棵树上查出来是什么。纯函数，测试用 */
export function lookClaim(claim: ClaimDef, body: string, tree: Tree): HeadLook {
  const matched = body ? new RegExp(claim.locator).exec(body) : null;
  const captured = matched?.[1]?.trim() || null;
  if (isObserved(claim.fact)) {
    return { id: claim.id, label: claim.label, file: claim.file, captured, actual: null, verdict: captured ? "要跑命令" : "文档里没有" };
  }
  const want = isReferential(claim.fact) ? (captured ? 1 : null) : captured === null ? null : parseClaimedNumber(captured);
  const actual = want === null && captured === null ? null : isReferential(claim.fact) ? evalFact(claim.fact, tree, captured) : evalFact(claim.fact, tree);
  if (captured === null || want === null) {
    return { id: claim.id, label: claim.label, file: claim.file, captured, actual, verdict: "文档里没有" };
  }
  const state = judgeState(want, actual, claim.compare, claim.tolerance);
  const verdict = state === TRUE ? "一致" : state === FALSE ? "不一致" : state === UNMEASURED ? "测不出来" : "文档里没有";
  return { id: claim.id, label: claim.label, file: claim.file, captured, actual, verdict };
}

function formatLook(row: HeadLook): string {
  const cap = row.captured === null ? "—" : isNumberText(row) ? row.captured : `「${row.captured}」`;
  const got = row.verdict === "要跑命令" ? "不在这里跑" : row.actual === null ? "—" : String(row.actual);
  return `${row.label}  捕获 ${cap}  事实 ${got}  ${row.verdict}  ${row.file}`;
}

function isNumberText(row: HeadLook): boolean {
  return row.captured !== null && parseClaimedNumber(row.captured) !== null && row.verdict !== "要跑命令";
}

function loadText(): string {
  const arg = process.argv[2];
  if (arg) return fs.readFileSync(arg, "utf8").replace(/^\uFEFF/, "");
  if (fs.existsSync(CLAIMS_PATH)) return fs.readFileSync(CLAIMS_PATH, "utf8").replace(/^\uFEFF/, "");
  console.error("用法：node src/lookup.ts <草稿.json>\n没有参数时读 .laminae/claims.json。");
  process.exit(1);
}

function main(): void {
  assertBoundRepo();
  const head = git(["rev-parse", "HEAD"]);
  if (!head) {
    console.error("取不到 HEAD（仓库里没有提交？）");
    process.exit(1);
  }
  let claims: ClaimDef[];
  try {
    claims = parseClaims(JSON.parse(loadText()));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const trees = openTrees();
  const files = [...new Set(claims.flatMap((c) => [c.file, ...factFiles(c.fact)]))];
  const tree = trees.at(head.trim(), () => files);
  let bad = 0;
  for (const claim of claims) {
    const row = lookClaim(claim, tree.read(claim.file) ?? "", tree);
    if (row.verdict !== "一致") bad++;
    console.log(formatLook(row));
  }
  if (bad > 0) console.log(`\n${bad} 条现在对不上。改 locator 或 fact，不要直接写进 claims.json。`);
}

if (isEntry(import.meta.url)) main();
