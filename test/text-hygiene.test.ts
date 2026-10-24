import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// 一次真实的翻车：
//
// 发布说明是用 PowerShell 的 here-string 写进去的，而 there-string 里反引号是转义符。
// 「`version`」里的 `v 被当成垂直制表符（U+000B），「`build/」里的 `b 被当成退格（U+0008）。
// 于是页面上出现一串方块：包内 package.json 里的 ▯ersion。
//
// 这类问题肉眼几乎看不出来——编辑器不显示控制字符，diff 也不明显。
// 所以让它机械可查：**仓库里所有文本文件都不许出现控制字符**（制表、换行、回车除外）。

const ROOT = path.resolve(import.meta.dirname, "..");

/** 只查这些后缀；二进制和生成物不查 */
const TEXT = new Set([".md", ".ts", ".json", ".mjs", ".css", ".html", ".yml", ".yaml", ".txt", ".ps1", ".sh", ".mts", ".cts"]);

/** 不算问题的控制字符：制表、换行、回车 */
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "build" || e.name === "out" || e.name === "runs") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, out);
    } else if (TEXT.has(path.extname(e.name))) {
      out.push(full);
    }
  }
}

test("仓库里的文本文件不含控制字符（反引号被解释成转义符的残留）", () => {
  const files: string[] = [];
  walk(ROOT, files);
  assert.ok(files.length > 50, "扫到的文件太少，路径可能不对");

  const bad: string[] = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 0x20 && !ALLOWED.has(code)) {
        const at = text.slice(Math.max(0, i - 20), i + 20).replace(/[\r\n]/g, " ");
        bad.push(`${path.relative(ROOT, f)}  位置 ${i}  U+${code.toString(16).toUpperCase().padStart(4, "0")}  附近：${at}`);
      }
    }
  }
  assert.deepEqual(bad, [], `发现控制字符：\n${bad.join("\n")}`);
});

test("发布说明这类随版本走的文本，反引号必须成对", () => {
  // 控制字符那条能抓住「`v」这种被吞掉一半的，但抓不住普通的落单反引号。
  // Markdown 里落单的反引号会把后面一整段变成代码块，所以单独查一下。
  for (const name of ["CHANGELOG.md", "README.md", "README.en.md"]) {
    const text = fs.readFileSync(path.join(ROOT, name), "utf8");
    // 三个反引号围起来的代码块先剔掉
    const withoutFences = text.replace(/```[\s\S]*?```/g, "");
    const ticks = (withoutFences.match(/`/g) ?? []).length;
    assert.equal(ticks % 2, 0, `${name} 里有落单的反引号，Markdown 会渲染错`);
  }
});

test("package.json 的版本号与最近一个 tag 一致", () => {
  // v0.1.1 曾经只打了 tag 没改 version，于是 laminae --version 说自己还是 0.1.0。
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string };
  let tags: string[] = [];
  try {
    tags = execFileSync("git", ["-C", ROOT, "tag", "-l", "v*", "--sort=-v:refname"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return; // 不是 git 仓库就算了，这条不该在那种环境里拦人
  }
  if (tags.length === 0) return; // 还没有 tag，没什么可比的
  const latest = tags[0]!.replace(/^v/, "");
  assert.equal(pkg.version, latest, `package.json 是 ${pkg.version}，最近的 tag 是 v${latest}`);
});
