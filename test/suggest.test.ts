import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestClaims } from "../src/output/suggest.ts";

test("suggestClaims：下限、近似、命令、精确数各挑一条，并带上人还要改的说明", () => {
  const text = ["提供 1600+ 个图标", "大约 2000 个", "运行 pnpm run docs:dev", "本作共 12 关"].join("\n");
  const drafts = suggestClaims("README.md", text);
  const by = (note: string) => drafts.find((d) => d.note.includes(note));
  assert.equal(by("下限")?.compare, "gte");
  assert.match(by("下限")?.locator ?? "", /1600/);
  assert.equal(by("近似")?.compare, "approx");
  assert.equal(by("脚本名")?.fact.type, "json-has-key");
  assert.match(by("脚本名")?.locator ?? "", /docs:dev/);
  assert.equal(by("精确数量")?.compare, undefined);
  assert.ok(drafts.every((d) => d.file === "README.md" && d.note.length > 0));
});
