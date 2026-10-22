/**
 * 不污染目标项目、不灌满上下文：
 *   - 生成物不出现在目标仓库的 git status 里（靠 .git/info/exclude，不碰项目自己的 .gitignore）
 *   - 终端输出的行数不随 commit 数增长
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LEVELS_CLAIM, TestRepo, readme, runLaminae, sys, writeClaims } from "./helpers.ts";

function seed(repo: TestRepo, commits: number): void {
  let levels = 3;
  let documented = 3;
  repo.commit({ "assets/data/systems.json": sys(levels), "README.md": readme(documented) });
  for (let i = 1; i < commits; i++) {
    // 每 7 个 commit 改一次事实，README 隔 3 个 commit 才跟上，制造一批假段
    if (i % 7 === 0) {
      levels++;
      repo.commit({ "assets/data/systems.json": sys(levels) });
    } else if (i % 7 === 3 && documented !== levels) {
      documented = levels;
      repo.commit({ "README.md": readme(documented) });
    } else {
      repo.commit({ [`noise/${i}.txt`]: String(i) });
    }
  }
}

const status = (repo: TestRepo): string[] =>
  repo.git("status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean);

test("运行后 git status 里只剩使用者自己写的 claims.json", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "assets/data/systems.json": sys(3), "README.md": readme(3), ".gitignore": "node_modules/\n" });
    writeClaims(repo, [LEVELS_CLAIM]);
    runLaminae(repo, "scripts/run.ts");

    assert.deepEqual(status(repo), ["?? .laminae/claims.json"]);
    // 项目自己的 .gitignore 不能被改
    assert.equal(fs.readFileSync(path.join(repo.dir, ".gitignore"), "utf8"), "node_modules/\n");
  } finally {
    repo.dispose();
  }
});

test("重复运行不会重复写 exclude", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "assets/data/systems.json": sys(3), "README.md": readme(3) });
    writeClaims(repo, [LEVELS_CLAIM]);
    runLaminae(repo, "scripts/run.ts");
    const file = path.join(repo.dir, ".git", "info", "exclude");
    const once = fs.readFileSync(file, "utf8");
    runLaminae(repo, "scripts/run.ts");
    assert.equal(fs.readFileSync(file, "utf8"), once);
    // 产物在 .laminae/runs/<id>/ 下，按目录忽略一次就够；跑两次不能重复追加
    assert.equal(once.split("\n").filter((l) => l === "/.laminae/runs/").length, 1);
    assert.equal(once.split("\n").filter((l) => l === "/.laminae/data/").length, 1);
  } finally {
    repo.dispose();
  }
});

test("LAMINAE_NO_EXCLUDE=1 时不写 exclude，生成物会出现在 git status 里", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "assets/data/systems.json": sys(3), "README.md": readme(3) });
    writeClaims(repo, [LEVELS_CLAIM]);
    runLaminae(repo, "scripts/run.ts", [], { LAMINAE_NO_EXCLUDE: "1" });
    // 不写 exclude 时，产物应当以未跟踪文件出现在 git status 里
    assert.ok(
      status(repo).some((l) => /\.laminae\/runs\/[^/]+\/laminae\.html$/.test(l)),
      `git status 里应能看到报告，实际：${status(repo).join(" | ")}`,
    );
  } finally {
    repo.dispose();
  }
});

test("紧凑输出：行数与行宽不随 commit 数增长；--verbose 才有逐格时间线", () => {
  const repo = new TestRepo();
  try {
    seed(repo, 120);
    writeClaims(repo, [
      LEVELS_CLAIM,
      { ...LEVELS_CLAIM, id: "b", label: "b" },
      { ...LEVELS_CLAIM, id: "c", label: "c" },
    ]);
    runLaminae(repo, "src/measure/measure.ts");

    const compact = runLaminae(repo, "src/judge/analyze.ts");
    const longestGlyphRun = (s: string): number => Math.max(0, ...(s.match(/[TF.?]{20,}/g) ?? []).map((m) => m.length));
    assert.ok(compact.split("\n").length < 45, `紧凑输出有 ${compact.split("\n").length} 行`);
    assert.equal(longestGlyphRun(compact), 0, "紧凑输出里不应出现逐 commit 的时间线");

    const verbose = runLaminae(repo, "src/judge/analyze.ts", ["--verbose"]);
    assert.ok(longestGlyphRun(verbose) >= 100, "--verbose 要打印完整时间线");
  } finally {
    repo.dispose();
  }
});

test("claims.json 写错时不产生任何生成物，也不动 exclude", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "README.md": readme(3) });
    writeClaims(repo, [{ id: "x", file: "README.md", locator: "(\\d+) 关", fact: { type: "bad" } }]);
    assert.throws(() => runLaminae(repo, "scripts/run.ts"));
    assert.ok(!fs.existsSync(path.join(repo.dir, ".laminae", "data")));
    assert.ok(!fs.readFileSync(path.join(repo.dir, ".git", "info", "exclude"), "utf8").includes("laminae"));
  } finally {
    repo.dispose();
  }
});
