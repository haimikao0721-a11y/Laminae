#!/usr/bin/env node
/**
 * laminae —— 生成单文件 HTML
 *
 *   node <laminae>/src/render.ts      在要核验的项目目录下运行
 *
 * 把数据（.laminae/runs/<id>/payload.json）、预构建的脚本（dist/app.js）、样式（web/style.css）
 * 三样内联进一个 HTML。组件、样式、数据全在文件里，零依赖、零外部请求，双击就能开。
 *
 * 产物：<目标仓库>/laminae.html
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertBoundRepo } from "../core/config.ts";
import { ensureExcluded } from "../core/exclude.ts";
import { HTML_PATH, PAYLOAD_PATH, SKILL_ROOT } from "../core/paths.ts";
import { EVIDENCE, REASON_TEXT } from "../layers/layers-core.ts";
import { OUTCOME_TEXT } from "../core/types.ts";
import type { Interval, LayerReport, Outcome, Payload } from "../core/types.ts";

assertBoundRepo();

// 允许指定数据与落盘位置。校验要用：拿同一份 payload 重渲一遍，
// 逐字节和已有产物比 —— 不一致就说明这个 HTML 不是从数据算出来的。
const argOf = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const dataPath = argOf("--payload") ?? PAYLOAD_PATH;
const htmlPath = argOf("--out") ?? HTML_PATH;
const jsPath = path.join(SKILL_ROOT, "dist", "app.js");
const cssPath = path.join(SKILL_ROOT, "web", "style.css");

for (const p of [dataPath, jsPath, cssPath]) {
  if (!fs.existsSync(p)) {
    console.error(`缺少 ${p}。${p === jsPath ? "先在 laminae 目录运行 npm run build:web。" : "先跑前面的步骤。"}`);
    process.exit(1);
  }
}

// 渲染器指纹：产物记下自己是哪个版本的渲染器生成的。
// 校验时如果对不上，只说明「报告比渲染器旧」，不能说成「有人改过」——
// 每次都喊狼来了，这个检查很快就没人看了。
const rendererFp = createHash("sha1")
  .update(fs.readFileSync(jsPath))
  .update(fs.readFileSync(cssPath))
  .update(fs.readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex")
  .slice(0, 16);

const payload = JSON.parse(fs.readFileSync(dataPath, "utf8")) as Payload;
const appJs = fs.readFileSync(jsPath, "utf8");
const css = fs.readFileSync(cssPath, "utf8");

/* ── 汇总条 ── */

const stat = (k: string, v: string, unit?: string): string =>
  `<div class="stat"><span class="k">${k}</span><span class="v">${v}${unit ? ` <small>${unit}</small>` : ""}</span></div>`;

/* ── 说法体检 ──
 *
 * 有些说法根本测不出来，却被静默判成「尚未写入文档」。这比报错更糟：
 * 读起来像「文档没说这件事」，实际是这条说法没法测。所以放在最上面，先于任何结论。
 */
const warningsHtml = (): string => {
  const w = payload.claimWarnings ?? [];
  if (w.length === 0) return "";
  const items = w
    .map((x) => `<li><b>${x.level === "error" ? "测不了" : "提示"}</b> <code>${esc(x.label)}</code>：${esc(x.message)}</li>`)
    .join("");
  const errs = w.filter((x) => x.level === "error").length;
  return `<section class="card warnings" id="claim-warnings">
  <h2>先说清楚：有 ${w.length} 条说法写得有问题<small>${errs > 0 ? `其中 ${errs} 条根本测不出来，它们在下面的状态里会显示成「尚未写入文档」——那不是文档没写，是这条说法没法测。` : "这些不影响判定，只是写法可以更好。"}</small></h2>
  <ul>${items}</ul>
  <p class="hintline">这里只报写法问题，不改判定。就像你不该把「我没测」当成「文档没写」一样。</p>
</section>`;
};

const s = payload.summary;
const sv = s.survival;
const statsHtml = [
  // 中位数用 Kaplan-Meier 估计：仍挂着的段是右删失的，直接取中位数会偏小
  sv.medianCommits === null
    ? stat("中位 hiatus", "无法估计", "删失的段太多，曲线没降到 50%")
    : stat("中位 hiatus", String(sv.medianCommits), `commit / ${sv.medianHours} 小时`),
  stat("样本", String(sv.n), `段先真后假，其中 ${sv.censored} 段仍挂着`),
  stat("曾为假", String(s.everFalse), `共 ${s.claimCount} 条说法`),
  stat("HEAD 仍为假", String(s.falseAtHead), "条说法"),
  stat("写下即假", String(s.bornFalse), "从未真过"),
].join("");

/* ── 收场方向：不一致是靠改文档、删说法还是改现实消失的 ── */

const cl = s.closure;
const pct = (n: number): string => `${Math.round((n / cl.determinable) * 100)}%`;
const closureHtml =
  cl.determinable === 0
    ? ""
    : `<p class="closure">已收场且能判定方向的 ${cl.determinable} 段：改文档（补上或改正）${cl.docUpdated} 段（${pct(cl.docUpdated)}），删掉说法 ${cl.docRemoved} 段（${pct(cl.docRemoved)}），改现实 ${cl.realityFixed} 段（${pct(cl.realityFixed)}）。另有 ${cl.undetermined} 段判不出方向，${cl.pending} 段仍挂着。</p>`;

/* ── 结局分布。每条可点，跳到第一个属于该结局的假段 ── */

const OUTCOME_ORDER: Outcome[] = [
  "hanging-reality-still", "hanging-reality-moved", "doc-caught-up",
  "doc-corrected", "reality-caught-up", "doc-removed", "both-changed", "unmeasurable", "anomaly",
];
const KIND: Record<string, string> = {
  "reality-caught-up": "resolved", "doc-caught-up": "resolved", "doc-corrected": "resolved",
  "doc-removed": "doc",
};

const total = s.runCount || 1;
const outcomesHtml = OUTCOME_ORDER.filter((o) => (s.outcomes[o] ?? 0) > 0)
  .map((o) => {
    const n = s.outcomes[o] ?? 0;
    const pct = Math.round((n / total) * 100);
    return `<button type="button" class="obar" data-outcome="${o}" data-kind="${KIND[o] ?? "broken"}">
      <span>${OUTCOME_TEXT[o]}</span>
      <span class="track"><span class="fill" style="width:${pct}%"></span></span>
      <span class="n">${n}</span>
    </button>`;
  })
  .join("");

/* ── 内联 JSON 的安全转义 ──
   把 < 转成 \u003c，避免文档正文里的 </script> 把标签提前闭合。 */
const safeJson = JSON.stringify(payload).replace(/</g, "\\u003c");

/* ── 可选的几节：数据有才输出，没有就不占位置 ── */

const cd = payload.candidates;
const hasCandidates = Boolean(cd && cd.checklist.open + cd.checklist.done + cd.todos.total > 0);

/* ── 页面分两大块 ──
   裁决：说法、想法、边界。回答「原来成立的事，后来还成不成立」，逐 commit 判真假，算 hiatus 与结局。
   描述：引用关系图、想法线索。回答「结构现在长什么样、有什么苗头」，只呈现，不判真假。
   两块性质不同，不能混在一起，否则读者分不清哪些是结论、哪些只是素材。 */

const hasDescribe = Boolean(payload.graph) || hasCandidates;

/* ── 层与层的对账 ── */

const esc = (s: string): string => s.replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]!);

const span = (alive: Interval, n: number): string => (alive[0] === alive[1] ? `c${alive[0]}` : alive[1] === n - 1 ? `c${alive[0]} 起至今` : `c${alive[0]}–c${alive[1]}`);

const spans = (alive: readonly Interval[], n: number): string => alive.map((a) => span(a, n)).join("、");

const CONTRACT_KIND: Record<string, string> = { route: "HTTP 路径" };

/** 列表太长时只列前若干条，并注明还剩多少 */
const capped = (items: string[], max: number): string =>
  items.length <= max ? items.join("") : items.slice(0, max).join("") + `<li class="none">还有 ${items.length - max} 条</li>`;

const FAKE_WORD: Record<string, string> = {
  empty: "空文件",
  unimplemented: "写着没实现",
  placeholder: "函数是空的，或只返回空值",
};
const COVER_WORD: Record<string, string> = {
  forward: "转到别的文件",
  "test-only": "只有测试在用",
  "loose-compare": "措辞盖住了差额",
  alias: "别名看不清",
  "handler-unresolved": "处理函数没追到",
  range: "文档像是区间",
  "one-sided": "契约只有一侧",
};

/** 工具没追上，不能当成用户项目里的缺陷 */
const UNVERIFIED_HOW = new Set(["handler-unresolved", "one-sided", "alias"]);

function downHtml(l: LayerReport, n: number): string {
  // 只存在于历史的条目不能和现存的问题混在一起。
  // click 上 100 条里有 53 条是 2014 年单文件时代的骨架，早就没了；
  // 混排之后截前 40 条，看到的全是历史噪声，真正还在的问题反而排不进去。
  const live = (l.down ?? []).filter((d) => d.atHead);
  const gone = (l.down ?? []).filter((d) => !d.atHead);
  const line = (d: LayerReport["down"][number]): string => {
    const where = d.holds.length > 0 ? `说法或想法「${d.holds.map(esc).join("、")}」在这段时间里成立。` : "没有说法指向它，是从代码里直接看到的。";
    const via = d.via ? `追到 <code>${esc(d.via)}</code>。` : "";
    return `<li><code>${esc(d.file)}:${d.line}</code> <b>${esc(d.name)}</b> ${REASON_TEXT[d.reason] ?? d.reason}。${via}（${spans(d.alive, n)}）。${where}</li>`;
  };
  const items = live.map(line);
  const old = gone.map(line);
  const subtitle =
    gone.length > 0
      ? `空函数、只返回空值、写着没实现、只去调用别的空函数。这是迹象，不是已经确认的业务错误。每条落到函数和定义行。当前还成立的 ${live.length} 条；另有 ${gone.length} 条只在历史提交里出现过，折叠在下面`
      : `空函数、只返回空值、写着没实现、只去调用别的空函数。这是迹象，不是已经确认的业务错误。每条落到函数和定义行`;
  return `<section class="card outcomes" id="down-card">
  <h2>需要人工复核：函数往下看一层<span class="grade grade-heuristic" title="能：${esc(EVIDENCE.heuristic.can)}　不能：${esc(EVIDENCE.heuristic.cannot)}">${esc(EVIDENCE.heuristic.label)}</span><small>${subtitle}</small></h2>
  ${items.length === 0 ? `<p class="hintline">当前没有还成立的这种函数。</p>` : `<ul>${capped(items, 40)}</ul>`}
  ${
    old.length === 0
      ? ""
      : `<details class="history"><summary>另有 ${old.length} 条只在历史提交里出现过，现在已不存在</summary><ul>${capped(old, 40)}</ul></details>`
  }
</section>`;
}

function layersHtml(l: LayerReport, n: number): string {
  // 每一块都标出证据等级。这不是装饰 —— 它是这份报告最要紧的分类：
  // 「有出处」的错了是一跑就露，「看形状推断」的这一路上整类整类地错过。
  const grade = (bucket: keyof typeof l.evidence): string => {
    const key = l.evidence[bucket];
    const e = EVIDENCE[key];
    return `<span class="grade grade-${key}" title="能：${esc(e.can)}　不能：${esc(e.cannot)}">${esc(e.label)}</span>`;
  };
  const gradeLegend = (): string => {
    const levels = ["stated", "mentioned", "structural", "heuristic"] as const;
    return `<ul class="grades">${levels
      .map((k) => `<li><span class="grade grade-${k}">${esc(EVIDENCE[k].label)}</span> 能：${esc(EVIDENCE[k].can)}。不能：${esc(EVIDENCE[k].cannot)}。</li>`)
      .join("")}</ul>`;
  };

  const hollow = l.hollow.map(
    (h) =>
      `<li>${h.kind === "claim" ? "说法" : "想法"}「${esc(h.label)}」在 ${spans(h.alive, n)} 为成立，但 <code>${esc(h.file)}</code> 是假实现：${FAKE_WORD[h.depth] ?? h.depth}</li>`,
  );
  const coverLi = (c: LayerReport["covers"][number]): string =>
    `<li><b>${COVER_WORD[c.how] ?? c.how}</b> ${esc(c.label)}：${esc(c.detail)}（${spans(c.alive, n)}）</li>`;
  const unverified = l.covers.filter((c) => UNVERIFIED_HOW.has(c.how)).map(coverLi);
  const reviewCovers = l.covers.filter((c) => !UNVERIFIED_HOW.has(c.how)).map(coverLi);
  const unproven = l.unproven.map(
    (u) => `<li>${u.kind === "claim" ? "说法" : "想法"}「${esc(u.label)}」指着 <code>${esc(u.file)}</code>，里面有实质代码（${spans(u.alive, n)}）。这不能说明它真的做了这件事</li>`,
  );
  const orphans = l.orphans.map((o) => `<li><code>${esc(o.file)}</code>（${spans(o.alive, n)}）</li>`);
  const clues = l.clues.map((c) => `<li><code>${esc(c.file)}</code> 里有 <code>${esc(c.kind)}</code>（${spans(c.alive, n)}）</li>`);

  const contracts = l.contracts
    .map((c) => {
      const name = CONTRACT_KIND[c.kind] ?? c.kind;
      const declSide = c.declared.length === 0 ? "声明侧没有" : `声明侧有（${spans(c.declared, n)}）`;
      const refSide = c.referenced.length === 0 ? "引用侧没有" : `引用侧有（${spans(c.referenced, n)}）`;
      const both = c.declared.length > 0 && c.referenced.length > 0;
      const verdict = !both
        ? "缺一侧，不比较。纯库、纯前端、纯后端都是正常的项目形态，不算洞"
        : c.unmet.length === 0 && c.fake.length === 0
          ? "路径对得上"
          : [c.unmet.length > 0 ? `对不上 ${c.unmet.length} 处` : "", c.fake.length > 0 ? `路径对上但有 ${c.fake.length} 条是假实现` : ""].filter(Boolean).join("，");
      const unmet = c.unmet
        .map((u) => `<li><code>${esc(u.name)}</code> 被 ${u.files.map((f) => `<code>${esc(f)}</code>`).join("、")} 引用，没有声明（${spans(u.alive, n)}）</li>`)
        .join("");
      const fake = c.fake
        .map((f) => `<li><code>${esc(f.name)}</code>（<code>${esc(f.file)}</code>）：${esc(f.note)}（${spans(f.alive, n)}）</li>`)
        .join("");
      return `<li><b>${esc(name)}</b>：${declSide}，${refSide}。${verdict}${unmet || fake ? `<ul>${unmet}${fake}</ul>` : ""}</li>`;
    })
    .join("");

  return `<section class="card outcomes" id="layers-card">
  <h2>层与层对不上的地方<small>每一块都标出证据等级。等级说的是「这条结论能拿它做什么」，不是严重程度</small></h2>
  ${gradeLegend()}
  <h3>需要人工复核${grade("hollow")}<small>说法为真但指着的文件像空壳，或纯转发、只有测试在用、措辞把差额盖住</small></h3>
  ${hollow.length + reviewCovers.length === 0 ? `<p class="hintline">没有。</p>` : `<ul>${capped([...hollow, ...reviewCovers], 40)}</ul>`}
  <h3>无法验证<small>工具没追上：处理函数接不上、契约只有一侧、别名解析不了。不要当成项目里的问题</small></h3>
  ${unverified.length === 0 ? `<p class="hintline">没有。</p>` : `<ul>${capped(unverified, 40)}</ul>`}
  <h3>有实质代码，但还不能算真实现${grade("unproven")}<small>排除了假实现和纯转发。工具看不到这段代码是不是在做说法里的那件事</small></h3>
  ${unproven.length === 0 ? `<p class="hintline">没有。</p>` : `<ul>${capped(unproven, 15)}</ul>`}
  <h3>孤立模块${grade("orphans")}<small>没被任何代码引用，不是入口或测试，也没有任何说法或想法提到。这是一个中性事实，不是「该删」</small></h3>
  ${orphans.length === 0 ? `<p class="hintline">没有。</p>` : `<ul>${capped(orphans, 40)}</ul>`}
  <h3>契约${grade("contracts")}<small>仓库里声明的东西和别处引用的东西，按种类配对。缺任何一侧只记录，不判为洞</small></h3>
  ${contracts === "" ? `<p class="hintline">没有找到契约（目前只认 HTTP 路径：路由声明和 fetch / axios 调用）。</p>` : `<ul>${contracts}</ul>`}
  <h3>语法还没有模块${grade("unsupported")}<small>认得出是代码，但不会判断深浅，也不画引用</small></h3>
  ${(l.unsupported ?? []).length === 0 ? `<p class="hintline">没有。</p>` : `<ul>${capped((l.unsupported ?? []).map((u) => `<li><code>${esc(u.file)}</code>（${spans(u.alive, n)}）</li>`), 40)}</ul>`}
  <h3>注入线索${grade("clues")}<small>危险调用点的位置，只是线索，不判断能不能被利用</small></h3>
  ${clues.length === 0 ? `<p class="hintline">没有。</p>` : `<ul>${capped(clues, 40)}</ul>`}
</section>`;
}

const group = (kind: string, name: string, links: string[]): string =>
  links.length === 0 ? "" : `<span class="nav-group" data-kind="${kind}"><b>${name}</b>${links.join("")}</span>`;

const navHtml = hasDescribe
  ? `<nav class="nav">${[
      group("verdict", "裁决", [
        payload.layers ? `<a href="#down-card">往下看一层</a>` : "",
        `<a href="#zone-verdict">说法与真假</a>`,
        payload.ideas ? `<a href="#ideas-card">想法与边界</a>` : "",
        payload.layers ? `<a href="#layers-card">层与层对不上</a>` : "",
      ].filter(Boolean)),
      group("describe", "描述", [
        payload.graph ? `<a href="#graph-card">引用关系</a>` : "",
        hasCandidates ? `<a href="#cand-card">想法线索</a>` : "",
      ].filter(Boolean)),
    ].join("")}</nav>`
  : payload.ideas
    ? `<nav class="nav">${group("verdict", "裁决", [payload.layers ? `<a href="#down-card">往下看一层</a>` : "", `<a href="#zone-verdict">说法与真假</a>`, `<a href="#ideas-card">想法与边界</a>`, payload.layers ? `<a href="#layers-card">层与层对不上</a>` : ""].filter(Boolean))}</nav>`
    : "";

/* ── 许可声明 ──
 *
 * 生成的 HTML 内联了编译后的浏览器端脚本，属于 MIT 里说的「软件的实质部分」，
 * 所以要把版权声明与许可全文一起带进去。
 *
 * 从 LICENSE 读，不在这里另抄一份：抄一份就会两边对不上，改许可的时候容易漏。
 * HTML 注释里不能出现连续两个连字符；MIT 正文没有，但有备无患地替换一下。
 */
function licenseNotice(): string {
  try {
    const text = fs.readFileSync(path.join(SKILL_ROOT, "LICENSE"), "utf8").trim();
    if (text === "") return "";
    return [
      "<!--",
      "laminae 的报告。这个文件内联了 laminae 自己的样式与脚本，按下述许可发布。",
      "被核验项目的代码、文档和数据不在此列，它们仍按该项目的许可。",
      "",
      text.replace(/--/g, "- -"),
      "-->",
    ].join("\n");
  } catch {
    return "";
  }
}

/* ── 拼 HTML ── */

const html = `<!doctype html>
<html lang="zh-CN" data-theme="auto">
<head>
<meta name="laminae-renderer" content="${rendererFp}">
<meta charset="utf-8">
${licenseNotice()}
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${payload.title} — ${payload.repo}</title>
<style>
${css}
</style>
</head>
<body>

<main class="page">

<header class="head">
  <div>
    <h1>${payload.title}</h1>
    <p class="sub">${payload.subtitle}</p>
  </div>
  <div class="tools">
    <button id="theme" type="button">主题：跟系统</button>
    <button id="print" type="button">打印 / 存 PDF</button>
  </div>
</header>

${navHtml}

${warningsHtml()}

${payload.layers ? downHtml(payload.layers, payload.commits.length) : ""}

<section class="zone" id="zone-verdict" data-kind="verdict">
<header class="zone-head">
  <span class="zone-tag">裁决</span>
  <h2>原来说成立的事，后来还成不成立</h2>
  <p>本次写进 claims.json 的说法有 ${payload.claims.length} 条。没写进去的业务逻辑，这份报告没有检查。红色只表示这一条声明和测到的事实不一致，有两边的值和位置。下面「无法验证」是工具没追上，不是缺陷清单。</p>
</header>

<div class="stats">${statsHtml}</div>

<section class="card chart">
  <div class="toolbar">
    <label class="search">
      <span class="ico" aria-hidden="true">搜</span>
      <input id="search" type="search" placeholder="按说法名、文件、原文筛" autocomplete="off">
    </label>
    <div class="views" id="views" role="group" aria-label="预设视图"></div>
    <button id="play" type="button" class="play" title="按 commit 一格一格推进，看红色怎么长出来">播放</button>
  </div>

  <div class="readout" id="readout">把鼠标移到任意一格上；点开看证据</div>

  <div class="wrap">
    <div class="map" id="map" role="grid" aria-label="说法在每个 commit 上的真假">
      <div class="band" id="band-row"></div>
      <div class="band" id="band-col"></div>
      <div class="curtain" id="curtain"></div>
    </div>
  </div>

  <div class="legend" id="legend"></div>
  <div class="rulewarn" id="rulewarn" hidden></div>
</section>

<section class="card outcomes" id="outcomes">
  <h2>假段是怎么收场的<small>共 ${s.runCount} 段，点一条跳到实例</small></h2>
  ${closureHtml}
  ${outcomesHtml || "<p style='color:var(--muted);font-size:12.5px'>没有假段。</p>"}
</section>

<section class="card outcomes details" id="details">
  <h2>每条说法的假段<small>从哪个 commit 开始、怎么收场，跟随上面的筛选；点 commit 编号看那一格的详情</small></h2>
  <div id="details-list"></div>
  <p class="details-note" id="details-note"></p>
</section>

${payload.ideas ? `<section class="card outcomes" id="ideas-card">
  <h2>想法与边界<small>每条用一个可核对的证据；颜色是证据在那个 commit 上满不满足。想法 = 要做的，边界 = 刻意不做的</small></h2>
  <div id="ideas-body"></div>
</section>` : ""}

${payload.layers ? layersHtml(payload.layers, payload.commits.length) : ""}

</section>

${hasDescribe ? `<section class="zone" id="zone-describe" data-kind="describe">
<header class="zone-head">
  <span class="zone-tag">描述</span>
  <h2>结构现在长什么样、有什么苗头</h2>
  <p>只呈现，不判真假：没有 hiatus，也没有结局。想把它和裁决连起来，点图里的模块，看相关的说法与想法。</p>
</header>

${payload.graph ? `<section class="card outcomes" id="graph-card">
  <h2>模块之间的引用关系<small>谁引用了谁（import / require）。默认只画鼠标指着的那个模块的线；用时间标尺看任意一天的样子，或和另一个时间点对比</small></h2>
  <div id="graph-body"></div>
</section>` : ""}

${hasCandidates ? `<section class="card outcomes" id="cand-card">
  <h2>想法线索<small>从路线图清单和 TODO 里找到的，尚未确认，工具不替你判定</small></h2>
  <div id="cand-body"></div>
</section>` : ""}

</section>` : ""}

</main>

<div class="scrim" id="scrim"></div>
<aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-label="说法详情">
  <button class="close" id="close" type="button" aria-label="关闭">×</button>
  <div class="inner"></div>
</aside>

<script>window.__LAMINAE__ = ${safeJson};</script>
<script>
${appJs}
</script>
</body>
</html>
`;

ensureExcluded();
fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
fs.writeFileSync(htmlPath, html, "utf8");

const kb = (n: number): string => (n / 1024).toFixed(1) + " KB";
console.log("已生成单文件 HTML");
console.log(`  ${HTML_PATH}　${kb(Buffer.byteLength(html, "utf8"))}`);
console.log(`  其中：数据 ${kb(Buffer.byteLength(safeJson, "utf8"))}　样式 ${kb(Buffer.byteLength(css, "utf8"))}　脚本 ${kb(Buffer.byteLength(appJs, "utf8"))}`);
console.log("  外部请求：0 个（抽屉里的核对链接是用户主动点的目标，不计入）");
