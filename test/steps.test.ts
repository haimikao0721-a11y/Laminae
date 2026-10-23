import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SKILL_ROOT, TestRepo, sys, writeClaims } from "./helpers.ts";

// --from / --to：改了解析或规则之后，只重跑受影响的那几步。
//
// 最贵的是第 1 步（逐 commit 测量，vue 上 290 秒）。改判定规则不该重跑它。
//
// 但跳过有风险：中间数据不在的时候，后面几步会读到空文件，然后写出一份
// **看起来正常**的报告 —— 空的引用图、零条说法。那种产物比报错危险得多，
// 因为 verify 只核对「能不能重算」，而空数据重算出来也是空的，一路对得上。
//
// 所以两边都要钉：跳过时先确认输入在（不在就停），跳过之后结果要和完整跑一致。

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(repo: TestRepo, args: string[]): Ran {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("LAMINAE_")) delete env[k];
  const r = spawnSync(process.execPath, [path.join(SKILL_ROOT, "scripts", "run.ts"), ...args], {
    cwd: repo.dir,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function repoWithLevels(): TestRepo {
  const repo = new TestRepo();
  writeClaims(repo, [
    {
      id: "levels",
      file: "README.md",
      locator: "(\\d+) 关",
      fact: { type: "json-length", file: "assets/data/systems.json", path: "levels" },
    },
  ]);
  repo.commit({
    "assets/data/systems.json": sys(3),
    "README.md": "# demo\n\n本作共 3 关。\n",
  });
  return repo;
}

test("--from 跳步时缺中间数据：停下来并说清先跑哪一步", () => {
  const repo = repoWithLevels();
  try {
    const r = run(repo, ["--from", "2", "--run", "x1"]);
    assert.notEqual(r.status, 0, "缺数据不该继续跑");
    assert.match(r.stderr, /缺这些文件/);
    assert.match(r.stderr, /facts\.json/, "要指出具体缺哪份");
    assert.match(r.stderr, /docs-by-commit\.json/);
    assert.match(r.stderr, /--from 1/, "要给出能直接粘的命令");
  } finally {
    repo.dispose();
  }
});

test("--from 认不出步号时列出所有可选步骤", () => {
  const repo = repoWithLevels();
  try {
    const r = run(repo, ["--from", "99", "--run", "x2"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /认不出/);
    assert.match(r.stderr, /逐 commit 测量/);
    assert.match(r.stderr, /渲染 HTML/);
  } finally {
    repo.dispose();
  }
});

test("名字里的一段也认：--from analyze", () => {
  const repo = repoWithLevels();
  try {
    const full = run(repo, ["--run", "full"]);
    assert.equal(full.status, 0, full.stderr);
    const byName = run(repo, ["--from", "analyze", "--run", "byname"]);
    assert.equal(byName.status, 0, byName.stderr);
    assert.match(byName.stdout, /完成/);
  } finally {
    repo.dispose();
  }
});

test("只跑第 5、6 步，产物和完整跑一致", () => {
  const repo = repoWithLevels();
  try {
    const full = run(repo, ["--run", "full"]);
    assert.equal(full.status, 0, full.stderr);

    const part = run(repo, ["--from", "5", "--run", "part"]);
    assert.equal(part.status, 0, part.stderr);

    const load = (id: string): Record<string, unknown> => {
      const p = path.join(repo.dir, ".laminae", "runs", id, "payload.json");
      const j = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
      // 运行 id 与生成时间必然不同，其余应当逐字段一样
      delete j.generatedAt;
      return j;
    };
    assert.deepEqual(load("part"), load("full"), "只跑后半段得到的结论必须和完整跑一样");
  } finally {
    repo.dispose();
  }
});

test("--from 大于 --to 时直接拒绝", () => {
  const repo = repoWithLevels();
  try {
    const r = run(repo, ["--from", "5", "--to", "2", "--run", "x3"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /区间是空的/);
  } finally {
    repo.dispose();
  }
});

test("--to 少跑最后一步时不产出 HTML", () => {
  const repo = repoWithLevels();
  try {
    const full = run(repo, ["--run", "full"]);
    assert.equal(full.status, 0, full.stderr);
    const dataOnly = run(repo, ["--to", "5", "--run", "dataonly"]);
    assert.equal(dataOnly.status, 0, dataOnly.stderr);
    assert.equal(fs.existsSync(path.join(repo.dir, ".laminae", "runs", "dataonly", "laminae.html")), false);
  } finally {
    repo.dispose();
  }
});
