import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaims } from "../src/measure/claims.ts";
import { lintClaims } from "../src/measure/lint.ts";

// 有些说法根本测不出来，却会静默判成「尚未写入文档」。
// 这比报错更糟：读起来像「文档没说这件事」，实际是这条说法没法测。
// click 上真的踩到了 —— 版本号 8.6.0 进了 regex-count 的捕获组。
//
// 另一类本来想在这里检查：fact 里写该类型不用的字段。parseClaims 只对
// 「compare 用在引用型事实」抛错，其余多余字段是静默丢掉的，所以这一类要报。

const docs: Record<string, string> = {
  "README.md": "# demo\n\n共 12 个文件。\n版本 8.6.0\n",
  "CHANGES.md": "## Version 8.6.0\n\n- 改动\n",
};

const check = (raw: unknown[]): ReturnType<typeof lintClaims> =>
  lintClaims(raw, parseClaims(raw), (f) => (Object.hasOwn(docs, f) ? docs[f]! : null));

test("说法体检：捕获到 8.6.0 这种带点的版本号，不能拿去跟数比", () => {
  const w = check([
    {
      id: "versions",
      label: "版本号",
      file: "CHANGES.md",
      locator: "## Version (\\d+[.]\\d+[.]\\d+)",
      fact: { type: "regex-count", file: "CHANGES.md", pattern: "^## Version " },
    },
  ]);
  const hit = w.find((x) => x.code === "capture-not-number");
  assert.ok(hit, "要报出来");
  assert.equal(hit!.level, "error");
  assert.match(hit!.message, /8\.6\.0/, "要把捕获到的原样写出来，作者才知道改哪里");
});

test("说法体检：数字没问题的说法不要报", () => {
  const w = check([
    {
      id: "count",
      label: "文件数",
      file: "README.md",
      locator: "共 (\\d+) 个文件",
      fact: { type: "count-files", glob: "src/*.ts" },
    },
  ]);
  assert.deepEqual(w, []);
});

test("说法体检：fact 里写了该类型不认的字段要报，因为它会被静默丢掉", () => {
  const w = check([
    {
      id: "x",
      label: "带多余字段",
      file: "README.md",
      locator: "共 (\\d+) 个文件",
      fact: { type: "count-files", glob: "src/*.ts", compare: "gte", claim: 5 },
    },
  ]);
  const hit = w.find((x) => x.code === "ignored-fact-field");
  assert.ok(hit, "要报出来 —— parseFact 会把这两个字段丢掉，不留痕迹");
  assert.equal(hit!.level, "error");
  assert.match(hit!.message, /compare/);
  assert.match(hit!.message, /claim/);
});

test("说法体检：locator 在文档里一处都匹配不到要明说", () => {
  const w = check([
    {
      id: "miss",
      label: "找不到的句子",
      file: "README.md",
      locator: "根本没有这句话 (\\d+)",
      fact: { type: "line-count", file: "README.md" },
    },
  ]);
  assert.ok(w.some((x) => x.code === "locator-miss" && x.level === "error"));
});
