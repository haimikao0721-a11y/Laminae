import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { kaplanMeier, summarizeClosure } from "../src/judge/survival.ts";
import type { Obs } from "../src/judge/survival.ts";
import { LEVELS_CLAIM, readme, runFile, runLaminae, sys, TestRepo, writeClaims } from "./helpers.ts";

const ev = (...t: number[]): Obs[] => t.map((time) => ({ time, event: true }));
const ce = (...t: number[]): Obs[] => t.map((time) => ({ time, event: false }));
const near = (a: number, b: number, eps = 5e-4): void => assert.ok(Math.abs(a - b) < eps, `${a} 应接近 ${b}`);

test("Kaplan-Meier：教科书例子（6-MP 组，21 例，9 例结束）", () => {
  const km = kaplanMeier([...ev(6, 6, 6, 7, 10, 13, 16, 22, 23), ...ce(6, 9, 10, 11, 17, 19, 20, 25, 32, 32, 34, 35)]);
  assert.equal(km.n, 21);
  assert.equal(km.events, 9);
  assert.equal(km.censored, 12);
  const at = (t: number): number => km.curve.find((p) => p.t === t)!.surv;
  near(at(6), 0.857);
  near(at(7), 0.807);
  near(at(10), 0.753);
  near(at(13), 0.69);
  near(at(16), 0.627);
  near(at(22), 0.538);
  near(at(23), 0.448);
  assert.equal(km.median, 23);
});

test("Kaplan-Meier：没有删失时与朴素中位数一致", () => {
  const km = kaplanMeier(ev(1, 2, 3, 4));
  near(km.curve[0]!.surv, 0.75);
  near(km.curve[1]!.surv, 0.5);
  assert.equal(km.median, 2);
});

test("Kaplan-Meier：全是删失，中位数无法估计，而不是 0 或最大值", () => {
  const km = kaplanMeier(ce(3, 5, 9));
  assert.equal(km.median, null);
  assert.equal(km.events, 0);
  assert.deepEqual(km.curve, []);
});

test("Kaplan-Meier：曲线没降到 50% 时中位数为 null", () => {
  // 2 段结束、6 段仍挂着：S(1)=7/8，S(2)=7/8×6/7=0.75，始终高于 0.5
  const km = kaplanMeier([...ev(1, 2), ...ce(10, 10, 10, 10, 10, 10)]);
  assert.ok(km.curve.at(-1)!.surv > 0.5);
  assert.equal(km.median, null);
});

test("Kaplan-Meier：同一时刻既有结束又有删失，删失的仍算在风险中", () => {
  const km = kaplanMeier([...ev(5), ...ce(5)]);
  assert.equal(km.curve[0]!.atRisk, 2);
  near(km.curve[0]!.surv, 0.5);
  assert.equal(km.median, 5);
});

test("Kaplan-Meier：空样本", () => {
  const km = kaplanMeier([]);
  assert.equal(km.n, 0);
  assert.equal(km.median, null);
});

test("朴素中位数把刚开始挂着的段当成「只挂了 1 个 commit」，被拉低；Kaplan-Meier 不会", () => {
  // 两段分别挂了 5、6 个 commit 后结束；另有 3 段刚变假 1 个 commit，仍挂着
  const obs = [...ev(5, 6), ...ce(1, 1, 1)];
  const sorted = obs.map((o) => o.time).sort((a, b) => a - b);
  assert.equal(sorted[Math.floor(sorted.length / 2)], 1, "朴素中位数 = 1");
  assert.equal(kaplanMeier(obs).median, 5, "5 个 commit 时，风险集里只剩两段，其中一段结束，S = 0.5");
});

test("收场方向汇总", () => {
  const c = summarizeClosure({
    "doc-caught-up": 3,
    "doc-corrected": 1,
    "doc-removed": 2,
    "reality-caught-up": 4,
    "both-changed": 1,
    unmeasurable: 1,
    anomaly: 1,
    "hanging-reality-still": 2,
    "hanging-reality-moved": 1,
  });
  assert.deepEqual(c, {
    docUpdated: 4,
    docRemoved: 2,
    realityFixed: 4,
    undetermined: 3,
    pending: 3,
    determinable: 10,
  });
});

interface PayloadSummary {
  summary: {
    runCount: number;
    bornFalse: number;
    survival: { n: number; events: number; censored: number; medianCommits: number | null };
    closure: { docUpdated: number; pending: number; determinable: number };
  };
  claims: { runs: { bornFalse: boolean; censored: boolean }[] }[];
}

function payloadOf(repo: TestRepo): PayloadSummary {
  runLaminae(repo, "scripts/run.ts", ["data"]);
  return JSON.parse(fs.readFileSync(runFile(repo, "payload.json"), "utf8")) as PayloadSummary;
}

test("端到端：仍挂着的假段按右删失进入估计", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "assets/data/systems.json": sys(3), "README.md": readme(3) }); // 0 真
    repo.commit({ "assets/data/systems.json": sys(4) }); // 1 假
    repo.commit({ "README.md": readme(4) }); // 2 真：第一段假段，长 1，已结束
    repo.commit({ "x.txt": "x" }); // 3
    repo.commit({ "assets/data/systems.json": sys(5) }); // 4 假
    repo.commit({ "y.txt": "y" }); // 5 假，到 HEAD：第二段，长 2，右删失
    writeClaims(repo, [LEVELS_CLAIM]);

    const p = payloadOf(repo);
    assert.equal(p.summary.runCount, 2);
    assert.equal(p.summary.survival.n, 2);
    assert.equal(p.summary.survival.events, 1);
    assert.equal(p.summary.survival.censored, 1);
    // 两个观察：(1, 结束) 与 (2, 删失) → 在 1 处 S = 1/2，中位数 = 1
    assert.equal(p.summary.survival.medianCommits, 1);
    assert.equal(p.summary.closure.docUpdated, 1);
    assert.equal(p.summary.closure.pending, 1);
  } finally {
    repo.dispose();
  }
});

test("端到端：写下即假的那一段不进样本，但仍计入假段数和收场方向", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "assets/data/systems.json": sys(3), "README.md": readme(5) }); // 0 假：写下即假
    repo.commit({ "README.md": readme(3) }); // 1 真：文档被改正
    repo.commit({ "assets/data/systems.json": sys(4) }); // 2 假
    repo.commit({ "README.md": readme(4) }); // 3 真：文档追上现实
    writeClaims(repo, [LEVELS_CLAIM]);

    const p = payloadOf(repo);
    assert.equal(p.summary.bornFalse, 1);
    assert.equal(p.summary.runCount, 2);
    assert.equal(p.summary.survival.n, 1, "样本只含先真后假的那一段");
    assert.deepEqual(
      p.claims[0]!.runs.map((r) => r.bornFalse),
      [true, false],
    );
    assert.equal(p.summary.closure.determinable, 2);
  } finally {
    repo.dispose();
  }
});
