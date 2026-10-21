#!/usr/bin/env node
/**
 * laminae —— 浏览器端构建（开发时用，使用 skill 时不需要）
 *
 *   npm run build:web
 *
 * 把 web/app.ts 编译成浏览器能直接跑的单文件 JS。
 * 用 esbuild 只做转译与打包，不做压缩，产物要能读。
 *
 * 产物：dist/app.js，已入库。skill 运行时直接内联它，目标仓库不需要装任何东西。
 * 改了 web/ 或 src/types.ts 之后要重新构建并提交。
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DIST = path.join(ROOT, "dist");

fs.mkdirSync(DIST, { recursive: true });

const result = await esbuild.build({
  entryPoints: [path.join(ROOT, "web", "app.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022", "chrome110", "firefox110", "safari16"],
  write: false,
  legalComments: "none",
  charset: "utf8",
  logLevel: "warning",
});

const file = result.outputFiles?.[0];
if (!file) {
  console.error("esbuild 没有产出文件");
  process.exit(1);
}

const js = file.text;
fs.writeFileSync(path.join(DIST, "app.js"), js, "utf8");

const kb = (n: number): string => (n / 1024).toFixed(1) + " KB";
console.log("浏览器端构建完成");
console.log(`  web/app.ts → dist/app.js　${kb(Buffer.byteLength(js, "utf8"))}`);
if (result.warnings.length) {
  console.log(`  警告 ${result.warnings.length} 条`);
  for (const w of result.warnings) console.log("    " + w.text);
}
