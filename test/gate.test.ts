import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redosRisk } from "../src/measure/lint.ts";

// 两件和「命令与正则可能被人塞东西」有关的事。
//
// 一、出处门禁：claims.json 可以随仓库提交，克隆一个仓库再跑一次 laminae，
//     就会执行里面的命令。判断依据只有一条，git 本来就知道：最后一次是谁改的。
//
// 二、locator 的灾难性回溯：locator 在**整份文档**上跑，文档动辄几十万字。
//     一个写坏的正则能让工具卡到人以为死机 —— 我自己踩过，占掉 43% 的运行时间。

const SKILL_ROOT = path.resolve(import.meta.dirname, "..");

/** 造一个把 claims.json 一起提交的仓库，作者可控 */
function repoWithCommittedClaims(authorEmail: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laminae-gate-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", authorEmail], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "someone"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n\n测试全过。\n", "utf8");
  fs.mkdirSync(path.join(dir, ".laminae"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".laminae", "claims.json"),
    JSON.stringify([
      {
        id: "tests",
        label: "测试全过",
        file: "README.md",
        locator: "(测试全过)",
        fact: { type: "test-passes", command: 'node -e "process.exit(0)"', watch: ["src/**"] },
      },
    ]),
    "utf8",
  );
  spawnSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["commit", "-q", "-m", "把 claims 一起交上去"], { cwd: dir, stdio: "ignore" });
  return dir;
}

const EMPTY_GITCONFIG = path.join(os.tmpdir(), "laminae-gate-empty-gitconfig");
fs.writeFileSync(EMPTY_GITCONFIG, "");

function measure(
  dir: string,
  args: string[] = [],
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("LAMINAE_")) delete env[k];
  const r = spawnSync(process.execPath, [path.join(SKILL_ROOT, "src", "measure", "measure.ts"), ...args], {
    cwd: dir,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("出处门禁：claims 是别人提交的，命令不跑，并说清为什么", () => {
  const dir = repoWithCommittedClaims("someone-else@example.com");
  try {
    // 本机身份设成另一个人
    spawnSync("git", ["config", "user.email", "me@example.com"], { cwd: dir, stdio: "ignore" });
    const r = measure(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /没有执行 —— 这份 claims 不是你写的/);
    assert.match(r.stdout, /someone-else@example\.com/, "要点名是谁写的");
    assert.match(r.stdout, /--trust-commands/, "要给出放行的办法");
    assert.match(r.stdout, /测不出来/, "要说明这几条会记成测不出来");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("出处门禁：作者就是本机身份时放行", () => {
  const dir = repoWithCommittedClaims("me@example.com");
  try {
    const r = measure(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /要执行 1 条命令/);
    assert.doesNotMatch(r.stdout, /不是你写的/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("出处门禁：--trust-commands 显式放行，并把放行原因写出来", () => {
  const dir = repoWithCommittedClaims("someone-else@example.com");
  try {
    spawnSync("git", ["config", "user.email", "me@example.com"], { cwd: dir, stdio: "ignore" });
    const r = measure(dir, ["--trust-commands"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /要执行 1 条命令/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("出处门禁：读不到本机身份时按不放行处理", () => {
  const dir = repoWithCommittedClaims("someone-else@example.com");
  try {
    // 把本机 user.email 清空，并隔离全局配置 —— 判不了就不该默认放行。
    // 不隔离的话会读到开发机自己的全局身份，这条就测不出来了。
    spawnSync("git", ["config", "--unset", "user.email"], { cwd: dir, stdio: "ignore" });
    const r = measure(dir, [], { GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG, GIT_CONFIG_NOSYSTEM: "1" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /读不到本机的 git 身份/);
    assert.match(r.stdout, /没有执行|没有要跑的命令/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ReDoS 体检：认得出嵌套量词，放得过普通捕获组", () => {
  // 我自己踩过的那个
  assert.ok(redosRisk("[A-Za-z0-9_@][A-Za-z0-9_.\\-]*(?:\\/[A-Za-z0-9_.\\-]+)*\\.[A-Za-z0-9]{1,8}"));
  assert.ok(redosRisk("(a+)+"));
  assert.ok(redosRisk("(.*)*"));
  assert.ok(redosRisk("(\\w*)*"));
  // 正常写法不该被冤枉 —— 误报一次，人以后就不看这条警告了
  assert.equal(redosRisk("共 (\\d+) 关"), null);
  assert.equal(redosRisk("支持 (\\d+) 种文件格式"), null);
  assert.equal(redosRisk("blob/main/([.]github/contributing[.]md)"), null);
});
