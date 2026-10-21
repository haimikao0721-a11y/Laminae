import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { scoreAccuracy } from "../src/accuracy.ts";
import type { AccuracyRow } from "../src/accuracy.ts";
import { runFile, runLaminae, TestRepo, writeClaims } from "./helpers.ts";
import type { LayerReport } from "../src/layers-core.ts";

test("scoreAccuracy：命中、误报、漏报、没问题", () => {
  const rows: AccuracyRow[] = [
    { id: "a", problem: true, flagged: true },
    { id: "b", problem: false, flagged: true },
    { id: "c", problem: true, flagged: false },
    { id: "d", problem: false, flagged: false },
  ];
  const s = scoreAccuracy(rows);
  assert.deepEqual(s, { tp: 1, fp: 1, fn: 1, tn: 1, precision: 0.5, recall: 0.5 });
  assert.equal(scoreAccuracy([]).precision, null);
});

/**
 * 读者判断是先写死的：这里算不算问题。
 * 工具标没标是跑完才知道。对不上的那些就是当前启发式的误报和漏报。
 */
const READER: { id: string; problem: boolean; why: string }[] = [
  { id: "stub", problem: true, why: "文档说功能在，文件里写着没实现" },
  { id: "empty-route", problem: true, why: "接口挂出去了，处理函数是空的" },
  { id: "barrel", problem: false, why: "文件只是转到一份真有代码的实现，桶文件本身不是假话" },
  { id: "test-only", problem: false, why: "没有说法声称它是功能，只是测试在引用" },
  { id: "small-floor", problem: false, why: "写至少 5、实际 6，下限仍然成立" },
  { id: "wide-floor", problem: false, why: "写至少 1600、实际 1899，下限仍然成立，只是留了余量" },
  { id: "stale-floor", problem: true, why: "写至少 10、实际 40，读者会以为规模还在十几" },
  { id: "return-one", problem: true, why: "文档说功能在，函数只 return 1" },
  { id: "real", problem: false, why: "函数里有真实调用" },
];

test("读者判断对照：假实现和被盖住在这批例子上的误报与漏报", () => {
  const repo = new TestRepo();
  try {
    const icons = JSON.stringify(Array.from({ length: 1899 }, () => 0));
    const items = JSON.stringify(Array.from({ length: 40 }, () => 0));
    const chapters: Record<string, string> = {};
    for (let i = 1; i <= 6; i++) chapters[`chapters/${i}.txt`] = "x\n";
    repo.commit(
      {
        ...chapters,
        "README.md": ["功能：导出", "转发：桶", "常量功能：占位", "真实功能：计算", "共 5+ 关", "提供 1600+ 个图标", "清单 10+ 项"].join("\n") + "\n",
        "data/icons.json": icons,
        "data/items.json": items,
        "src/feature.ts": "// 功能：导出\nthrow new Error('not implemented')\n",
        "src/server.ts": "app.get('/api/users', () => {})\n",
        "src/client.ts": "fetch('/api/users')\n",
        "src/impl.ts": "export function impl() {\n  return work()\n}\n",
        "src/barrel.ts": "// 转发：桶\nexport { impl } from './impl'\n",
        "src/only.ts": "export const only = 1\n",
        "src/only.test.ts": "import './only'\n",
        "src/index.ts": "import './server'\n",
        "src/placeholder.ts": "// 常量功能：占位\nexport function run() {\n  return 1\n}\n",
        "src/real.ts": "// 真实功能：计算\nexport function run() {\n  return work()\n}\n",
      },
      "c0",
    );
    writeClaims(repo, [
      { id: "stub", label: "导出功能", file: "README.md", locator: "(功能：导出)", fact: { type: "text-in-file", file: "src/feature.ts" } },
      { id: "barrel", label: "转发模块", file: "README.md", locator: "(转发：桶)", fact: { type: "text-in-file", file: "src/barrel.ts" } },
      { id: "return-one", label: "常量功能", file: "README.md", locator: "(常量功能：占位)", fact: { type: "text-in-file", file: "src/placeholder.ts" } },
      { id: "real", label: "真实功能", file: "README.md", locator: "(真实功能：计算)", fact: { type: "text-in-file", file: "src/real.ts" } },
      { id: "small-floor", label: "关数下限", file: "README.md", locator: "共 (\\d+)\\+ 关", fact: { type: "count-files", glob: "chapters/*" }, compare: "gte" },
      { id: "wide-floor", label: "图标下限", file: "README.md", locator: "提供 (\\d+)\\+ 个图标", fact: { type: "json-length", file: "data/icons.json" }, compare: "gte" },
      { id: "stale-floor", label: "清单下限", file: "README.md", locator: "清单 (\\d+)\\+ 项", fact: { type: "json-length", file: "data/items.json" }, compare: "gte" },
    ]);
    runLaminae(repo, "scripts/run.ts", ["data"]);
    const payload = JSON.parse(fs.readFileSync(runFile(repo, "payload.json"), "utf8")) as { layers?: LayerReport };
    const layers = payload.layers!;

    const flagged = (id: string): boolean => {
      if (id === "empty-route") return layers.contracts.some((c) => c.fake.some((f) => f.name === "/api/users"));
      if (id === "test-only") return layers.covers.some((c) => c.how === "test-only" && c.label === "src/only.ts");
      if (id === "stub") return layers.hollow.some((h) => h.file === "src/feature.ts");
      if (id === "barrel") return layers.covers.some((c) => c.how === "forward" && c.label === "转发模块");
      if (id === "return-one") return layers.hollow.some((h) => h.file === "src/placeholder.ts") || layers.covers.some((c) => c.label === "常量功能");
      if (id === "real") return layers.hollow.some((h) => h.file === "src/real.ts") || layers.covers.some((c) => c.label === "真实功能");
      const label = { "small-floor": "关数下限", "wide-floor": "图标下限", "stale-floor": "清单下限" }[id];
      return layers.covers.some((c) => c.how === "loose-compare" && c.label === label);
    };

    const rows: AccuracyRow[] = READER.map((g) => ({ id: g.id, problem: g.problem, flagged: flagged(g.id) }));
    const score = scoreAccuracy(rows);
    const fp = rows.filter((r) => !r.problem && r.flagged).map((r) => r.id);
    const fn = rows.filter((r) => r.problem && !r.flagged).map((r) => r.id);

    // 记下来的是这一批上启发式和读者判断的差距，用来防止悄悄变好或变坏时没人看见
    assert.deepEqual(fp.sort(), ["barrel", "test-only", "wide-floor"]);
    assert.deepEqual(fn, []);
    assert.equal(score.tp, 4);
    assert.equal(score.fp, 3);
    assert.equal(score.fn, 0);
    assert.equal(score.tn, 2);
    assert.equal(score.precision, 4 / 7);
    assert.equal(score.recall, 1);
  } finally {
    repo.dispose();
  }
});
