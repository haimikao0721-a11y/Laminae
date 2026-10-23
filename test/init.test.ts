import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 上手最难的一步是**从空白文件开始写 claims.json**：得会写正则、得知道事实类型、
// 还得记得捕获组要包住那个数。多数人到这一步就不写了。
//
// scripts/init.ts 把已有的两个零件串起来（suggest 出草稿 + lookup 在 HEAD 上核对），
// 让人只看两列：捕获到的是不是那句话、事实量出来的是什么。
//
// 这里钉四件事：
//   1. --dry-run 绝不写文件
//   2. 不是交互环境、又没给 --yes 时也不写 —— 自动化命令不能悄悄改用户的输入文件
//   3. --yes 写出来的文件能被正常解析和测量
//   4. 已经存在 claims.json 时不覆盖

const SKILL_ROOT = path.resolve(import.meta.dirname, "..");

function git(cwd: string, ...args: string[]): void {
  spawnSync("git", args, { cwd, stdio: "ignore" });
}

const README = [
  "# demo",
  "",
  "本作共 12 关，支持 1600+ 个插件。",
  "",
  "运行 `npm run build` 就能打包。",
  "",
].join("\n");

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laminae-init-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "README.md"), README, "utf8");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n", "utf8");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { build: "echo hi" } }), "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function runInit(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("LAMINAE_")) delete env[k];
  const r = spawnSync(process.execPath, [path.join(SKILL_ROOT, "scripts", "init.ts"), ...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const claimsPath = (dir: string): string => path.join(dir, ".laminae", "claims.json");

test("init：列出候选，并显示每条在 HEAD 上捕获到什么", () => {
  const dir = makeRepo();
  try {
    const r = runInit(dir, ["--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /挑出 \d+ 条候选/);
    assert.match(r.stdout, /捕获 "1600"/, "要显示实际捕获的文本，不能让人盲选");
    assert.match(r.stdout, /占位/, "占位的事实必须标出来");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init：--dry-run 绝不写文件", () => {
  const dir = makeRepo();
  try {
    const r = runInit(dir, ["--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(claimsPath(dir)), false, "--dry-run 不该留下任何文件");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init：非交互又没有 --yes 时不写文件", () => {
  const dir = makeRepo();
  try {
    // spawnSync 里 stdin 不是 TTY
    const r = runInit(dir, []);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(claimsPath(dir)), false, "自动化命令不能悄悄改用户的输入文件");
    assert.match(r.stdout, /不是交互环境/);
    assert.match(r.stdout, /--yes/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init：--yes 写出来的文件能被解析，也能真跑", () => {
  const dir = makeRepo();
  try {
    const r = runInit(dir, ["--yes"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(claimsPath(dir)), true);

    const written = JSON.parse(fs.readFileSync(claimsPath(dir), "utf8")) as { id: string; locator: string; fact: unknown }[];
    assert.ok(written.length > 0, "至少收一条");
    for (const c of written) {
      assert.ok(c.id && c.locator && c.fact, "每条都要有 id / locator / fact");
    }

    // 真的跑一遍，确认生成的文件不是摆设
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("LAMINAE_")) delete env[k];
    const run = spawnSync(process.execPath, [path.join(SKILL_ROOT, "scripts", "run.ts"), "--no-commands", "--run", "after"], {
      cwd: dir,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(run.status, 0, run.stderr);
    const payload = JSON.parse(fs.readFileSync(path.join(dir, ".laminae", "runs", "after", "payload.json"), "utf8")) as {
      claims: { states: number[] }[];
    };
    assert.equal(payload.claims.length, written.length, "写进去几条，报告里就该有几条");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init：claims.json 已经存在时不覆盖", () => {
  const dir = makeRepo();
  try {
    fs.mkdirSync(path.join(dir, ".laminae"), { recursive: true });
    fs.writeFileSync(claimsPath(dir), "[]\n", "utf8");
    const r = runInit(dir, ["--yes"]);
    assert.notEqual(r.status, 0, "不覆盖应当是非零退出");
    assert.match(r.stderr, /已经存在/);
    assert.equal(fs.readFileSync(claimsPath(dir), "utf8"), "[]\n", "原文件不能被改动");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init：文档里没有可核对的数时，明说没找到，不当成失败", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laminae-init-none-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    fs.writeFileSync(path.join(dir, "README.md"), "# demo\n\n一段没有任何数字的话。\n", "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
    const r = runInit(dir, ["--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /没找到/);
    assert.match(r.stdout, /不是失败/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
