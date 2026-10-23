import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 改一条结构规则之后，怎么知道它影响了哪些结论。
//
// 这个工具的维护成本几乎全在结构识别那一侧（语法模块、入口表、引用图、空壳判定），
// 那一侧的工作循环是「再摁一个真仓库、对完红格、补一条规则」。
// 没有 diff，就只能翻两份 payload.json 几千条状态逐个对 —— 看不见影响就不敢改规则。
//
// 这里钉三件事：
//   1. 说法的状态序列从哪个 commit 开始不同、影响多少格
//   2. 层那几档集合的增减，要列到具体文件
//   3. 提交序列不一样时必须报出来，不能静默错位

const SKILL_ROOT = path.resolve(import.meta.dirname, "..");

interface MiniCommit {
  sha: string;
  short: string;
  date: string;
}

function commit(n: number): MiniCommit {
  const sha = String(n).padStart(40, "a");
  return { sha, short: sha.slice(0, 7), date: `2026-01-${String(n).padStart(2, "0")}` };
}

function payload(opts: {
  commits: MiniCommit[];
  states: Record<string, number[]>;
  orphans?: string[];
  convention?: string[];
  edges?: { s: number; t: number }[];
}): unknown {
  return {
    title: "t",
    subtitle: "s",
    repo: "demo",
    commits: opts.commits,
    claims: Object.entries(opts.states).map(([id, states]) => ({
      id,
      label: id,
      file: "README.md",
      locator: "(x)",
      states,
      kind: "claim",
      runs: [],
    })),
    summary: {},
    graph: { nodes: [{ id: "." }], edges: opts.edges ?? [] },
    layers: {
      hollow: [],
      covers: [],
      unproven: [],
      orphans: (opts.orphans ?? []).map((file) => ({ file, alive: [[0, 0]] })),
      convention: (opts.convention ?? []).map((file) => ({ file, alive: [[0, 0]] })),
      entry: [],
      contracts: [],
      clues: [],
      unsupported: [],
      down: [],
      evidence: {},
    },
  };
}

/** 造一个带两次运行的临时仓库 */
function makeRepo(runs: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laminae-diff-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
  for (const [id, p] of Object.entries(runs)) {
    const d = path.join(dir, ".laminae", "runs", id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "payload.json"), JSON.stringify(p), "utf8");
  }
  return dir;
}

function runDiff(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("LAMINAE_")) delete env[k];
  const r = spawnSync(process.execPath, [path.join(SKILL_ROOT, "scripts", "diff.ts"), ...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("说法序列：报出第一个不同的 commit、影响几格、分成几段", () => {
  const commits = [1, 2, 3, 4, 5].map(commit);
  const dir = makeRepo({
    old: payload({ commits, states: { levels: [0, 0, 0, 0, 0] } }),
    neu: payload({ commits, states: { levels: [0, 1, 1, 0, 0] } }),
  });
  try {
    const r = runDiff(dir, ["old", "neu"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /levels：2 格不同，第一个从 #1 起/);
    assert.match(r.stdout, /#1–#2 {2}真 → 假/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("两次完全一样时明确说没有差异，不是空输出", () => {
  const commits = [1, 2].map(commit);
  const dir = makeRepo({
    a: payload({ commits, states: { levels: [0, 1] } }),
    b: payload({ commits, states: { levels: [0, 1] } }),
  });
  try {
    const r = runDiff(dir, ["a", "b"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /没有差异/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("层：集合增减列到具体文件", () => {
  const commits = [1].map(commit);
  const dir = makeRepo({
    before: payload({ commits, states: { levels: [0] }, orphans: ["a.ts", "b.ts"] }),
    after: payload({ commits, states: { levels: [0] }, orphans: ["b.ts"], convention: ["a.ts"] }),
  });
  try {
    const r = runDiff(dir, ["before", "after"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /orphans {2}2 → 1/);
    assert.match(r.stdout, /- a\.ts/);
    assert.match(r.stdout, /convention {2}0 → 1/);
    assert.match(r.stdout, /\+ a\.ts/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("提交序列不一样：按 sha 对齐并明确警告，不静默错位", () => {
  const a = [1, 2, 3].map(commit);
  const b = [2, 3, 4].map(commit); // 前面少一个、后面多一个
  // 状态要按 commit 对齐：c1 是假、c2/c3 是真，新的那次没有 c1、多一个 c4
  const dir = makeRepo({
    old: payload({ commits: a, states: { levels: [1, 0, 0] } }),
    neu: payload({ commits: b, states: { levels: [0, 0, 1] } }),
  });
  try {
    const r = runDiff(dir, ["old", "neu"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /提交序列不一样/, "必须明确说出来");
    assert.match(r.stdout, /按 sha 对齐后能比的 2 个/);
    assert.match(r.stdout, /只在旧的那次里有 1 个/);
    assert.match(r.stdout, /只在新的一次里有 1 个/);
    // 对齐之后能比的那两格是一样的，所以说法不该报差异
    assert.doesNotMatch(r.stdout, /levels：/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--json 给机器读的形态，字段够下游用", () => {
  const commits = [1, 2].map(commit);
  const dir = makeRepo({
    old: payload({ commits, states: { levels: [0, 0] } }),
    neu: payload({ commits, states: { levels: [0, 1] }, orphans: ["x.ts"] }),
  });
  try {
    const r = runDiff(dir, ["old", "neu", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout) as {
      from: string;
      to: string;
      claims: { id: string; firstAt: number | null; cells: number }[];
      layers: { bucket: string; added: string[]; removed: string[] }[];
      clean: boolean;
    };
    assert.equal(j.from, "old");
    assert.equal(j.to, "neu");
    assert.equal(j.clean, false);
    const levels = j.claims.find((c) => c.id === "levels")!;
    assert.equal(levels.cells, 1);
    assert.equal(levels.firstAt, 1);
    assert.deepEqual(j.layers.find((l) => l.bucket === "orphans")!.added, ["x.ts"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("运行 id 不存在时说清楚有哪些可用的", () => {
  const dir = makeRepo({ only: payload({ commits: [1].map(commit), states: { levels: [0] } }) });
  try {
    const r = runDiff(dir, ["nope", "only"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /找不到/);
    assert.match(r.stderr, /only/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
