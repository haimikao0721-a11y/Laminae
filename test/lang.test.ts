import { test } from "node:test";
import assert from "node:assert/strict";
import { isUnsupportedCode, langOf } from "../src/lang.ts";
import { isCodeFile } from "../src/imports.ts";
import { buildLayers, joinLayers } from "../src/layers-core.ts";
import type { CommitLayer, LayerCommit } from "../src/layers-core.ts";

test("langOf：JS/TS/Python 支持，Java/Go/Rust/C# 认得出但没有模块，别的不当成代码", () => {
  assert.equal(langOf("src/a.ts"), "js");
  assert.equal(langOf("src/a.mjs"), "js");
  assert.equal(langOf("pkg/a.py"), "py");
  for (const f of ["A.java", "main.go", "lib.rs", "P.cs", "A.kt", "a.rb"]) assert.equal(langOf(f), "unsupported", f);
  assert.equal(langOf("README.md"), null);
  assert.equal(langOf("node_modules/x/a.ts"), null);
  assert.equal(isCodeFile("A.java"), false);
  assert.equal(isUnsupportedCode("A.java"), true);
});

test("buildLayers：未支持的语言单独列出，不进孤立模块", () => {
  const layer = (p: Partial<CommitLayer> = {}): CommitLayer => ({ stubs: [], facts: [], declares: [], references: [], clues: [], ...p });
  const commit = (files: string[], l: Partial<CommitLayer> = {}): LayerCommit => ({ files, edges: [], layer: layer(l) });
  const data = buildLayers([commit(["src/a.ts"], { unsupported: ["src/Main.java"] })]);
  assert.deepEqual(data.unsupported.map((u) => u.file), ["src/Main.java"]);
  assert.ok(!data.unreferenced.some((u) => u.file.endsWith(".java")));
  const report = joinLayers(data, []);
  assert.deepEqual(report.unsupported.map((u) => u.file), ["src/Main.java"]);
});
