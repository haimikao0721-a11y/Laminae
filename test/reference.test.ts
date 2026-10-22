/**
 * 引用型说法：文档里写的是路径、命令名等对仓库内某物的引用，事实是它存不存在。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runFile, runLaminae, TestRepo, writeClaims } from "./helpers.ts";
import type { ClaimInput } from "../src/core/types.ts";

const pkg = (scripts: Record<string, string>): string => JSON.stringify({ name: "demo", scripts });

const SCRIPT_CLAIM: ClaimInput = {
  id: "build-cmd",
  label: "README：构建命令",
  file: "README.md",
  locator: "npm run (\\w+)",
  fact: { type: "json-has-key", file: "package.json", path: "scripts" },
};

const PATH_CLAIM: ClaimInput = {
  id: "guide-path",
  label: "README：指南路径",
  file: "README.md",
  locator: "详见 (\\S+\\.md)",
  fact: { type: "path-exists" },
};

interface Timeline {
  results: {
    id: string;
    kind: string;
    states: number[];
    outcomes: string[];
    claimedText: (string | null)[];
    actual: (number | null)[];
  }[];
}

function timelineOf(repo: TestRepo): Timeline {
  runLaminae(repo, "scripts/run.ts", ["data"]);
  return JSON.parse(fs.readFileSync(path.join(repo.dir, ".laminae", "data", "timeline.json"), "utf8")) as Timeline;
}

test("命令名：脚本被改名后说法变假，文档跟上后恢复", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "package.json": pkg({ build: "x" }), "README.md": "构建：npm run build\n" }); // 0 真
    repo.commit({ "package.json": pkg({ compile: "x" }) }); // 1 假：README 还写着 build
    repo.commit({ "README.md": "构建：npm run compile\n" }); // 2 真
    writeClaims(repo, [SCRIPT_CLAIM]);

    const r = timelineOf(repo).results[0]!;
    assert.equal(r.kind, "exists");
    assert.deepEqual(r.states, [0, 1, 0]);
    assert.deepEqual(r.claimedText, ["build", "build", "compile"]);
    assert.deepEqual(r.actual, [1, 0, 1]);
    // 文档把引用从 build 改成 compile，而事实是「文档里写的这个存不存在」，会在同一格上一起变
    assert.deepEqual(r.outcomes, ["both-changed"]);
  } finally {
    repo.dispose();
  }
});

test("路径：被引用的文件被删后变假，文件恢复后现实追上了说法", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "docs/guide.md": "g", "README.md": "详见 docs/guide.md\n" }); // 0 真
    repo.commit({ "docs/guide.md": null }); // 1 假
    repo.commit({ "x.txt": "x" }); // 2 假
    repo.commit({ "docs/guide.md": "g2" }); // 3 真
    writeClaims(repo, [PATH_CLAIM]);

    const r = timelineOf(repo).results[0]!;
    assert.deepEqual(r.states, [0, 1, 1, 0]);
    assert.deepEqual(r.outcomes, ["reality-caught-up"]);
  } finally {
    repo.dispose();
  }
});

test("路径：文档里把这句话删掉，记为说法被删掉，而不是真或假", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "docs/guide.md": "g", "README.md": "详见 docs/guide.md\n" });
    repo.commit({ "docs/guide.md": null });
    repo.commit({ "README.md": "没有链接了\n" });
    writeClaims(repo, [PATH_CLAIM]);

    const r = timelineOf(repo).results[0]!;
    assert.deepEqual(r.states, [0, 1, 2]);
    assert.deepEqual(r.outcomes, ["doc-removed"]);
  } finally {
    repo.dispose();
  }
});

test("路径：指向的 JSON 读不到时是测不出来，不是假", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "package.json": pkg({ build: "x" }), "README.md": "npm run build\n" });
    repo.commit({ "package.json": "{ 坏的" });
    writeClaims(repo, [SCRIPT_CLAIM]);

    const r = timelineOf(repo).results[0]!;
    assert.deepEqual(r.states, [0, 3]);
  } finally {
    repo.dispose();
  }
});

test("数值型与引用型可以放在同一份 claims.json 里", () => {
  const repo = new TestRepo();
  try {
    repo.commit({
      "docs/guide.md": "g",
      "assets/data/systems.json": JSON.stringify({ levels: [1, 2] }),
      "README.md": "详见 docs/guide.md，共 2 关\n",
    });
    writeClaims(repo, [PATH_CLAIM, { id: "lv", label: "关数", file: "README.md", locator: "(\\d+) 关", fact: { type: "json-length", file: "assets/data/systems.json", path: "levels" } }]);

    const t = timelineOf(repo);
    assert.deepEqual(t.results.map((r) => [r.id, r.kind, r.states]), [
      ["guide-path", "exists", [0]],
      ["lv", "number", [0]],
    ]);
  } finally {
    repo.dispose();
  }
});

test("impact 只是带到数据里的标签，不改变任何结论", () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "docs/guide.md": "g", "README.md": "详见 docs/guide.md\n" });
    repo.commit({ "docs/guide.md": null });
    repo.commit({ "docs/guide.md": "g" });

    writeClaims(repo, [PATH_CLAIM]);
    const plain = timelineOf(repo).results[0]!;

    writeClaims(repo, [{ ...PATH_CLAIM, impact: "high" }]);
    const tagged = timelineOf(repo).results[0]! as typeof plain & { impact: string };

    assert.equal(tagged.impact, "high");
    assert.deepEqual(tagged.states, plain.states);
    assert.deepEqual(tagged.outcomes, plain.outcomes);

    runLaminae(repo, "src/output/build-data.ts");
    runLaminae(repo, "src/output/render.ts");
    const html = fs.readFileSync(runFile(repo, "laminae.html"), "utf8");
    assert.match(html, /"impact":\s*"high"/);
  } finally {
    repo.dispose();
  }
});
