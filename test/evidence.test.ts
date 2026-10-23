import { test } from "node:test";
import assert from "node:assert/strict";
import { EVIDENCE, buildLayers, joinLayers } from "../src/layers/layers-core.ts";
import type { BucketEvidence, Evidence } from "../src/layers/layers-core.ts";
import type { CommitLayer, LayerCommit } from "../src/layers/layers-core.ts";

// 证据等级是这份报告最要紧的分类：**这条结论能拿它做什么**。
//
// 前面十几条误报几乎都是同一个形状 —— 把「本来就该是这样」当成「这里有问题」，
// 根子就是没把「有出处」和「看形状猜」分开。所以这里钉两件事：
//   1. 每个桶都必须有等级，加一个新桶不写等级就编译不过
//   2. 等级的措辞不能越界（看形状推断的那一档不能写成「确认」）

function commit(layer: Partial<CommitLayer>): LayerCommit {
  return {
    files: ["src/a.ts"],
    edges: [],
    layer: { stubs: [], facts: [], declares: [], references: [], clues: [], hollowFns: [], delegates: [], ...layer },
  };
}

test("每个桶都有证据等级，且都在四级之内", () => {
  const report = joinLayers(buildLayers([commit({})]), []);
  const allowed = new Set<Evidence>(["stated", "mentioned", "structural", "heuristic"]);
  const buckets = Object.keys(report).filter((k) => k !== "evidence");
  assert.ok(buckets.length >= 10, "桶的数量不该缩水");
  for (const b of buckets) {
    const grade = (report.evidence as BucketEvidence)[b as keyof BucketEvidence];
    assert.ok(grade !== undefined, `桶 ${b} 没有证据等级`);
    assert.ok(allowed.has(grade), `桶 ${b} 的等级 ${grade} 不在四级之内`);
  }
  assert.equal(Object.keys(report.evidence).length, buckets.length, "等级表要和桶一一对应");
});

test("四个等级各自能做什么、不能做什么，都写清楚了", () => {
  for (const key of ["stated", "mentioned", "structural", "heuristic"] as const) {
    const e = EVIDENCE[key];
    assert.ok(e.label.length > 0, `${key} 没有名字`);
    assert.ok(e.can.length > 0, `${key} 没说能做什么`);
    assert.ok(e.cannot.length > 0, `${key} 没说不能做什么`);
  }
});

test("看形状推断那一档的措辞不能写成结论", () => {
  // 这一档整类整类地错过（测试里的桩、示例里的空 CLI、箭头常量……），
  // 所以它的「能」只允许是「请人看一眼」这种说法，不许出现「确认」「证明」「确实」。
  const h = EVIDENCE.heuristic;
  assert.doesNotMatch(h.can, /确认|证明|确实|一定/, "看形状推断不能说自己确认了什么");
  assert.doesNotMatch(h.cannot, /^$/, "必须写明它不能用来下结论");
  // 结构事实同理：没有入边推出「没用」是这一路最早的一批误报
  assert.doesNotMatch(EVIDENCE.structural.can, /没用|可以删/, "结构事实不能推出「没用」");
});

test("最可靠的几档确实是靠仓库自己写的声明", () => {
  const report = joinLayers(buildLayers([commit({})]), []);
  assert.equal(report.evidence.entry, "stated", "入口点靠的是清单、目录角色这些仓库自己的声明");
  assert.equal(report.evidence.contracts, "stated");
  assert.equal(report.evidence.orphans, "structural", "孤立只有「没有入边」这个结构事实");
  assert.equal(report.evidence.down, "heuristic", "往下看一层看的是函数体形状");
});
