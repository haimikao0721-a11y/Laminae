import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkRunId, defaultRunId, uniqueRunId, writeLatest, readLatest, listRuns } from "../src/runid.ts";

test("checkRunId：合法的 id", () => {
  for (const id of ["20261020T031422", "before-refactor", "v1.2_after", "a", "a.b-c_d"]) {
    const r = checkRunId(id);
    assert.equal(r.ok, true, `${id} 应该合法，却报了 ${r.ok ? "" : r.reason}`);
  }
});

test("checkRunId：拒绝能写到仓库外面的名字", () => {
  const bad = [
    ["", "空"],
    ["..", "只有点"],
    ["../etc", "含 .. 和斜杠"],
    ["a/b", "含斜杠"],
    ["a\\b", "含反斜杠"],
    ["a b", "含空格"],
    ["中文名", "含非 ASCII"],
    ["a".repeat(65), "超长"],
  ] as const;
  for (const [id, why] of bad) {
    const r = checkRunId(id);
    assert.equal(r.ok, false, `${why}（${JSON.stringify(id)}）应该被拒绝`);
    if (!r.ok) assert.ok(r.reason.length > 0, "要说明为什么不行");
  }
});

test("checkRunId：拒绝时给出的理由对得上", () => {
  const r = checkRunId("a/b");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /分隔符/);
  const r2 = checkRunId("a b");
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.match(r2.reason, /只能含/);
});

test("defaultRunId：按本地时间，不带冒号（Windows 目录名不允许）", () => {
  const id = defaultRunId(new Date(2026, 9, 20, 3, 14, 22));
  assert.equal(id, "20261020T031422");
  assert.ok(!id.includes(":"), "不能含冒号");
  assert.equal(checkRunId(id).ok, true);
});

test("defaultRunId：月日补零", () => {
  assert.equal(defaultRunId(new Date(2026, 0, 5, 9, 8, 7)), "20260105T090807");
});

test("uniqueRunId：不撞车就用原名，撞了加序号，不覆盖", () => {
  const taken = new Set(["20261020T031422"]);
  assert.equal(uniqueRunId("20261020T031422", (id) => taken.has(id)), "20261020T031422-2");
  assert.equal(uniqueRunId("fresh", (id) => taken.has(id)), "fresh");
});

test("uniqueRunId：序号被别人占了继续往后找", () => {
  const taken = new Set(["x", "x-2", "x-3"]);
  assert.equal(uniqueRunId("x", (id) => taken.has(id)), "x-4");
});

test("latest 指针：写入后能读回来，没有文件时是 null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laminae-runid-"));
  try {
    assert.equal(readLatest(dir), null);
    writeLatest(dir, "20261020T031422");
    assert.equal(readLatest(dir), "20261020T031422");
    assert.equal(fs.readFileSync(path.join(dir, "latest"), "utf8"), "20261020T031422\n", "内容就是 id 加换行");
    writeLatest(dir, "second");
    assert.equal(readLatest(dir), "second", "后写的覆盖前面的");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readLatest：空文件当成没有，不返回空串", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laminae-runid-"));
  try {
    fs.writeFileSync(path.join(dir, "latest"), "\n\n  \n", "utf8");
    assert.equal(readLatest(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listRuns：只认目录，按名字排序，没有目录就是空数组", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laminae-runid-"));
  try {
    assert.deepEqual(listRuns(dir), [], "目录不存在时返回空数组，不抛");
    fs.mkdirSync(path.join(dir, "b"));
    fs.mkdirSync(path.join(dir, "a"));
    fs.writeFileSync(path.join(dir, "latest"), "a\n", "utf8");
    assert.deepEqual(listRuns(dir), ["a", "b"], "文件不算，目录按名字排");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
