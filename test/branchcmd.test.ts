import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 命令类事实（test-passes 这类）原来在分支扫描上一律记成「测不出来」——
// 理由是「要工作区，这一版不做」。
//
// 但那等于「这一版看不见」，不是「测不出来」：分支上到底跑不跑得通是能测的，
// 只是要付一次检出。现在会检出到临时 worktree 真跑。
//
// 这个测试造一个小仓库：
//   main        功能没实现，命令退出码 1 → 假
//   fix/feature 加了 feature.txt，命令退出码 0 → 真
// 分支扫描要能看出「分支上修好了，没合进来」。

const SKILL_ROOT = path.resolve(import.meta.dirname, "..");

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr}`);
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

/** 造一个「main 上失败、分支上修好」的仓库 */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laminae-branchcmd-"));
  git(dir, "init", "-q", "-b", "main");
  // 文档里声称功能已经实现；命令检查 feature.txt 在不在
  write(path.join(dir, "README.md"), "# demo\n\n功能已经实现。\n");
  write(path.join(dir, "check.js"), "process.exit(require('fs').existsSync('feature.txt') ? 0 : 1);\n");
  write(
    path.join(dir, ".laminae", "claims.json"),
    JSON.stringify(
      [
        {
          id: "feature-works",
          label: "功能可用",
          file: "README.md",
          locator: "(功能已经实现)",
          fact: { type: "test-passes", command: "node check.js", watch: ["feature.txt"] },
        },
      ],
      null,
      2,
    ),
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "初始：功能没实现");
  git(dir, "checkout", "-q", "-b", "fix/feature");
  write(path.join(dir, "feature.txt"), "done\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "实现功能");
  git(dir, "checkout", "-q", "main");
  return dir;
}

function runBranches(cwd: string): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("LAMINAE_")) delete env[k];
  const r = spawnSync(process.execPath, [path.join(SKILL_ROOT, "scripts", "branches.ts")], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("分支扫描会真跑命令类事实，不再一律记成测不出来", () => {
  const dir = makeRepo();
  try {
    const r = runBranches(dir);
    assert.equal(r.status, 0, `分支扫描应当正常结束，stderr：${r.stderr}`);
    assert.match(r.stdout, /会检出到临时工作区执行/, "应当说明会检出");
    assert.match(r.stdout, /main=假/, "main 上 feature.txt 不存在，命令该失败");
    assert.match(r.stdout, /分支=真/, "分支上加了 feature.txt，命令该成功");
    assert.doesNotMatch(r.stdout, /测不出来/, "现在能测了，不该再出现测不出来");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("分支扫描跑完不留临时工作区目录", () => {
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("laminae-")));
  const dir = makeRepo();
  try {
    runBranches(dir);
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("laminae-") && !before.has(n));
    const leftovers = after.filter((n) => {
      // 只关心和这次运行相关的；别的测试可能同时在建目录
      const full = path.join(os.tmpdir(), n);
      try {
        return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, "wt"));
      } catch {
        return false;
      }
    });
    assert.deepEqual(leftovers, [], `临时工作区应当删掉，剩下：${leftovers.join(", ")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
