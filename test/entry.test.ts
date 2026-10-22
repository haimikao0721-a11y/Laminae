import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLayers, joinLayers } from "../src/layers/layers-core.ts";
import type { CommitLayer, LayerCommit } from "../src/layers/layers-core.ts";

// 孤立模块的判定在真实仓库上翻过车：click 报出 15 条，15 条全是入口脚本、
// 文档工具和库的公开模块。这里把那次的三类各钉一条，防止再退回去。
//
// 核心区别：**「没有入边」是结构事实，不是缺陷。**
// 有入口证据的进 entry，没有的才进 orphans。

const layer = (l: Partial<CommitLayer>): CommitLayer => ({
  stubs: [],
  facts: [],
  declares: [],
  references: [],
  clues: [],
  hollowFns: [],
  delegates: [],
  ...l,
});

const commit = (files: string[], l: Partial<CommitLayer> = {}): LayerCommit => ({
  files,
  edges: [],
  layer: layer(l),
});

test("入口点：演示、文档工具、包内模块都不算孤立，并且带得出理由", () => {
  const files = [
    "examples/repo/repo.py", // 演示脚本：给人执行的
    "docs/conf.py", // 文档构建配置：给 Sphinx 加载的
    "src/pkg/testing.py", // 包内模块：给使用者 import 的
    "src/lost.py", // 真的没人用
  ];
  const data = buildLayers([
    commit(files, {
      entry: [
        { file: "examples/repo/repo.py", why: "在 examples/ 下" },
        { file: "docs/conf.py", why: "在 docs/ 下" },
        { file: "src/pkg/testing.py", why: "属于 Python 包内的模块" },
      ],
    }),
  ]);

  assert.deepEqual(
    data.entry.map((e) => e.file).sort(),
    ["docs/conf.py", "examples/repo/repo.py", "src/pkg/testing.py"],
    "有入口证据的要单独列出来，不能悄悄消失",
  );
  for (const e of data.entry) assert.ok(e.why.length > 0, `${e.file} 要带理由，报告里要能核对`);

  const report = joinLayers(data, []);
  assert.deepEqual(report.orphans.map((o) => o.file), ["src/lost.py"], "只有一条证据都没有的才算孤立");
});

test("入口点：判据是目录角色，不是文件名", () => {
  // 同一个文件名，放不同目录，结论必须不同
  const data = buildLayers([
    commit(["examples/tool.py", "src/tool.py"], {
      entry: [{ file: "examples/tool.py", why: "在 examples/ 下" }],
    }),
  ]);
  const report = joinLayers(data, []);
  assert.deepEqual(report.orphans.map((o) => o.file), ["src/tool.py"]);
  assert.deepEqual(report.entry.map((e) => e.file), ["examples/tool.py"]);
});


test("孤立：只在历史上没人引用的，不算现在的孤立", () => {
  // vue 上这条让 170 条孤立里有 119 条是历史路径 —— 那些文件在 HEAD 上根本不存在了。
  // 和「往下看一层」是同一个毛病：报的是「曾经没人引用」，不是「现在没人引用」。
  const early = { files: ["src/old.ts", "src/live.ts"] };
  const late = { files: ["src/live.ts"] }; // old.ts 被删了
  const data = buildLayers([
    { ...early, edges: [], layer: layer({}) },
    { ...late, edges: [], layer: layer({}) },
  ]);
  const report = joinLayers(data, []);
  assert.deepEqual(
    report.orphans.map((o) => o.file),
    ["src/live.ts"],
    "已经不在仓库里的文件不该出现在孤立清单里",
  );
});
