#!/usr/bin/env node
/**
 * laminae —— 逐 commit 的模块引用关系
 *
 *   node <laminae>/src/graph.ts      在要核验的项目目录下运行
 *
 * 对主线上每个 commit，从 git 对象库取出代码文件之间的 import / require 引用（JS/TS、Python），
 * 折成「哪条边在哪些 commit 区间里存在」，写到 .laminae/data/graph.json。
 *
 * 只读 git 对象，不检出。扫描本身（常驻读取、按 blob 缓存、代码没变就沿用）在 scan.ts 里，
 * 想法与边界判定「A 不许引用 B」时用的是同一份。
 */
import fs from "node:fs";
import path from "node:path";
import { assertBoundRepo, LOG_ARGS, VERBOSE } from "../core/config.ts";
import { ensureExcluded } from "../core/exclude.ts";
import { buildGraph } from "./graph-core.ts";
import type { CommitGraph } from "./graph-core.ts";
import { buildLayers } from "./layers-core.ts";
import type { LayerCommit } from "./layers-core.ts";
import { commitShas } from "../core/gitutil.ts";
import { DATA_DIR } from "../core/paths.ts";
import { ImportScanner } from "./scan.ts";

assertBoundRepo();
ensureExcluded();

const shas = commitShas(LOG_ARGS);
if (shas.length === 0) {
  console.error("取不到提交历史（仓库里没有提交？）");
  process.exit(1);
}

const scanner = new ImportScanner();
const perCommit: CommitGraph[] = [];
const layerCommits: LayerCommit[] = [];

for (const [i, sha] of shas.entries()) {
  const scan = await scanner.scan(sha);
  perCommit.push(scan.graph);
  layerCommits.push({ files: scan.graph.files, edges: scan.graph.edges, layer: scan.layer });

  const every = VERBOSE ? 10 : 500;
  if ((i + 1) % every === 0 && i + 1 < shas.length) console.log(`  已扫 ${i + 1}/${shas.length}`);
}
scanner.close();

const graph = buildGraph(perCommit);
const layers = buildLayers(layerCommits);

fs.mkdirSync(DATA_DIR, { recursive: true });
const outFile = path.join(DATA_DIR, "graph.json");
fs.writeFileSync(outFile, JSON.stringify(graph) + "\n", "utf8");
fs.writeFileSync(path.join(DATA_DIR, "layers.json"), JSON.stringify(layers) + "\n", "utf8");

const head = perCommit.at(-1)!;
console.log(`引用关系：${shas.length} 个 commit，其中 ${scanner.scanned} 个的代码有变化，共读了 ${scanner.blobsRead} 个文件正文`);
if (graph.nodes.length === 0) {
  console.log("  没有找到可解析的 JS/TS/Python 代码，页面里不会有「调用关系」一节（Go、Rust 等暂不支持）");
} else {
  console.log(
    `  历史上出现过 ${graph.fileCount} 个代码文件` +
      (graph.level === "dir" ? `，太多，按目录前 ${graph.depth} 级合并成 ${graph.nodes.length} 个节点` : "") +
      `；HEAD 上 ${head.files.length} 个文件、${head.edges.length} 条引用`,
  );
}
console.log(`\n已写入 ${outFile}`);
