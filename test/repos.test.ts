import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findSubRepos, parseRepoList, readReposFile, dedupe } from "../src/core/repos.ts";

/** 造一个最小仓库：只要 .git 存在就够，findSubRepos 不看里面有什么 */
function mkRepo(dir: string, kind: "dir" | "file" = "dir"): void {
  fs.mkdirSync(dir, { recursive: true });
  if (kind === "dir") {
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  } else {
    // 子模块和 worktree 的 .git 是文件
    fs.writeFileSync(path.join(dir, ".git"), "gitdir: ../.git/modules/x\n", "utf8");
  }
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "laminae-repos-"));
}

test("findSubRepos：找到下一层的仓库", () => {
  const root = tmp();
  try {
    mkRepo(path.join(root, "api"));
    mkRepo(path.join(root, "web"));
    const found = findSubRepos(root);
    assert.deepEqual(found.map((r) => r.rel), ["api", "web"]);
    assert.equal(found[0]!.abs, path.join(root, "api"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findSubRepos：.git 是文件（子模块 / worktree）也算仓库", () => {
  const root = tmp();
  try {
    mkRepo(path.join(root, "sdk"), "file");
    assert.deepEqual(findSubRepos(root).map((r) => r.rel), ["sdk"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findSubRepos：找到仓库就不再往下钻，要的是最外层", () => {
  const root = tmp();
  try {
    mkRepo(path.join(root, "svc"));
    mkRepo(path.join(root, "svc", "inner"));
    assert.deepEqual(findSubRepos(root).map((r) => r.rel), ["svc"], "inner 是 svc 里面的，不单列");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findSubRepos：不跳进 node_modules / vendor 这些依赖目录", () => {
  const root = tmp();
  try {
    mkRepo(path.join(root, "node_modules", "pkg"));
    mkRepo(path.join(root, "vendor", "lib"));
    mkRepo(path.join(root, "real"));
    assert.deepEqual(findSubRepos(root).map((r) => r.rel), ["real"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findSubRepos：目录本身就是仓库时不再往里找", () => {
  const root = tmp();
  try {
    mkRepo(root);
    mkRepo(path.join(root, "nested"));
    assert.deepEqual(findSubRepos(root), [], "根自己是仓库，这不是「包含多个子仓库的项目文件夹」");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findSubRepos：太深的够不着（默认最多 3 层）", () => {
  const root = tmp();
  try {
    mkRepo(path.join(root, "a", "b", "c", "d"));
    assert.deepEqual(findSubRepos(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findSubRepos：点开头的隐藏目录不看", () => {
  const root = tmp();
  try {
    mkRepo(path.join(root, ".hidden"));
    mkRepo(path.join(root, "visible"));
    assert.deepEqual(findSubRepos(root).map((r) => r.rel), ["visible"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findSubRepos：空目录不崩", () => {
  const root = tmp();
  try {
    assert.deepEqual(findSubRepos(root), []);
    assert.deepEqual(findSubRepos(path.join(root, "nope")), [], "路径不存在也不崩");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readReposFile：没有这个文件返回 null，而不是空数组", () => {
  const root = tmp();
  try {
    assert.equal(readReposFile(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readReposFile：字符串数组和 {name,path} 都认", () => {
  const root = tmp();
  try {
    mkRepo(path.join(root, "api"));
    mkRepo(path.join(root, "vendor", "sdk"));
    fs.mkdirSync(path.join(root, ".laminae"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".laminae", "repos.json"),
      JSON.stringify(["api", { name: "sdk", path: "vendor/sdk" }]),
      "utf8",
    );
    const specs = readReposFile(root)!;
    assert.deepEqual(specs.map((s) => s.name), ["api", "sdk"]);
    assert.equal(specs[1]!.abs, path.join(root, "vendor", "sdk"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readReposFile：写错了要抛，不能静默当成单仓库", () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, ".laminae"), { recursive: true });
    const f = path.join(root, ".laminae", "repos.json");

    fs.writeFileSync(f, "{ not json", "utf8");
    assert.throws(() => readReposFile(root), /不是合法 JSON/);

    fs.writeFileSync(f, JSON.stringify({ nope: 1 }), "utf8");
    assert.throws(() => readReposFile(root), /应当是数组/);

    fs.writeFileSync(f, JSON.stringify([]), "utf8");
    assert.throws(() => readReposFile(root), /是空的/);

    fs.writeFileSync(f, JSON.stringify(["does-not-exist"]), "utf8");
    assert.throws(() => readReposFile(root), /不存在/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("parseRepoList：逗号分隔，相对路径按父目录展开", () => {
  const root = tmp();
  try {
    mkRepo(path.join(root, "a"));
    mkRepo(path.join(root, "b"));
    const specs = parseRepoList(root, " a , b ");
    assert.deepEqual(specs.map((s) => s.name), ["a", "b"]);
    assert.equal(specs[0]!.abs, path.join(root, "a"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("parseRepoList：路径不存在时明确报错", () => {
  const root = tmp();
  try {
    assert.throws(() => parseRepoList(root, "ghost"), /不存在/);
    assert.throws(() => parseRepoList(root, "  ,  "), /空的/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dedupe：同一个绝对路径只跑一次，大小写不敏感", () => {
  const specs = [
    { abs: "C:/a/api", name: "api" },
    { abs: "C:/a/api", name: "api2" },
    { abs: "c:/a/API", name: "api3" },
    { abs: "C:/a/web", name: "web" },
  ];
  assert.deepEqual(dedupe(specs).map((s) => s.name), ["api", "web"]);
});
