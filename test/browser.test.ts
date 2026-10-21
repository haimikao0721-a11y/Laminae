/**
 * 在真实浏览器里加载生成的 HTML，检查前端脚本渲染出来的内容。
 * 找不到 Chrome / Edge 时跳过（设 CHROME_PATH 可以指定）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LEVELS_CLAIM, readme, runFile, runLaminae, sys, TestRepo, writeClaims } from "./helpers.ts";

function findChrome(): string | null {
  const candidates = [
    process.env["CHROME_PATH"],
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

const chrome = findChrome();

/** 加载页面，返回脚本执行完之后的 DOM */
function dumpDom(html: string): string {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "laminae-chrome-"));
  try {
    const r = spawnSync(
      chrome!,
      ["--headless=new", "--disable-gpu", "--no-sandbox", `--user-data-dir=${profile}`, "--virtual-time-budget=4000", "--dump-dom", pathToFileURL(html).href],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

test("每条说法的假段直接列在页面上：开始与结束的 commit、提交标题、收场方式", { skip: !chrome }, () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "assets/data/systems.json": sys(3), "README.md": readme(3) }, "初始");
    repo.commit({ "assets/data/systems.json": sys(4) }, "新增第四关");
    repo.commit({ "README.md": readme(4) }, "README 同步关数");
    repo.commit({ "assets/data/systems.json": sys(5) }, "新增第五关");
    repo.commit({ "x.txt": "x" }, "无关改动");
    writeClaims(repo, [LEVELS_CLAIM, { ...LEVELS_CLAIM, id: "always-true", label: "一直为真", file: "README.md", locator: "不会匹配(\\d+)" }]);
    runLaminae(repo, "scripts/run.ts");

    // 去掉 <script>：内联的数据和脚本源码里本来就含这些文字，要看的是脚本执行后渲染出来的 DOM
    const dom = dumpDom(runFile(repo, "laminae.html")).replace(/<script[\s\S]*?<\/script>/g, "");

    assert.ok(!dom.includes(">出错<"), "前端脚本不应报错");
    assert.equal((dom.match(/<article class="claim"/g) ?? []).length, 1, "只列出有过假段的说法");
    assert.ok(dom.includes("新增第四关"), "变假那一格的提交标题");
    assert.ok(dom.includes("README 同步关数"), "收场那一格的提交标题");
    assert.ok(dom.includes("文档追上了现实"), "收场方式");
    assert.ok(dom.includes("到 HEAD 仍为假"), "仍挂着的那一段");
    assert.ok(dom.includes("没有出现过假段"), "没有假段的说法被计数而不是静默丢掉");
  } finally {
    repo.dispose();
  }
});

test("调用关系、想法与线索渲染出来：节点、时间条、清单都在，脚本不报错", { skip: !chrome }, () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "src/a.js": "import { b } from './b.js'\n", "src/b.js": "export const b = 1\n", "README.md": "共 3 关\n", "assets/data/systems.json": sys(3), "ROADMAP.md": "- [ ] 做 feature\n" }, "c0");
    repo.commit({ "src/c.js": "import './a.js'\n" }, "c1 加 c");
    repo.commit({ "src/feature.js": "// TODO 补测试\n" }, "c2 做出 feature");
    writeClaims(repo, [LEVELS_CLAIM]);
    fs.writeFileSync(
      path.join(repo.dir, ".laminae", "ideas.json"),
      JSON.stringify([
        { id: "feature", text: "做 feature", target: "src/feature.js", fact: { type: "path-exists" } },
        { id: "no-d", text: "不做 d", target: "src/d.js", fact: { type: "path-exists" }, boundary: true },
      ]),
    );
    runLaminae(repo, "scripts/run.ts");

    const dom = dumpDom(runFile(repo, "laminae.html")).replace(/<script[\s\S]*?<\/script>/g, "");
    assert.ok(!dom.includes(">出错<"), "前端脚本不应报错");
    assert.equal((dom.match(/class="gn"/g) ?? []).length, 4, "a、b、c、feature 四个节点");
    assert.ok(dom.includes("c2 上：4 个模块，2 条引用"), "当前时间点的计数");
    assert.equal((dom.match(/<article class="idea"/g) ?? []).length, 2, "两条想法/边界");
    assert.ok(dom.includes("c2：已完成"), "想法在 HEAD 上已完成");
    assert.ok(dom.includes("c2：守住"), "边界在 HEAD 上守住");
    assert.ok(dom.includes("做 feature"), "想法文字");
    assert.ok(dom.includes("补测试"), "TODO 线索");
    assert.ok(dom.includes('href="#graph-card"'), "页头导航");
    // 两大块：裁决（说法、想法、边界）与描述（引用图、线索），性质不同，不能混在一块里
    const verdict = dom.slice(dom.indexOf('id="zone-verdict"'), dom.indexOf('id="zone-describe"'));
    const describe = dom.slice(dom.indexOf('id="zone-describe"'));
    assert.ok(dom.indexOf('id="zone-verdict"') > 0 && dom.indexOf('id="zone-describe"') > dom.indexOf('id="zone-verdict"'), "先裁决后描述");
    assert.ok(verdict.includes('id="map"') && verdict.includes('id="ideas-card"'), "裁决里有状态图和想法与边界");
    assert.ok(!verdict.includes('id="graph-card"') && !verdict.includes('id="cand-card"'), "裁决里不能有描述性的内容");
    assert.ok(describe.includes('id="graph-card"') && describe.includes('id="cand-card"'), "描述里有引用图和线索");
    assert.ok(!describe.includes('id="ideas-card"') && !describe.includes('id="map"'), "描述里不能有裁决性的内容");
  } finally {
    repo.dispose();
  }
});

test("引用边界渲染出来：越界清单、判不了的原因，图上有规则横幅的挂载点", { skip: !chrome }, () => {
  const repo = new TestRepo();
  try {
    repo.commit({ "src/ui/a.ts": "export const a = 1\n", "src/server/db.ts": "export const db = 1\n", "src/ui/w.ts": "import { x } from '@/server/zz'\n", "README.md": "x\n" }, "c0");
    repo.commit({ "src/ui/a.ts": "import { db } from '../server/db'\n" }, "c1 越界");
    writeClaims(repo, [{ id: "c", label: "c", file: "README.md", locator: "(x)", fact: { type: "text-in-file", file: "README.md" } }]);
    fs.writeFileSync(
      path.join(repo.dir, ".laminae", "ideas.json"),
      JSON.stringify([
        { id: "ui-server", text: "前端不许引用后端", fact: { type: "import-edge", from: "src/ui", to: "src/server" }, boundary: true },
        { id: "ui-zz", text: "前端不许引用 zz", fact: { type: "import-edge", from: "src/ui", to: "src/zz" }, boundary: true },
      ]),
    );
    runLaminae(repo, "scripts/run.ts");

    const dom = dumpDom(runFile(repo, "laminae.html")).replace(/<script[\s\S]*?<\/script>/g, "");
    assert.ok(!dom.includes(">出错<"), "前端脚本不应报错");
    assert.ok(dom.includes("c1：越界"), "边界在 HEAD 上越界");
    assert.ok(dom.includes("HEAD 上越界的引用（1 条）"), "越界清单的标题");
    assert.ok(dom.includes("src/ui/a.ts") && dom.includes("src/server/db.ts"), "越界的那一条引用");
    assert.ok(dom.includes("c1：测不出来"), "别名引用解析不了时是测不出来，不是守住");
    assert.ok(dom.includes("HEAD 上判不了："), "判不了要写出原因");
    assert.ok(dom.includes('id="g-rule"'), "图上有规则横幅的位置");
    assert.equal((dom.match(/class="linkbtn" data-focus="/g) ?? []).length, 2, "两条引用边界都能在图上看");
  } finally {
    repo.dispose();
  }
});