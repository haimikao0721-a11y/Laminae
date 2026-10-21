import { test } from "node:test";
import assert from "node:assert/strict";
import { isUnsupportedCode, langOf } from "../src/lang.ts";
import { isCodeFile, resolveRust } from "../src/imports.ts";
import { rsModule } from "../src/syntax-rs.ts";
import { buildLayers, joinLayers } from "../src/layers-core.ts";
import type { CommitLayer, LayerCommit } from "../src/layers-core.ts";

test("langOf：JS/TS/Python/Rust 支持，Java/Go/C# 认得出但没有模块，别的不当成代码", () => {
  assert.equal(langOf("src/a.ts"), "js");
  assert.equal(langOf("src/a.mjs"), "js");
  assert.equal(langOf("pkg/a.py"), "py");
  assert.equal(langOf("crates/a/src/lib.rs"), "rs");
  for (const f of ["A.java", "main.go", "P.cs", "A.kt", "a.rb"]) assert.equal(langOf(f), "unsupported", f);
  assert.equal(isUnsupportedCode("crates/a/src/lib.rs"), false, "Rust 现在有语法模块了");
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

test("Rust：fn 识别、unimplemented 算空壳、空函数体与 trait 声明不算", () => {
  const text = [
    "pub fn calc_bonus(base: u32) -> u32 { base * 2 }",
    "fn empty_default() {}",
    "pub async fn not_done() -> u8 { unimplemented!() }",
    "fn guard(x: u8) -> u8 { match x { 0 => 1, _ => unreachable!() } }",
    "trait T { fn decl(&self) -> u8; }",
  ].join("\n");
  const fns = rsModule.findFunctions(text);
  const by = new Map(fns.map((f) => [f.name, f.reason]));
  assert.equal(by.get("calc_bonus"), null, "有代码的函数不判空");
  assert.equal(by.get("empty_default"), null, "Rust 里空函数体是常见写法（trait 默认实现），不当作空壳");
  assert.equal(by.get("not_done"), "unimplemented", "unimplemented!() 才算写着没实现");
  assert.equal(by.get("guard"), null, "unreachable!() 是守卫，不是没实现");
  assert.equal(by.has("decl"), false, "trait 里的声明没有函数体，不当作函数");
});

test("Rust：use 与 mod 的解析按 crate 根的模块路径走", () => {
  const files = new Set(["crates/a/src/lib.rs", "crates/a/src/engine.rs", "crates/a/src/engine/parser.rs", "crates/a/src/util/mod.rs"]);
  const env = { files, read: () => null };
  assert.deepEqual(resolveRust("crates/a/src/editor.rs", "crate::engine::Engine", env), ["crates/a/src/engine.rs"]);
  assert.deepEqual(resolveRust("crates/a/src/editor.rs", "crate::engine::parser::parse", env), ["crates/a/src/engine/parser.rs"]);
  assert.deepEqual(resolveRust("crates/a/src/editor.rs", "crate::util::x", env), ["crates/a/src/util/mod.rs"]);
  assert.deepEqual(resolveRust("crates/a/src/editor.rs", "std::collections::HashMap", env), [], "外部 crate 不解析");
});
