#!/usr/bin/env node
/**
 * laminae —— 快照
 *
 *   node scripts/snapshot.ts [laminae.html 的路径]      默认取 .laminae/latest 指向的那次
 *
 * 用无头 Chrome 把生成的单文件 HTML 拍成图（开发时核对样式用）。
 *
 * 产物：<仓库>/.laminae/shots/shot-*.png
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** 找默认的 HTML：优先 .laminae/latest 指向的那次运行，退回旧版根目录的 laminae.html */
function defaultHtml(): string {
  const latestFile = path.join(".laminae", "latest");
  try {
    const id = fs.readFileSync(latestFile, "utf8").trim();
    if (id !== "") {
      const p = path.join(".laminae", "runs", id, "laminae.html");
      if (fs.existsSync(p)) return path.resolve(p);
    }
  } catch {
    /* 没有 latest，走下面的旧路径 */
  }
  return path.resolve("laminae.html");
}

const HTML = path.resolve(process.argv[2] ?? defaultHtml());
/** 快照一律放 <仓库>/.laminae/shots，不跟着 HTML 走 —— HTML 现在在 runs/<id>/ 里 */
const OUT = path.join(path.resolve(".laminae", ".."), ".laminae", "shots");

if (!fs.existsSync(HTML)) {
  console.error(`找不到 ${HTML}。先在项目目录下运行 laminae 生成报告，或把路径作为参数传入。`);
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

/** 找 Chrome。找不到就跳过，不算失败。 */
function findChrome(): string | null {
  const candidates = [
    process.env["CHROME_PATH"],
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].filter((p): p is string => Boolean(p));

  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

const chrome = findChrome();
if (!chrome) {
  console.log("没找到 Chrome / Edge，跳过快照。设 CHROME_PATH 可以指定。");
  process.exit(0);
}

const url = pathToFileURL(HTML).href;

interface Shot {
  file: string;
  hash: string;
  size: string;
  note: string;
}

const shots: Shot[] = [
  { file: "shot-light.png", hash: "", size: "1450,800", note: "亮色总览" },
  { file: "shot-dark.png", hash: "#theme=dark", size: "1450,800", note: "暗色总览" },
  // 深链要在任意仓库上都有效：第 0 行第 0 格一定存在（越界的深链会被忽略，抽屉就不会打开）
  { file: "shot-drawer.png", hash: "#r=0&c=0", size: "1450,880", note: "抽屉：第一条说法的第一格" },
  { file: "shot-full.png", hash: "", size: "1450,2200", note: "整页，含每条说法的假段列表" },
];

console.log(`用 ${path.basename(chrome)} 拍 ${shots.length} 张`);

for (const s of shots) {
  const dest = path.join(OUT, s.file);
  try {
    execFileSync(
      chrome,
      [
        "--headless",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--virtual-time-budget=3000", // 等滑入动画结束，否则抽屉会被拍成拍到一半
        `--window-size=${s.size}`,
        `--screenshot=${dest}`,
        url + s.hash,
      ],
      { stdio: "ignore", timeout: 60_000 },
    );
    const kb = (fs.statSync(dest).size / 1024).toFixed(1);
    console.log(`  ${s.file.padEnd(24)} ${kb.padStart(7)} KB　${s.note}`);
  } catch (e) {
    console.log(`  ${s.file.padEnd(24)} 失败：${(e as Error).message.split("\n")[0]}`);
  }
}
