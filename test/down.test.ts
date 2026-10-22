import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLayers, joinLayers } from "../src/layers/layers-core.ts";
import type { CommitLayer, LayerCommit } from "../src/layers/layers-core.ts";

// 「往下看一层」在真实仓库上翻过两次车，这里把两次的教训各钉一条。
//
// 第一次：click 报 100 条，53 条只存在于 2014 年单文件时代的 click.py。
//        混排之后截前 40 条，看到的全是历史噪声。
// 第二次：剩下 47 条「当前成立」里，45 条在 tests/、2 条在 examples/，src/ 里一条都没有。
//        测试里的桩、示例里的空 CLI 是写法本身，不是缺陷。

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

const commit = (files: string[], l: Partial<CommitLayer> = {}): LayerCommit => ({ files, edges: [], layer: layer(l) });

test("往下看一层：测试和演示目录里的空函数不算需要人工复核", () => {
  const data = buildLayers([
    commit(["src/real.ts", "tests/a.ts", "examples/b.py", "src/c.test.ts"], {
      hollowFns: [
        { file: "src/real.ts", name: "unfinished", line: 1, reason: "unimplemented" },
        { file: "tests/a.ts", name: "fixture", line: 1, reason: "empty" },
        { file: "examples/b.py", name: "cli", line: 1, reason: "empty" },
        { file: "src/c.test.ts", name: "stub", line: 1, reason: "empty" },
      ],
    }),
  ]);
  const report = joinLayers(data, []);
  assert.deepEqual(report.down.map((d) => d.name), ["unfinished"], "只有源码里那个才算");
});

test("往下看一层：只存在于历史的条目要标出来，不能当成当前问题", () => {
  const gone: Partial<CommitLayer> = { hollowFns: [{ file: "src/old.ts", name: "legacy", line: 1, reason: "empty" }] };
  const now: Partial<CommitLayer> = { hollowFns: [{ file: "src/new.ts", name: "current", line: 1, reason: "empty" }] };
  const data = buildLayers([commit(["src/old.ts", "src/new.ts"], gone), commit(["src/old.ts", "src/new.ts"], now)]);
  const report = joinLayers(data, []);

  const legacy = report.down.find((d) => d.name === "legacy");
  const current = report.down.find((d) => d.name === "current");
  assert.ok(legacy, "历史条目仍然保留，可查");
  assert.equal(legacy!.atHead, false, "第 0 个提交之后再没出现过");
  assert.ok(current, "当前条目要在");
  assert.equal(current!.atHead, true, "最后一个提交上还在");
});
