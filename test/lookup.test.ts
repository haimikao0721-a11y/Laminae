import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { lookClaim } from "../src/measure/lookup.ts";
import { parseCatFileBatch } from "../src/core/gitutil.ts";
import { draftsFromGrep } from "../src/output/suggest.ts";
import { runLaminae, TestRepo, writeClaims } from "./helpers.ts";
import type { ClaimDef } from "../src/core/types.ts";
import type { Tree } from "../src/measure/facts.ts";

function tree(files: Record<string, string>): Tree {
  return { paths: () => Object.keys(files), read: (f) => files[f] ?? null };
}

const claim = (over: Partial<ClaimDef> & Pick<ClaimDef, "fact">): ClaimDef => ({
  id: "a",
  label: "关数",
  file: "README.md",
  locator: "共 (\\d+) 关",
  impact: "normal",
  compare: "eq",
  tolerance: 0.05,
  ...over,
});

test("lookClaim：JSON 长度和文档里的数对得上才是一致", () => {
  const row = lookClaim(
    claim({ fact: { type: "json-length", file: "data/levels.json", path: "levels" } }),
    "本作共 2 关。\n",
    tree({ "data/levels.json": JSON.stringify({ levels: [1, 2] }) }),
  );
  assert.equal(row.captured, "2");
  assert.equal(row.actual, 2);
  assert.equal(row.verdict, "一致");
});

test("lookClaim：文档里没有这句，不去假装测到了", () => {
  const row = lookClaim(claim({ fact: { type: "count-files", glob: "*.md" } }), "没有数字。\n", tree({ "README.md": "" }));
  assert.equal(row.verdict, "文档里没有");
});

test("lookClaim：要跑的命令这里不执行", () => {
  const row = lookClaim(
    claim({ locator: "def (test_fee)\\b", fact: { type: "test-passes", command: "pytest -q" } }),
    "def test_fee():\n",
    tree({}),
  );
  assert.equal(row.captured, "test_fee");
  assert.equal(row.verdict, "要跑命令");
  assert.equal(row.actual, null);
});

test("parseCatFileBatch：按字节切开，missing 是 null", () => {
  const body = Buffer.from("hello");
  const header = Buffer.from(`abc blob ${body.length}\n`);
  const missing = Buffer.from("def missing\n");
  const buf = Buffer.concat([header, body, Buffer.from("\n"), missing]);
  const got = parseCatFileBatch(buf);
  assert.equal(got.get("abc"), "hello");
  assert.equal(got.get("def"), null);
});

test("git grep 能捞到子目录里的句子，lookup 能查 JSON 而不靠把文件读进来", () => {
  const repo = new TestRepo();
  try {
    repo.commit({
      "docs/guide.md": "本作共 2 关。\n",
      "data/levels.json": JSON.stringify({ levels: [1, 2] }),
    });
    const drafts = draftsFromGrep(repo.dir);
    assert.equal(drafts[0]?.file, "docs/guide.md");
    assert.match(drafts[0]?.note ?? "", /docs\/guide\.md:1/);

    writeClaims(repo, [
      {
        id: "levels",
        label: "关数",
        file: "docs/guide.md",
        locator: "共 (\\d+) 关",
        fact: { type: "json-length", file: "data/levels.json", path: "levels" },
      },
    ]);
    const out = runLaminae(repo, "src/measure/lookup.ts", [path.join(repo.dir, ".laminae", "claims.json")]);
    assert.match(out, /捕获 2/);
    assert.match(out, /事实 2/);
    assert.match(out, /一致/);
    // lookup 只查不写：连 runs 目录都不该出现
    assert.equal(fs.existsSync(path.join(repo.dir, ".laminae", "runs")), false);
  } finally {
    repo.dispose();
  }
});
