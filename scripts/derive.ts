#!/usr/bin/env node
/**
 * laminae —— 分批推测想法（命令行入口）
 *
 *   node <laminae>/scripts/derive.ts --plan              取下一批要看的函数
 *   node <laminae>/scripts/derive.ts --plan --batch 3    指定第几批
 *   node <laminae>/scripts/derive.ts --accept out.json   收一批结果
 *   node <laminae>/scripts/derive.ts --status            看进度
 *
 * 在目标项目目录下运行。它只做三件事：挑函数、给取证命令、验回来的结果。
 * 推断由 agent 做 —— 但结论必须表达成一条可测量的事实，否则进 notes，不进 ideas。
 *
 * 状态：.laminae/derive/state.json
 * 产物：.laminae/derive/batch-<n>.json（--plan 时写出）、.laminae/ideas.json（--accept 时追加）
 */
import fs from "node:fs";
import path from "node:path";
import { assertBoundRepo } from "../src/core/config.ts";
import { DERIVE_DIR, acceptBatch, batchAt, ensurePlan, readNotes, readStateOrNull } from "../src/ideas/derive.ts";
import { IDEAS_PATH } from "../src/core/paths.ts";

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const value = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function main(): Promise<void> {
  assertBoundRepo();

  if (flag("--status")) {
    const s = readStateOrNull();
    if (!s) {
      console.log("还没有开始。先跑 --plan 生成计划。");
      return;
    }
    const notes = readNotes();
    console.log(`计划 ${s.plan.length} 个函数，每批 ${s.batchSize} 个`);
    console.log(`已推进到第 ${s.nextBatch} 批，接受 ${s.accepted.length} 条，笔记 ${notes.length} 条`);
    return;
  }

  if (flag("--plan")) {
    const size = Number(value("--size") ?? "") || undefined;
    const max = Number(value("--max") ?? "") || undefined;
    const state = await ensurePlan(size, max);
    if (state.plan.length === 0) {
      console.log("没有值得推测的函数（都很短，或者已经知道是空实现）。");
      return;
    }
    const n = value("--batch") === undefined ? state.nextBatch : Number(value("--batch"));
    if (!Number.isInteger(n) || n < 0) throw new Error("--batch 必须是非负整数");
    const b = batchAt(state, n);
    if (b.items.length === 0) {
      console.log(`第 ${n} 批是空的，计划共 ${b.of} 批。`);
      return;
    }
    fs.mkdirSync(DERIVE_DIR, { recursive: true });
    const out = path.join(DERIVE_DIR, `batch-${n}.json`);
    fs.writeFileSync(out, `${JSON.stringify(b, null, 2)}\n`, "utf8");
    console.log(`第 ${n + 1}/${b.of} 批，${b.items.length} 个函数，还剩 ${b.remaining} 个`);
    console.log(`已写出 ${out}`);
    console.log("");
    console.log("下一步：对每一项跑 context 里的命令，然后把结果写进一个 JSON：");
    console.log(`  node <laminae>/scripts/derive.ts --accept <结果文件>`);
    console.log("");
    console.log("结果格式（results 里每条都必须带 evidence 和 fact）：");
    console.log(
      JSON.stringify(
        {
          batch: n,
          results: [
            {
              id: b.items[0]!.id,
              text: "这个函数在做什么（一句话）",
              target: "被检查的路径或文本",
              fact: { type: "path-exists" },
              evidence: [b.items[0]!.context],
            },
          ],
          notes: [{ id: "", why: "为什么这条写不成可测量的事实" }],
        },
        null,
        2,
      ),
    );
    return;
  }

  const acceptPath = value("--accept");
  if (acceptPath) {
    const state = readStateOrNull();
    if (!state) throw new Error("还没有计划。先跑 --plan。");
    const raw: unknown = JSON.parse(fs.readFileSync(acceptPath, "utf8").replace(/^\uFEFF/, ""));
    const batchNo = typeof (raw as Record<string, unknown>)["batch"] === "number" ? ((raw as Record<string, unknown>)["batch"] as number) : state.nextBatch;
    const { result } = acceptBatch(raw, state, batchNo);
    console.log(`接受 ${result.accepted} 条，笔记 ${result.noted} 条`);
    for (const r of result.rejected.slice(0, 10)) console.log(`  退回 ${r.id}：${r.reason}`);
    if (result.rejected.length > 10) console.log(`  …… 还有 ${result.rejected.length - 10} 条退回`);
    if (result.accepted > 0) console.log(`已写进 ${IDEAS_PATH}`);
    return;
  }

  console.log("用法：--plan [--batch N] [--size K] | --accept <file> | --status");
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});

