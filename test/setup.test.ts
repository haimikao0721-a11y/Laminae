/**
 * 环境检查脚本：在有 git 与 node 的环境里应通过；缺项时退出码为 1 并给出安装方式。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SKILL_ROOT } from "./helpers.ts";

const win = process.platform === "win32";
const PS = path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function runSetup(env: NodeJS.ProcessEnv, args: string[] = []) {
  if (win) {
    return spawnSync(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(SKILL_ROOT, "scripts", "setup.ps1"), ...args], {
      env,
      encoding: "utf8",
    });
  }
  return spawnSync("bash", [path.join(SKILL_ROOT, "scripts", "setup.sh"), ...args], { env, encoding: "utf8" });
}

test("环境齐全时检查通过", () => {
  const r = runSetup(process.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /环境可用/);
  assert.match(r.stdout, /可以直接运行 \.ts/);
});

test("Windows：PATH 里没有 git 和 node 时，退出码为 1 并给出安装命令", { skip: !win }, () => {
  const env = { ...process.env, Path: path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32") };
  delete (env as Record<string, string | undefined>)["PATH"];
  const r = runSetup(env);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /git\s+未找到/);
  assert.match(r.stdout, /node\s+未找到/);
  assert.match(r.stdout, /winget install/);
});

test("未知参数：shell 脚本报错退出", { skip: win }, () => {
  const r = runSetup(process.env, ["--bad"]);
  assert.equal(r.status, 2);
});

test("setup.ps1 带 BOM（Windows PowerShell 5.1 才不会把中文读乱）", () => {
  const head = fs.readFileSync(path.join(SKILL_ROOT, "scripts", "setup.ps1")).subarray(0, 3);
  assert.deepEqual([...head], [0xef, 0xbb, 0xbf]);
});
