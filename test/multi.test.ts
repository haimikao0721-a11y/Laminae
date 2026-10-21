/**
 * 多仓库编排：一个项目文件夹下有几个子仓库时，逐个核验，各写各的 .laminae/runs/<id>/，
 * 最后在父目录生成一张汇总页。
 *
 * 这些测试都在临时目录里造真仓库跑真流程，不 mock。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SKILL_ROOT } from "./helpers.ts";

const EMPTY_CONFIG = path.join(os.tmpdir(), "laminae-empty-gitconfig-multi");
fs.writeFileSync(EMPTY_CONFIG, "");

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: EMPTY_CONFIG,
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 在 dir 造一个最小仓库：README 写「共 N 关」，systems.json 里放 N 个关卡 */
function mkRepo(dir: string, levels: number): void {
  fs.mkdirSync(path.join(dir, ".laminae"), { recursive: true });
  fs.mkdirSync(path.join(dir, "assets", "data"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), `# demo\n\n本作共 ${levels} 关。\n`, "utf8");
  fs.writeFileSync(
    path.join(dir, "assets", "data", "systems.json"),
    JSON.stringify({ levels: Array(levels).fill(0) }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, ".laminae", "claims.json"),
    JSON.stringify([
      { id: "levels", label: "关数", file: "README.md", locator: "(\\d+) 关", fact: { type: "json-length", file: "assets/data/systems.json", path: "levels" } },
    ]),
    "utf8",
  );
  git(dir, "add", "-A");
  execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], {
    env: { ...process.env, ...GIT_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runFrom(cwd: string, args: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("LAMINAE_")) delete env[k];
  const r = spawnSync(process.execPath, [path.join(SKILL_ROOT, "scripts", "run.ts"), ...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function latestOf(repo: string): string {
  return fs.readFileSync(path.join(repo, ".laminae", "latest"), "utf8").trim();
}

test("父目录不是仓库：不硬失败，列出子仓库并给出能直接粘的命令", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "laminae-multi-"));
  try {
    mkRepo(path.join(root, "api"), 3);
    mkRepo(path.join(root, "web"), 5);
    const r = runFrom(root);
    assert.notEqual(r.status, 0, "没真正跑，退出码不该是 0");
    assert.match(r.stderr, /本身不是 git 仓库/);
    assert.match(r.stderr, /下面有 2 个/);
    assert.match(r.stderr, /api\//);
    assert.match(r.stderr, /web\//);
    assert.match(r.stderr, /--all/, "要给出全跑的命令");
    assert.match(r.stderr, /repos\.json/, "要提到可以写清单");
    assert.equal(fs.existsSync(path.join(root, ".laminae")), false, "只是提示，不该留下任何目录");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("多仓库：--all 逐个跑，各自落盘，共用同一个 run id，父目录生成汇总页", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "laminae-multi-"));
  try {
    mkRepo(path.join(root, "api"), 3);
    mkRepo(path.join(root, "web"), 7);

    const r = runFrom(root, ["--all"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /核验 2 个仓库/);

    const apiId = latestOf(path.join(root, "api"));
    const webId = latestOf(path.join(root, "web"));
    assert.equal(apiId, webId, "同一次运行，两个仓库要用同一个 id，汇总页才对得起来");

    for (const name of ["api", "web"]) {
      const dir = path.join(root, name, ".laminae", "runs", apiId);
      assert.ok(fs.existsSync(path.join(dir, "payload.json")), `${name} 要有 payload.json`);
      assert.ok(fs.existsSync(path.join(dir, "laminae.html")), `${name} 要有 laminae.html`);
    }

    // 两个仓库的数据不能串
    const apiPayload = JSON.parse(fs.readFileSync(path.join(root, "api", ".laminae", "runs", apiId, "payload.json"), "utf8")) as { summary: { claimCount: number } };
    assert.equal(apiPayload.summary.claimCount, 1);

    // 汇总页
    const index = path.join(root, ".laminae", "runs", apiId, "index.html");
    assert.ok(fs.existsSync(index), "父目录要有汇总页");
    const html = fs.readFileSync(index, "utf8");
    assert.ok(html.includes("api"), "汇总页要列出 api");
    assert.ok(html.includes("web"), "汇总页要列出 web");
    assert.ok(!/<script[^>]+\ssrc=/i.test(html), "汇总页也要自包含，不能有外部脚本");
    // 链接要能指到各仓库自己的报告
    assert.ok(html.includes("../../../../api/.laminae/runs/") || html.includes("api/.laminae/runs/"), "要有指向各仓库报告的相对链接");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("多仓库：读 .laminae/repos.json，可以给仓库起名字", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "laminae-multi-"));
  try {
    mkRepo(path.join(root, "svc", "api"), 3);
    mkRepo(path.join(root, "svc", "web"), 4);
    fs.mkdirSync(path.join(root, ".laminae"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".laminae", "repos.json"),
      JSON.stringify([{ name: "backend", path: "svc/api" }, { name: "frontend", path: "svc/web" }]),
      "utf8",
    );

    const r = runFrom(root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /backend/);
    assert.match(r.stdout, /frontend/);

    const id = latestOf(path.join(root, "svc", "api"));
    assert.equal(id, latestOf(path.join(root, "svc", "web")));
    assert.ok(fs.existsSync(path.join(root, ".laminae", "runs", id, "index.html")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("多仓库：一个失败不影响另一个的产物，但整体退出码非 0", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "laminae-multi-"));
  try {
    mkRepo(path.join(root, "good"), 3);
    mkRepo(path.join(root, "bad"), 3);
    // 把 bad 的说法定义写坏
    fs.writeFileSync(
      path.join(root, "bad", ".laminae", "claims.json"),
      JSON.stringify([{ id: "x", file: "README.md", locator: "(\\d+) 关", fact: { type: "nope" } }]),
      "utf8",
    );

    const r = runFrom(root, ["--all"]);
    assert.notEqual(r.status, 0, "有仓库失败，整体要非 0");
    assert.match(r.stderr, /bad/);

    // good 照样要跑完
    assert.ok(fs.existsSync(path.join(root, "good", ".laminae", "latest")), "好的那个应该跑完了");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("--run 指定名字：留档到该目录，可读的名字比时间戳好认", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "laminae-multi-"));
  try {
    mkRepo(path.join(root, "api"), 3);
    const r = runFrom(path.join(root, "api"), ["--run", "before-refactor"]);
    assert.equal(r.status, 0, r.stderr);

    const dir = path.join(root, "api", ".laminae", "runs", "before-refactor");
    assert.ok(fs.existsSync(path.join(dir, "payload.json")));
    assert.ok(fs.existsSync(path.join(dir, "laminae.html")));
    assert.equal(latestOf(path.join(root, "api")), "before-refactor");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("同一个名字跑两次：第二次覆盖第一次，但会提前说一声", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "laminae-multi-"));
  try {
    mkRepo(path.join(root, "api"), 3);
    assert.equal(runFrom(path.join(root, "api"), ["--run", "same"]).status, 0);
    const r2 = runFrom(path.join(root, "api"), ["--run", "same"]);
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout + r2.stderr, /会被覆盖/);

    const runs = fs.readdirSync(path.join(root, "api", ".laminae", "runs")).sort();
    assert.deepEqual(runs, ["same"], "同名只留一个目录，不生成 same-2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("两次默认运行：各自留档，不覆盖上一次", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "laminae-multi-"));
  try {
    mkRepo(path.join(root, "api"), 3);
    assert.equal(runFrom(path.join(root, "api")).status, 0);
    const first = latestOf(path.join(root, "api"));
    assert.equal(runFrom(path.join(root, "api")).status, 0);
    const second = latestOf(path.join(root, "api"));

    assert.notEqual(first, second, "两次运行要有各自的目录");
    const runs = fs.readdirSync(path.join(root, "api", ".laminae", "runs")).sort();
    assert.equal(runs.length, 2, `应当有两个运行目录，实际：${runs.join(", ")}`);
    for (const id of runs) {
      assert.ok(fs.existsSync(path.join(root, "api", ".laminae", "runs", id, "payload.json")), `${id} 的 payload 要留着`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("危险命令保护：有 test-passes 的多仓库默认改成串行，并说明原因", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "laminae-multi-"));
  try {
    mkRepo(path.join(root, "api"), 3);
    mkRepo(path.join(root, "web"), 3);
    fs.writeFileSync(
      path.join(root, "api", ".laminae", "claims.json"),
      JSON.stringify([
        { id: "t", label: "测试", file: "README.md", locator: "(\\d+) 关", fact: { type: "test-passes", command: "echo ok" } },
      ]),
      "utf8",
    );

    const r = runFrom(root, ["--all", "--jobs", "4"]);
    assert.match(r.stdout + r.stderr, /改成串行/, "要提醒改成串行了");
    assert.match(r.stdout + r.stderr, /allow-parallel-commands/, "要告诉怎么强制并行");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
