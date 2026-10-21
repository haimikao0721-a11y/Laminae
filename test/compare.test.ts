import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { comparePrefix, describeCompare, inexactWording, satisfies } from "../src/compare.ts";
import { judgeState } from "../src/classify.ts";
import { ABSENT, FALSE, TRUE, UNMEASURED } from "../src/types.ts";
import { LEVELS_CLAIM, runFile, runLaminae, runPipeline, sys, TestRepo } from "./helpers.ts";
import type { ClaimInput } from "../src/types.ts";

test("satisfies：eq、gte、lte 的边界值", () => {
  assert.equal(satisfies(1600, 1600, "eq"), true);
  assert.equal(satisfies(1600, 1899, "eq"), false);
  assert.equal(satisfies(1600, 1600, "gte"), true, "「1600+」恰好 1600 也成立");
  assert.equal(satisfies(1600, 1899, "gte"), true);
  assert.equal(satisfies(1600, 1599, "gte"), false);
  assert.equal(satisfies(50, 50, "lte"), true);
  assert.equal(satisfies(50, 51, "lte"), false);
});

test("satisfies：approx 是相对误差，边界含等号；文档写 0 时只认 0", () => {
  assert.equal(satisfies(2000, 2100, "approx", 0.05), true);
  assert.equal(satisfies(2000, 2101, "approx", 0.05), false);
  assert.equal(satisfies(2000, 1900, "approx", 0.05), true);
  assert.equal(satisfies(2000, 1899, "approx", 0.05), false);
  assert.equal(satisfies(0, 0, "approx"), true);
  assert.equal(satisfies(0, 1, "approx", 0.5), false);
  assert.equal(satisfies(2000, 2100, "approx"), true, "缺省 5%");
});

test("judgeState：compare 只影响真假，不影响「还不存在 / 测不出来」", () => {
  assert.equal(judgeState(1600, 1899), FALSE, "默认严格相等");
  assert.equal(judgeState(1600, 1899, "gte"), TRUE);
  assert.equal(judgeState(null, 5, "gte"), ABSENT);
  assert.equal(judgeState(1600, null, "gte"), UNMEASURED);
});

test("inexactWording：下限、上限、近似的常见写法会被认出来，精确写法不会", () => {
  for (const s of ["provides 1600+ vector", "共 1,600+ 个图标", "约 2000 个", "至少 10 项", "more than 10 files", "over 100 icons", "~50 files", "≥ 3", "up to 8 levels"]) {
    assert.ok(inexactWording(s), s);
  }
  for (const s of ["本作共 12 关", "provides 1600 vector files", "C++ 17 个", "Node 18 or later", "1 + 1 = 2"]) {
    assert.equal(inexactWording(s), null, s);
  }
});

test("comparePrefix / describeCompare", () => {
  assert.equal(comparePrefix("gte"), "≥ ");
  assert.equal(comparePrefix("eq"), "");
  assert.equal(comparePrefix(undefined), "");
  assert.equal(describeCompare("eq"), "");
  assert.match(describeCompare("approx", 0.1), /10%/);
});

const readme = (n: number, suffix = ""): string => `# demo\n\n本作共 ${n}${suffix} 关。\n`;

test("端到端：「N+」按 gte 判——文档写 3+、事实 3 → 5 一直为真；严格相等的同一条说法在事实变化时变假", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "README.md": readme(3, "+"), "assets/data/systems.json": sys(3) }, "c0");
    repo.commit({ "assets/data/systems.json": sys(5) }, "c1 事实涨了");
    repo.commit({ "assets/data/systems.json": sys(2) }, "c2 事实掉到下限以下");
    repo.commit({ "README.md": readme(2, "+") }, "c3 文档跟着改");
    const locator = "(\\d+)\\+? 关";
    const claims: ClaimInput[] = [
      { ...LEVELS_CLAIM, id: "gte", locator, compare: "gte" },
      { ...LEVELS_CLAIM, id: "eq", locator },
    ];
    const r = runPipeline(repo, claims);
    const by = (id: string) => r.results.find((x) => x.id === id)!;
    assert.deepEqual(by("gte").states, [TRUE, TRUE, FALSE, TRUE], "c2 事实 2 < 3 才假，c3 文档改成 2+ 后又真");
    assert.deepEqual(by("eq").states, [TRUE, FALSE, FALSE, TRUE]);
  } finally {
    repo.dispose();
  }
});

test("端到端：严格相等的说法措辞像下限时，终端与页面数据里都带提示；写了 compare 就不再提示", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "README.md": readme(3, "+"), "assets/data/systems.json": sys(5) }, "c0");
    const locator = "(\\d+)\\+? 关";
    runPipeline(repo, [{ ...LEVELS_CLAIM, locator }]);
    const out = runLaminae(repo, "src/analyze.ts");
    assert.match(out, /措辞像是下限/);
    assert.match(out, /3\+ 关/);
    runLaminae(repo, "src/build-data.ts");
    const payload = JSON.parse(fs.readFileSync(runFile(repo, "payload.json"), "utf8")) as { claims: { inexact: string | null; compare: string }[] };
    assert.match(payload.claims[0]!.inexact!, /3\+/);
    assert.equal(payload.claims[0]!.compare, "eq");

    runPipeline(repo, [{ ...LEVELS_CLAIM, locator, compare: "gte" }]);
    assert.doesNotMatch(runLaminae(repo, "src/analyze.ts"), /措辞像是下限/);
    runLaminae(repo, "src/build-data.ts");
    const p2 = JSON.parse(fs.readFileSync(runFile(repo, "payload.json"), "utf8")) as { claims: { inexact: string | null; compare: string }[] };
    assert.equal(p2.claims[0]!.inexact, null);
    assert.equal(p2.claims[0]!.compare, "gte");
  } finally {
    repo.dispose();
  }
});