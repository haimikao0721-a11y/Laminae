import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLayers, joinLayers } from "../src/layers/layers-core.ts";
import type { CommitLayer, LayerCommit } from "../src/layers/layers-core.ts";

// 分叉树：一个函数经由多条路径到达空壳时，报的跳数应该是**最短**的那条。
//
// 原来是错的，两个原因叠在一起：
//   1. downHops 是无条件覆盖 —— 最后处理到的那条路径赢，不是最短的
//   2. 每条调用边只处理一次（visitedCall 集合）—— 后来发现更近的路也不会重算
//
// 情形（调用图上从入口往下）：
//
//   entry ──> far ──> mid ──> base(空)
//     └────> near ──> base(空)
//
//   near 到 base 是 1 跳，far 到 base 要经过 mid，是 2 跳
//   所以 entry 到空壳是 2 跳（entry→near→base），不是 3 跳

function commit(layer: Partial<CommitLayer>): LayerCommit {
  return {
    files: ["src/a.ts"],
    edges: [["src/a.ts", "src/a.ts"]],
    layer: {
      stubs: [],
      facts: [],
      declares: [],
      references: [],
      clues: [],
      hollowFns: [{ file: "src/a.ts", name: "base", line: 1, reason: "empty" }],
      delegates: [
        { file: "src/a.ts", name: "entry", line: 1, callee: "far", local: true },
        { file: "src/a.ts", name: "entry", line: 2, callee: "near", local: true },
        { file: "src/a.ts", name: "far", line: 3, callee: "mid", local: true },
        { file: "src/a.ts", name: "mid", line: 4, callee: "base", local: true },
        { file: "src/a.ts", name: "near", line: 5, callee: "base", local: true },
      ],
      ...layer,
    },
  };
}

test("分叉树上的跳数取最短的那条路径", () => {
  const report = joinLayers(buildLayers([commit({})]), []);
  const entry = report.down.find((d) => d.name === "entry");
  assert.ok(entry, "entry 应该出现在清单里");
  assert.equal(entry.hops, 2, "entry→near→base 是 2 跳；报 3 就是在用远路");
});

test("只有一条路径时跳数不变", () => {
  const single = commit({
    hollowFns: [{ file: "src/a.ts", name: "base", line: 1, reason: "empty" }],
    delegates: [
      { file: "src/a.ts", name: "entry", line: 1, callee: "mid", local: true },
      { file: "src/a.ts", name: "mid", line: 2, callee: "base", local: true },
    ],
  });
  const report = joinLayers(buildLayers([single]), []);
  const entry = report.down.find((d) => d.name === "entry");
  assert.equal(entry?.hops, 2);
});
