/**
 * skill 用法：在任意项目目录下运行，生成物全部落在该项目里，laminae 自己的目录不被写入。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEVELS_CLAIM, readme, runFile, SKILL_ROOT, sys, TestRepo, writeClaims } from "./helpers.ts";

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("LAMINAE_")) delete env[k];
  return env;
}

function runAll(cwd: string) {
  return spawnSync(process.execPath, [path.join(SKILL_ROOT, "scripts", "run.ts")], { cwd, env: cleanEnv(), encoding: "utf8" });
}

test("全流程：在项目目录下运行，报告生成在项目里，且是自包含的单文件", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "assets/data/systems.json": sys(3), "README.md": readme(3) });
    repo.commit({ "assets/data/systems.json": sys(5) });
    repo.commit({ "README.md": readme(5) });
    writeClaims(repo, [LEVELS_CLAIM]);

    const r = runAll(repo.dir);
    assert.equal(r.status, 0, r.stderr);

    const htmlPath = runFile(repo, "laminae.html");
    assert.ok(fs.existsSync(htmlPath), "项目根目录下应有 laminae.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    assert.ok(html.includes("window.__LAMINAE__"), "数据内联");
    assert.ok(html.includes("关数"), "说法标签在数据里");
    assert.ok(!/<script[^>]+\ssrc=/i.test(html), "不能有外部脚本");
    assert.ok(!/<link[^>]+rel=["']?stylesheet/i.test(html), "不能有外部样式");
    assert.ok(!/(?:src|href)=["']https?:\/\//i.test(html.replace(/<a [^>]*>/g, "")), "除链接外不能有外部资源");

    // 目标仓库的已跟踪文件不能被改动，生成物都是新增的未跟踪文件
    const status = repo.git("status", "--porcelain").split("\n").filter(Boolean);
    assert.ok(status.every((l) => l.startsWith("??")), `只允许新增未跟踪文件，实际：${status.join(" | ")}`);
  } finally {
    repo.dispose();
  }
});

test("不会往 laminae 自己的目录写生成物", () => {
  const before = execFileSync("git", ["-C", SKILL_ROOT, "status", "--porcelain"], { encoding: "utf8" });
  const repo = new TestRepo();
  try {
    repo.commit({ "assets/data/systems.json": sys(3), "README.md": readme(3) });
    writeClaims(repo, [LEVELS_CLAIM]);
    assert.equal(runAll(repo.dir).status, 0);
  } finally {
    repo.dispose();
  }
  const after = execFileSync("git", ["-C", SKILL_ROOT, "status", "--porcelain"], { encoding: "utf8" });
  assert.equal(after, before);
});

test("在 laminae 自己的仓库里运行：直接停，不写生成物", () => {
  const before = execFileSync("git", ["-C", SKILL_ROOT, "status", "--porcelain"], { encoding: "utf8" });
  const r = runAll(SKILL_ROOT);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /不能当被核验的项目/);
  const after = execFileSync("git", ["-C", SKILL_ROOT, "status", "--porcelain"], { encoding: "utf8" });
  assert.equal(after, before);
  assert.equal(fs.existsSync(path.join(SKILL_ROOT, ".laminae")), false);
  assert.equal(fs.existsSync(path.join(SKILL_ROOT, "laminae.html")), false);
});

test("不在 git 仓库里运行：明确报错，不写任何文件", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laminae-nogit-"));
  try {
    const r = runAll(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /不在 git 仓库里/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("缺少 claims.json：报错并说明路径", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "README.md": readme(3) });
    const r = runAll(repo.dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /找不到说法定义文件/);
    assert.ok(r.stderr.includes(".laminae"), "要指出该放在 .laminae/ 下");
  } finally {
    repo.dispose();
  }
});

test("claims.json 写错：报错指出具体哪一条", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "README.md": readme(3) });
    writeClaims(repo, [{ id: "x", file: "README.md", locator: "(\\d+) 关", fact: { type: "bad" } }]);
    const r = runAll(repo.dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /claims\[0\].*fact\.type/s);
  } finally {
    repo.dispose();
  }
});
