import { test } from "node:test";
import assert from "node:assert/strict";
import { indexPackages, isCodeFile, isTestFile, packageNameOf, parseBareSpecs, parseFileImports, parseImportLine, resolveBareSpecs, resolveImports, resolveJs, resolvePython } from "../src/layers/imports.ts";
import type { ResolveEnv } from "../src/layers/imports.ts";

const env = (files: string[], pkgs: Record<string, string> = {}): ResolveEnv => ({
  files: new Set(files),
  read: (f) => pkgs[f] ?? null,
});

test("parseImportLine：JS/TS 的几种引用写法", () => {
  const specs = (line: string): string[] => (parseImportLine("a.ts", line) ?? []).map((r) => r.spec);
  assert.deepEqual(specs(`import x from "./a"`), ["./a"]);
  assert.deepEqual(specs(`import { a, b } from '../lib/b'`), ["../lib/b"]);
  assert.deepEqual(specs(`export * from "./c";`), ["./c"]);
  assert.deepEqual(specs(`import "./side-effect"`), ["./side-effect"]);
  assert.deepEqual(specs(`const x = require('./d')`), ["./d"]);
  assert.deepEqual(specs(`const m = await import("./e.js")`), ["./e.js"]);
  assert.deepEqual(specs(`const root = require('../')`), ["../"]);
  assert.deepEqual(specs(`} from './multi-line'`), ["./multi-line"]);
});

test("parseImportLine：第三方包、方法调用、普通字符串都不算", () => {
  const none = (line: string): void => assert.equal(parseImportLine("a.ts", line), null, line);
  none(`import fs from "node:fs"`);
  none(`import React from 'react'`);
  none(`const x = require("lodash")`);
  none(`program.command('./not-an-import')`);
  none(`const s = "./just a string"`);
  none(`this.command().action()`);
});

test("parseImportLine：Python 的相对与绝对引用", () => {
  const p = (line: string) => parseImportLine("pkg/a.py", line);
  assert.deepEqual(p("from . import auth, query as q"), [{ spec: ".", names: ["auth", "query"] }]);
  assert.deepEqual(p("from .utils import date"), [{ spec: ".utils", names: ["date"] }]);
  assert.deepEqual(p("from ..core.base import Base  # 注释"), [{ spec: "..core.base", names: ["Base"] }]);
  assert.deepEqual(p("import os, sys"), [{ spec: "os" }, { spec: "sys" }]);
  assert.deepEqual(p("import pkg.sub as s"), [{ spec: "pkg.sub" }]);
  assert.deepEqual(p("from pkg import (a, b)"), [{ spec: "pkg", names: ["a", "b"] }]);
  assert.equal(p("x = 1"), null);
});

test("parseFileImports：压缩产物和二进制不解析", () => {
  assert.equal(parseFileImports("a.js", "import x from './a'\nimport y from './b'").length, 2);
  assert.deepEqual(parseFileImports("a.js", "x".repeat(600 * 1024)), []);
  assert.deepEqual(parseFileImports("a.js", "import x from './a'\u0000"), []);
});

test("resolveJs：扩展名、index、TS 里写 .js 指向 .ts", () => {
  const e = env(["src/a.ts", "src/b.js", "src/lib/index.ts", "src/c.tsx", "src/d.ts"]);
  assert.equal(resolveJs("src/x.ts", "./a", e), "src/a.ts");
  assert.equal(resolveJs("src/x.ts", "./b.js", e), "src/b.js");
  assert.equal(resolveJs("src/x.ts", "./lib", e), "src/lib/index.ts");
  assert.equal(resolveJs("src/x.ts", "./c", e), "src/c.tsx");
  assert.equal(resolveJs("src/x.ts", "./d.js", e), "src/d.ts", "TS 习惯写 .js，实际文件是 .ts");
  assert.equal(resolveJs("src/x.ts", "./missing", e), null);
});

test("resolveJs：引用目录时取 package.json 的 main，没有就找 index", () => {
  const e = env(["index.js", "lib/main.js", "package.json", "tests/a.test.js"], { "package.json": '{"main":"./lib/main.js"}' });
  assert.equal(resolveJs("tests/a.test.js", "../", e), "lib/main.js");
  assert.equal(resolveJs("tests/a.test.js", "..", e), "lib/main.js");
  const noMain = env(["index.js", "package.json", "tests/a.test.js"], { "package.json": "{}" });
  assert.equal(resolveJs("tests/a.test.js", "../", noMain), "index.js");
  const broken = env(["index.js", "package.json", "t/a.js"], { "package.json": "{ 坏的" });
  assert.equal(resolveJs("t/a.js", "../", broken), "index.js", "package.json 损坏时退回 index");
});

test("resolvePython：相对引用按点号向上，from . import 的名字可能是子模块", () => {
  const e = env(["pkg/__init__.py", "pkg/a.py", "pkg/auth/__init__.py", "pkg/auth/oauth.py", "pkg/utils.py", "pkg/commands/q.py"]);
  assert.deepEqual(resolvePython("pkg/a.py", { spec: ".utils", names: ["date"] }, e), ["pkg/utils.py"]);
  // from . import x 依赖包本身（__init__）以及 x（如果 x 是子模块）；自己引用自己会在 resolveImports 里去掉
  assert.deepEqual(resolvePython("pkg/a.py", { spec: ".", names: ["auth", "utils", "nope"] }, e).sort(), ["pkg/__init__.py", "pkg/auth/__init__.py", "pkg/utils.py"]);
  assert.deepEqual(resolveImports("pkg/__init__.py", "from . import auth", e).sort(), ["pkg/auth/__init__.py"]);
  assert.deepEqual(resolvePython("pkg/auth/oauth.py", { spec: "..utils", names: [] }, e), ["pkg/utils.py"]);
  assert.deepEqual(resolvePython("pkg/commands/q.py", { spec: "pkg.auth.oauth" }, e), ["pkg/auth/oauth.py"], "绝对引用向上找仓库根");
  assert.deepEqual(resolvePython("pkg/a.py", { spec: "os" }, e), [], "标准库、第三方不在仓库里");
});

test("resolveImports：不指向自己，不指向非代码文件", () => {
  const e = env(["a.js", "style.css", "data.json"]);
  assert.deepEqual(resolveImports("a.js", `import "./a"`, e), []);
  assert.deepEqual(resolveImports("a.js", `import "./style.css"`, e), []);
});

test("isCodeFile / isTestFile", () => {
  assert.ok(isCodeFile("src/a.ts"));
  assert.ok(isCodeFile("pkg/a.py"));
  assert.ok(!isCodeFile("README.md"));
  assert.ok(!isCodeFile("node_modules/x/index.js"));
  assert.ok(!isCodeFile("dist/app.js"));
  assert.ok(!isCodeFile("types/index.d.ts"));
  assert.ok(!isCodeFile("lib/x.min.js"));
  for (const f of ["tests/a.js", "test/a.js", "src/__tests__/a.ts", "a.test.ts", "a.spec.js", "pkg/test_a.py", "pkg/a_test.py", "test.py", ".storybook/config.js", "stories/LazyImage.story.tsx"]) assert.ok(isTestFile(f), f);
  for (const f of ["src/latest.js", "src/contest/a.js", "src/a.ts"]) assert.ok(!isTestFile(f), f);
});

test("parseBareSpecs：包名和别名路径都收，相对路径、node: 与协议不收，Python 不做", () => {
  const text = [
    'import a from "lodash"',
    'import b from "@/server/db"',
    'const c = require("@acme/core/util")',
    'import d from "./local"',
    'import e from "node:fs"',
    'const f = await import("src/server/x")',
    'import type { G } from "https://x.dev/g.ts"',
  ].join("\n");
  assert.deepEqual(parseBareSpecs("a.ts", text).sort(), ["@/server/db", "@acme/core/util", "lodash", "src/server/x"]);
  assert.deepEqual(parseBareSpecs("a.py", "import os\nfrom x import y"), []);
});

test("packageNameOf：带 scope 取两段，别名 @/x 不是合法包名", () => {
  assert.equal(packageNameOf("lodash/fp"), "lodash");
  assert.equal(packageNameOf("@acme/core/util"), "@acme/core");
  assert.equal(packageNameOf("@/server/db"), "@/server");
  assert.equal(packageNameOf("react"), "react");
});

test("indexPackages：汇总各类依赖；根目录的 package.json 不算内部包；损坏的跳过", () => {
  const pk = indexPackages([
    { file: "package.json", body: JSON.stringify({ name: "root", dependencies: { react: "1" }, devDependencies: { vitest: "1" } }) },
    { file: "packages/core/package.json", body: JSON.stringify({ name: "@acme/core", peerDependencies: { vue: "3" } }) },
    { file: "packages/bad/package.json", body: "{ not json" },
    { file: "packages/gone/package.json", body: null },
  ]);
  assert.deepEqual([...pk.deps].sort(), ["react", "vitest", "vue"]);
  assert.deepEqual([...pk.workspace], [["@acme/core", "packages/core"]]);
});

test("resolveBareSpecs：内部包解析成文件，声明过的依赖与内置模块忽略，其余记为未知", () => {
  const files = ["packages/core/src/util.ts", "packages/core/index.ts", "packages/core/package.json", "src/server/db.ts"];
  const e = env(files, { "packages/core/package.json": "{}" });
  const pk = indexPackages([
    { file: "package.json", body: JSON.stringify({ dependencies: { react: "1" } }) },
    { file: "packages/core/package.json", body: JSON.stringify({ name: "@acme/core" }) },
  ]);
  const r = resolveBareSpecs(["@acme/core", "@acme/core/util", "@acme/core/nope", "react", "react/jsx-runtime", "fs", "fs/promises", "@/server/db", "src/server/db", "left-pad"], pk, e);
  assert.deepEqual(r.targets.sort(), ["packages/core/index.ts", "packages/core/src/util.ts"]);
  assert.deepEqual(r.unknown.sort(), ["@/server/db", "@acme/core/nope", "left-pad", "src/server/db"]);
});