/**
 * 跑出来的事实走完整条时间线：失败挂住，然后要么改代码修好，要么改断言。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TestRepo, runPipeline } from "./helpers.ts";
import type { ClaimInput } from "../src/types.ts";

const node = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;

const CHECK = [
  'const fs = require("fs");',
  'const got = fs.readFileSync("out.txt", "utf8").trim();',
  'const m = fs.readFileSync("expect.txt", "utf8").match(/assert\\s+(\\S+)/);',
  "process.exit(got === (m && m[1]) ? 0 : 1);",
  "",
].join("\n");

const PRINT = ['const fs = require("fs");', 'process.stdout.write(fs.readFileSync("out.txt", "utf8").trim());', ""].join("\n");

const feeTest: ClaimInput = {
  id: "fee",
  label: "酬金",
  file: "expect.txt",
  locator: "assert (\\S+)",
  fact: { type: "test-passes", command: `${node} check.js`, watch: ["check.js", "out.txt", "expect.txt"] },
};

const feeOut: ClaimInput = {
  id: "fee-out",
  label: "酬金输出",
  file: "SPEC.md",
  locator: "酬金口径 (v\\d+)",
  fact: { type: "output-unchanged", command: `${node} print.js`, watch: ["print.js", "out.txt"] },
};

test("测试：代码改回去之后是现实追上了说法", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "check.js": CHECK, "out.txt": "12\n", "expect.txt": "assert 12\n" });
    repo.commit({ "out.txt": "13\n" });
    repo.commit({ "out.txt": "12\n" });
    const r = runPipeline(repo, [feeTest]).results[0]!;
    assert.deepEqual(r.states, [0, 1, 0]);
    assert.deepEqual(r.outcomes, ["reality-caught-up"]);
  } finally {
    repo.dispose();
  }
});

test("测试：同一格改了断言让它通过，记成两边都变了", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "check.js": CHECK, "out.txt": "12\n", "expect.txt": "assert 12\n" });
    repo.commit({ "out.txt": "13\n" });
    repo.commit({ "expect.txt": "assert 13\n" });
    const r = runPipeline(repo, [feeTest]).results[0]!;
    assert.deepEqual(r.states, [0, 1, 0]);
    assert.deepEqual(r.outcomes, ["both-changed"]);
  } finally {
    repo.dispose();
  }
});

test("输出差分：变了再变回去是现实追上；口径词一起改则两边都变了", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "print.js": PRINT, "out.txt": "12\n", "SPEC.md": "酬金口径 v1\n" });
    repo.commit({ "out.txt": "13\n" });
    repo.commit({ "out.txt": "12\n" });
    const back = runPipeline(repo, [feeOut]).results[0]!;
    assert.deepEqual(back.states, [0, 1, 0]);
    assert.deepEqual(back.outcomes, ["reality-caught-up"]);
  } finally {
    repo.dispose();
  }

  const repo2 = new TestRepo();
  try {
    repo2.commit({ "print.js": PRINT, "out.txt": "12\n", "SPEC.md": "酬金口径 v1\n" });
    repo2.commit({ "out.txt": "13\n" });
    repo2.commit({ "SPEC.md": "酬金口径 v2\n" });
    const moved = runPipeline(repo2, [feeOut]).results[0]!;
    assert.deepEqual(moved.states, [0, 1, 0]);
    assert.deepEqual(moved.outcomes, ["both-changed"]);
  } finally {
    repo2.dispose();
  }
});
