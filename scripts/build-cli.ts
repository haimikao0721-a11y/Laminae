#!/usr/bin/env node
/**
 * laminae —— 把 CLI 和八个命令打包成可以直接 npm 安装的 js
 *
 * 为什么必须打包：
 *
 * 这个仓库里的代码是 `.ts`，靠 Node 的类型擦除直接跑。仓库里这么用没问题，
 * 但**装成包之后跑不了** —— Node 明确拒绝为 node_modules 下的文件擦除类型：
 *
 *   Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]:
 *   Stripping types is currently unsupported for files under node_modules
 *
 * 所以发布出去的那份必须是 js。用 esbuild 把每个入口连同它引用到的模块打成一个文件：
 * 九个入口各自独立、互不依赖，装完直接能跑，不需要用户装 TypeScript。
 *
 * 产物：build/laminae.mjs 与 build/<命令>.mjs，各一个自包含文件。
 * 仓库里照旧 `node scripts/run.ts` 直接跑，不受影响。
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "build");

/** 入口：bin 下面那个分发器，加上八个命令各自的原脚本 */
const COMMANDS = ["run", "init", "diff", "verify", "derive", "trace", "branches", "merges"];

/**
 * run.ts / verify.ts 是**起子进程**跑这六步的，不是 import 进来的。
 * 所以这六个也必须各自打成一个产物，否则装成包之后那一步会找不到文件。
 */
const STEPS: { name: string; file: string }[] = [
  { name: "measure", file: "src/measure/measure.ts" },
  { name: "analyze", file: "src/judge/analyze.ts" },
  { name: "graph", file: "src/layers/graph.ts" },
  { name: "ideas", file: "src/ideas/ideas.ts" },
  { name: "build-data", file: "src/output/build-data.ts" },
  { name: "render", file: "src/output/render.ts" },
];

const entries: { in: string; out: string }[] = [
  { in: path.join(ROOT, "bin", "laminae.ts"), out: path.join(OUT, "laminae.mjs") },
  ...COMMANDS.map((name) => ({
    in: path.join(ROOT, "scripts", `${name}.ts`),
    out: path.join(OUT, `${name}.mjs`),
  })),
  ...STEPS.map((s) => ({
    in: path.join(ROOT, s.file),
    out: path.join(OUT, `${s.name}.mjs`),
  })),
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let total = 0;
for (const e of entries) {
  if (!fs.existsSync(e.in)) {
    console.error(`缺入口：${e.in}`);
    process.exit(1);
  }
  await build({
    entryPoints: [e.in],
    outfile: e.out,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // 不要额外加 shebang：esbuild 会保留源文件开头那一行，
    // 再加一个就变成两行，第二行不是文件第一个字符，Node 不认，直接语法错。
    // 只有 node: 前缀的内建模块留成外部依赖，其余全部打进来
    external: ["node:*"],
    // 让源码里的「是不是直接入口」判断在产物里恒假，见 src/core/entry.ts 的 isEntry
    define: { "process.env.LAMINAE_BUNDLED": '"1"' },
    logLevel: "warning",
  });
  const size = fs.statSync(e.out).size;
  total += size;
  console.log(`  ${path.relative(ROOT, e.out).padEnd(22)}${Math.round(size / 1024)} KB`);
}

console.log(`\n共 ${entries.length} 个文件，${Math.round(total / 1024)} KB，写在 ${path.relative(ROOT, OUT)}/`);
