/**
 * laminae —— 浏览器端
 *
 * 用 HTML 元素加 CSS Grid 画状态历史图，不用 SVG。
 * 数据在构建期已经算好全部结论（hiatus、结局、汇总），这里只负责渲染与交互。
 *
 * 交互语言参考 archify：
 *   来源可点开去核对、搜索、预设视图、图例可点、时间推进播放。
 *   没有照搬它的小地图、Reading Depth、Route Probe —— 这个图用不上。
 */
import { TRUE, FALSE, ABSENT, UNMEASURED, OUTCOME_TEXT } from "../src/core/types.ts";
import { comparePrefix, describeCompare } from "../src/measure/compare.ts";
import type { Payload, ClaimTimeline, Outcome, Run } from "../src/core/types.ts";
import { initGraph } from "./graph.ts";
import { gridView, initGridZoom, tickSet } from "./gridzoom.ts";
import { initIdeas } from "./ideas.ts";
import { timeline } from "./shared.ts";

declare global {
  interface Window {
    __LAMINAE__: Payload;
  }
}

const P = window.__LAMINAE__;
const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`找不到元素：${sel}`);
  return el;
};

/** 单文件工具的用户没有控制台。任何未捕获的错误都摆到读数据条上，别静默失败。 */
function reportError(what: string, err: unknown): void {
  const msg = err instanceof Error ? `${err.message}` : String(err);
  const bar = document.querySelector("#readout");
  if (bar) bar.innerHTML = `<span class="pill" data-s="1">出错</span><span>${what}：${msg}</span>`;
  console.error(what, err);
}
window.addEventListener("error", (e) => reportError("运行时错误", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => reportError("未处理的 Promise", e.reason));

const mapEl = $("#map");
const readoutEl = $("#readout");
const drawerEl = $("#drawer");
const scrimEl = $("#scrim");
const searchEl = $<HTMLInputElement>("#search");
const viewsEl = $("#views");

const N_COLS = P.commits.length;
const N_ROWS = P.claims.length;

const STATE_TEXT = ["真", "假", "尚未写入文档", "测不出来"] as const;

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]!);

/** 文档写的：数值型显示数，其余显示捕获到的那段文本 */
const fmtClaimed = (cl: ClaimTimeline, c: number): string =>
  cl.kind === "number"
    ? `${cl.claimed[c] === null || cl.claimed[c] === undefined ? "" : comparePrefix(cl.compare)}${cl.claimed[c] ?? "—"}`
    : `「${escapeHtml(cl.claimedText[c] ?? "—")}」`;

/** 实际的：数值型显示数；引用型是在不在；测试是过不过；输出差分是变没变 */
const fmtActual = (cl: ClaimTimeline, v: number | null): string => {
  if (v === null) return "—";
  if (cl.kind === "exists") return v === 1 ? "存在" : "不存在";
  if (cl.kind === "holds") return v === 1 ? "通过" : "失败";
  if (cl.kind === "stable") return v === 1 ? "没变" : "变了";
  return String(v);
};

/* ────────────── 视图状态 ────────────── */

type ViewId = "all" | "false" | "born-false" | "ever-false" | "by-hiatus" | "by-impact";

interface ViewDef {
  id: ViewId;
  label: string;
  hint: string;
}

const VIEWS: ViewDef[] = [
  { id: "all", label: "全部", hint: "按原顺序" },
  { id: "false", label: "仍为假", hint: "到 HEAD 还没解决的" },
  { id: "born-false", label: "写下即假", hint: "从未真过" },
  { id: "ever-false", label: "曾为假", hint: "包括已经解决的" },
  { id: "by-hiatus", label: "按 hiatus 排序", hint: "烂得最久的排最上" },
  ...(P.claims.some((c) => c.impact !== "normal")
    ? [{ id: "by-impact" as const, label: "按重要程度", hint: "claims.json 里标了 high 的排最上，同级按 hiatus" }]
    : []),
];

const IMPACT_RANK = { high: 0, normal: 1, low: 2 } as const;
const IMPACT_TEXT = { high: "重要", normal: "", low: "次要" } as const;

let view: ViewId = "all";
let query = "";
/** 图例点了哪一种状态，null 表示没点 */
let stateFilter: number | null = null;
/** 当前显示顺序，元素是 P.claims 的下标 */
let order: number[] = P.claims.map((_, i) => i);

/** 某条说法最长的假段长度，排序用 */
const maxRun = (c: ClaimTimeline): number => c.runs.reduce((m, r) => Math.max(m, r.len), 0);

function computeOrder(): number[] {
  const idx = P.claims.map((_, i) => i);

  let keep: (i: number) => boolean = () => true;
  if (view === "false") keep = (i) => P.claims[i]!.atHead === FALSE;
  else if (view === "born-false") keep = (i) => P.claims[i]!.bornFalse;
  else if (view === "ever-false") keep = (i) => P.claims[i]!.totalFalse > 0;

  let out = idx.filter(keep);

  if (query.trim()) {
    const q = query.trim().toLowerCase();
    out = out.filter((i) => {
      const c = P.claims[i]!;
      return (c.label + " " + c.file + " " + c.asserts + " " + c.verbatim).toLowerCase().includes(q);
    });
  }

  if (view === "by-hiatus") out = [...out].sort((a, b) => maxRun(P.claims[b]!) - maxRun(P.claims[a]!));

  if (view === "by-impact") {
    out = [...out].sort(
      (a, b) =>
        IMPACT_RANK[P.claims[a]!.impact] - IMPACT_RANK[P.claims[b]!.impact] || maxRun(P.claims[b]!) - maxRun(P.claims[a]!),
    );
  }

  return out;
}

/* ────────────── 渲染 ────────────── */

const tickIndexes = (): Set<number> => tickSet(N_COLS, gridView.step);

function renderAxis(): DocumentFragment {
  const ticks = tickIndexes();
  const frag = document.createDocumentFragment();

  const axis = document.createElement("div");
  axis.className = "axis";
  axis.appendChild(document.createElement("span")); // 与标签列对齐
  for (let c = 0; c < N_COLS; c++) {
    const t = document.createElement("span");
    t.className = "tick";
    t.textContent = ticks.has(c) ? String(c) : "";
    axis.appendChild(t);
  }
  frag.appendChild(axis);
  return frag;
}

function renderRow(r: number): DocumentFragment {
  const claim = P.claims[r]!;
  const frag = document.createDocumentFragment();

  const lb = document.createElement("div");
  lb.className = "lb";
  lb.dataset["r"] = String(r);
  lb.title = `${claim.label}　${claim.file}${claim.line ? ":" + claim.line : ""}`;
  if (claim.bornFalse) {
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.title = "写下即假：从未真过";
    lb.appendChild(mark);
  }
  if (claim.impact !== "normal") {
    const tag = document.createElement("span");
    tag.className = "impact";
    tag.dataset["i"] = claim.impact;
    tag.textContent = IMPACT_TEXT[claim.impact];
    tag.title = "使用者在 claims.json 里标的重要程度，只影响排序";
    lb.appendChild(tag);
  }
  lb.appendChild(document.createTextNode(claim.label));
  frag.appendChild(lb);

  for (let c = 0; c < N_COLS; c++) {
    const s = claim.states[c] ?? ABSENT;
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset["r"] = String(r);
    cell.dataset["c"] = String(c);
    cell.dataset["s"] = String(s);
    cell.setAttribute("role", "gridcell");
    cell.tabIndex = -1;
    cell.setAttribute("aria-label", `${claim.label}，第 ${c} 个 commit，${STATE_TEXT[s]}`);
    frag.appendChild(cell);
  }
  return frag;
}

function render(): void {
  mapEl.style.setProperty("--cols", String(N_COLS));
  mapEl.querySelectorAll(".axis, .lb, .cell").forEach((el) => el.remove());

  const frag = document.createDocumentFragment();
  frag.appendChild(renderAxis());
  for (const r of order) frag.appendChild(renderRow(r));
  mapEl.appendChild(frag);

  // 恢复选中环
  if (picked) {
    mapEl.querySelector<HTMLElement>(`.cell[data-r="${picked.r}"][data-c="${picked.c}"]`)?.setAttribute("data-picked", "1");
  }
  applyStateFilter();
  renderDetails();
}

/* ────────────── 每条说法的假段：不点开就能看 ────────────── */

const detailsEl = $("#details-list");
const detailsNoteEl = $("#details-note");

/** 一个 commit：编号、短 sha、提交标题。编号那个按钮点了会打开抽屉 */
function commitLine(c: number): string {
  const commit = P.commits[c];
  if (!commit) return `<span class="mono">c${c}</span>`;
  return (
    `<button type="button" class="dt-commit" data-c="${c}">c${c} <span class="mono">${commit.short}</span></button>` +
    `<span class="dt-subj">${escapeHtml(commit.subject)}</span>`
  );
}

/** 一个假段讲成两行：从哪个 commit 开始变假，又是哪个 commit 以什么方式收场 */
function runStory(claim: ClaimTimeline, run: Run): string {
  const what = `文档写 <b>${fmtClaimed(claim, run.from)}</b>，实际 <b>${fmtActual(claim, run.actualAtStart)}</b>`;
  const start = run.bornFalse ? `写下即假：${what}` : `变假：${what}`;
  const length = `${run.len} commit / ${run.hours} 小时`;
  const end =
    run.to + 1 >= N_COLS
      ? `到 HEAD 仍为假，已挂 ${length}；${run.realityMoved ? "期间现实动过，文档没跟上" : "现实一直没动"}`
      : `${commitLine(run.to + 1)}<span class="dt-what">${OUTCOME_TEXT[run.outcome]}，共挂 ${length}</span>`;
  return `<li data-live="${run.censored ? "1" : "0"}">
    <div class="dt-row"><span class="dt-tag">开始</span>${commitLine(run.from)}<span class="dt-what">${start}</span></div>
    <div class="dt-row"><span class="dt-tag">结束</span>${end}</div>
  </li>`;
}

/** 按当前的视图与搜索结果，逐条列出有过假段的说法 */
function renderDetails(): void {
  const withRuns = order.filter((r) => P.claims[r]!.runs.length > 0);
  const skipped = order.length - withRuns.length;
  detailsEl.innerHTML = withRuns
    .map((r) => {
      const c = P.claims[r]!;
      const where = `${escapeHtml(c.file)}${c.line ? ":" + c.line : ""}`;
      const now =
        c.headClaimed === null ? "" : `文档写 ${fmtClaimed(c, N_COLS - 1)} · 实际 ${fmtActual(c, c.headActual)}`;
      return `<article class="claim" data-r="${r}">
        <header>
          <h3>${escapeHtml(c.label)}</h3>
          ${c.impact === "normal" ? "" : `<span class="impact" data-i="${c.impact}">${IMPACT_TEXT[c.impact]}</span>`}
          <span class="mono">${where}</span>
          <span class="pill" data-s="${c.atHead}">HEAD：${STATE_TEXT[c.atHead]}</span>
          ${c.ruleMiss ? `<span class="pill" data-s="3" title="locator 从没匹配到：可能是文档没写，也可能是规则写错">规则没匹配到</span>` : ""}
          ${c.captureHint ? `<span class="pill" data-s="3" title="捕获文本多带了字符，去掉首尾标点就对得上">捕获可疑</span>` : ""}
          <span class="dt-now">${now}</span>
        </header>
        <ul class="dt-runs">${c.runs.map((run) => runStory(c, run)).join("")}</ul>
      </article>`;
    })
    .join("");
  detailsNoteEl.textContent =
    withRuns.length === 0
      ? "当前视图里没有出现过假段的说法。"
      : skipped > 0
        ? `另有 ${skipped} 条没有出现过假段，未列出。`
        : "";
}

function applyStateFilter(): void {
  for (const el of mapEl.querySelectorAll<HTMLElement>(".cell")) {
    const on = stateFilter === null || Number(el.dataset["s"]) === stateFilter;
    el.dataset["dim"] = on ? "0" : "1";
  }
  for (const el of mapEl.querySelectorAll<HTMLElement>(".lb")) el.dataset["dim"] = "0";
}

/* ────────────── 几何：每次现问 DOM，不缓存 ────────────── */

function offsetIn(el: Element): { top: number; left: number; w: number; h: number } {
  const b = el.getBoundingClientRect();
  const m = mapEl.getBoundingClientRect();
  return { top: b.top - m.top, left: b.left - m.left, w: b.width, h: b.height };
}

function moveBands(r: number | null, c: number | null): void {
  const bandRow = $<HTMLElement>("#band-row");
  const bandCol = $<HTMLElement>("#band-col");

  if (r === null || c === null) {
    mapEl.dataset["hover"] = "0";
    return;
  }
  const rowCell = mapEl.querySelector(`.cell[data-r="${r}"][data-c="0"]`);
  const colCell = mapEl.querySelector(`.cell[data-r="${order[0] ?? 0}"][data-c="${c}"]`);
  if (!rowCell || !colCell) return;

  const rb = offsetIn(rowCell);
  const cb = offsetIn(colCell);

  bandRow.style.top = `${rb.top}px`;
  bandRow.style.height = `${rb.h}px`;
  bandCol.style.left = `${cb.left}px`;
  bandCol.style.width = `${cb.w}px`;
  mapEl.dataset["hover"] = "1";
}

/* ────────────── 读数据区 ────────────── */

function showReadout(r: number, c: number): void {
  const claim = P.claims[r];
  const commit = P.commits[c];
  if (!claim || !commit) return;
  const s = claim.states[c] ?? ABSENT;
  const detail =
    s === ABSENT
      ? "该 commit 上文档里还没有这条说法"
      : s === UNMEASURED
        ? `文档写 <b>${fmtClaimed(claim, c)}</b>，该 commit 上测不到对应的事实`
        : `文档写 <b>${fmtClaimed(claim, c)}</b>，实际 <b>${fmtActual(claim, claim.actual[c] ?? null)}</b>`;

  readoutEl.innerHTML =
    `<span class="pill" data-s="${s}">${STATE_TEXT[s]}</span>` +
    `<span>${claim.label}</span>` +
    `<span class="sep">·</span>` +
    `<span>${detail}</span>` +
    `<span class="sep">·</span>` +
    `<span class="mono">${commit.short}</span>` +
    `<span>c${c}</span>` +
    `<span>${commit.date}</span>` +
    `<span class="subj">${escapeHtml(commit.subject)}</span>`;
}

/* ────────────── 抽屉 ────────────── */

/** 去 GitHub 上核对这一行。钉到具体 commit，不是 HEAD。没有仓库地址时返回空串。 */
function blobUrl(sha: string, file: string, line: number): string {
  if (!P.repoUrl) return "";
  return `${P.repoUrl}/blob/${sha}/${file.split("/").map(encodeURIComponent).join("/")}#L${line}`;
}

let picked: { r: number; c: number } | null = null;

function openDrawer(r: number, c: number): void {
  const claim = P.claims[r];
  const commit = P.commits[c];
  if (!claim || !commit) return;
  picked = { r, c };

  const s = claim.states[c] ?? ABSENT;
  // 措辞是行程编码的，找出包含这一格的那一段
  const here = claim.verbatimRuns.find((r) => c >= r.from && c <= r.to)?.text ?? null;
  const lineNo = claim.line;

  // 「在这个 commit 上，文档那一行到底怎么写的」
  const hereText =
    here === null
      ? `<p style="color:var(--muted);font-size:12.5px;margin:0">这个 commit 上，文档里还没有这条说法。</p>`
      : `<div class="quote">${escapeHtml(here)}</div>
         <p class="hint">文档写的 <b>${fmtClaimed(claim, c)}</b>　实际 <b>${fmtActual(claim, claim.actual[c] ?? null)}</b></p>
         ${s === UNMEASURED ? `<p class="hint">这个 commit 上测不到对应的事实（例如被测文件缺失或损坏），无法判断真假。</p>` : ""}`;

  const changedFromHead = here !== null && here !== claim.verbatim;

  const runsHtml = claim.runs.length
    ? `<ul class="runs">${claim.runs
        .map((run) => {
          const live = run.censored ? "1" : "0";
          const end = run.to + 1 >= N_COLS ? "到 HEAD 仍为假" : `${OUTCOME_TEXT[run.outcome]}（c${run.to + 1}）`;
          return `<li data-live="${live}">
            <div>c${run.from} 到 c${run.to}　<b>${run.len} commit / ${run.hours} 小时</b></div>
            <div class="meta">${end}</div>
          </li>`;
        })
        .join("")}</ul>`
    : `<p style="color:var(--muted);font-size:12.5px;margin:0">${N_COLS} 个 commit 上都是真的。</p>`;

  drawerEl.querySelector(".inner")!.innerHTML = `
    <h2>${escapeHtml(claim.label)}</h2>
    <div class="where">
      ${
        blobUrl(commit.sha, claim.file, lineNo || 1)
          ? `<a class="mono" href="${blobUrl(commit.sha, claim.file, lineNo || 1)}" target="_blank" rel="noopener">
        ${escapeHtml(claim.file)}${lineNo ? ":" + lineNo : ""}
      </a>`
          : `<span class="mono">${escapeHtml(claim.file)}${lineNo ? ":" + lineNo : ""}</span>`
      }
      <span class="sep">·</span>被测事实 <code>${escapeHtml(claim.asserts)}</code>${describeCompare(claim.compare, claim.tolerance) ? `<span class="sep">·</span>${describeCompare(claim.compare, claim.tolerance)}` : ""}
    </div>

    <section>
      <h3>文档是这么写的</h3>
      <div class="quote">${escapeHtml(claim.verbatim)}</div>
      ${
        claim.inexact
          ? `<p class="hint inexact">措辞像是下限 / 近似（「${escapeHtml(claim.inexact)}」），这条说法现在按严格相等比较，红色可能不是文档的本意。在 claims.json 里给它加 <code>compare</code>（gte / lte / approx）。</p>`
          : ""
      }
      ${
        claim.ruleMiss
          ? `<p class="hint inexact">这条的 locator 在整段历史里一次都没匹配到。可能是文档确实没写过这句话，也可能是 <code>${escapeHtml(claim.locator)}</code> 写错了 —— 灰色不是「文档没写」的结论，是「没找到」。跑 <code>lookup</code> 看它到底捕获到了什么。</p>`
          : ""
      }
      ${
        claim.captureHint
          ? `<p class="hint inexact">捕获到的文本去掉首尾标点之后，「${escapeHtml(claim.captureHint)}」在仓库里确实存在。多半是 locator 的捕获组多带了字符（比如把反引号写进了括号里），不是文档写错了。</p>`
          : ""
      }
      ${
        blobUrl(commit.sha, claim.file, lineNo || 1)
          ? `<a class="verify" href="${blobUrl(commit.sha, claim.file, lineNo || 1)}" target="_blank" rel="noopener">
        去 GitHub 核对这一行
      </a>`
          : ""
      }
    </section>

    <section>
      <h3>在 ${commit.short}（c${c}）上</h3>
      <div class="kv">
        <span class="k">状态</span><span class="v"><span class="pill" data-s="${s}">${STATE_TEXT[s]}</span></span>
      </div>
      ${hereText}
      ${changedFromHead ? `<p class="hint">注意：这一格上的措辞与 HEAD 不同，上面「文档是这么写的」显示的是 HEAD 的当前措辞。</p>` : ""}
      <div class="kv" style="margin-top:10px">
        <span class="k">提交</span><span class="v mono">${escapeHtml(commit.subject)}</span>
        <span class="k">时间</span><span class="v">${commit.date}　+${commit.hours} 小时</span>
      </div>
    </section>

    <section>
      <h3>假了多久</h3>
      ${runsHtml}
    </section>

    <section>
      <h3>HEAD 上</h3>
      <div class="kv">
        <span class="k">状态</span><span class="v"><span class="pill" data-s="${claim.atHead}">${STATE_TEXT[claim.atHead]}</span></span>
        <span class="k">文档写的</span><span class="v">${claim.headClaimed === null ? "—" : fmtClaimed(claim, N_COLS - 1)}</span>
        <span class="k">实际的</span><span class="v">${fmtActual(claim, claim.headActual)}</span>
        <span class="k">累计为假</span><span class="v">${claim.totalFalse} / ${N_COLS} 个 commit</span>
        ${claim.evidence.length ? `<span class="k">证据文件</span><span class="v">${claim.evidence.map((f) => `<code>${escapeHtml(f)}</code>`).join(" ")}</span>` : ""}
      </div>
    </section>
  `;

  drawerEl.dataset["open"] = "1";
  scrimEl.dataset["open"] = "1";
  mapEl.querySelectorAll<HTMLElement>('[data-picked="1"]').forEach((el) => delete el.dataset["picked"]);
  mapEl.querySelector<HTMLElement>(`.cell[data-r="${r}"][data-c="${c}"]`)?.setAttribute("data-picked", "1");
  writeHash(r, c);
}

function closeDrawer(): void {
  drawerEl.dataset["open"] = "0";
  scrimEl.dataset["open"] = "0";
}

/* ────────────── 深链 ────────────── */

function readHash(): { r: number; c: number; theme: string | null } | null {
  const h = location.hash.replace(/^#/, "");
  if (!h) return null;
  const p = new URLSearchParams(h);
  const theme = p.get("theme");
  const r = Number(p.get("r"));
  const c = Number(p.get("c"));
  if (!Number.isInteger(r) || !Number.isInteger(c)) return theme ? { r: 0, c: 0, theme } : null;
  if (r < 0 || r >= N_ROWS || c < 0 || c >= N_COLS) return null;
  return { r, c, theme };
}

function writeHash(r: number, c: number): void {
  const next = `#r=${r}&c=${c}`;
  if (location.hash !== next) history.replaceState(null, "", next);
}

/* ────────────── 播放：看着红色一格格长出来 ────────────── */

let playAt = -1;
let playTimer: number | null = null;

function setCurtain(at: number): void {
  const curtain = $<HTMLElement>("#curtain");
  if (at < 0) {
    curtain.style.display = "none";
    return;
  }
  const firstRow = order[0];
  const cell = firstRow === undefined ? null : mapEl.querySelector(`.cell[data-r="${firstRow}"][data-c="${Math.min(at + 1, N_COLS - 1)}"]`);
  if (!cell) {
    curtain.style.display = "none";
    return;
  }
  const o = offsetIn(cell);
  curtain.style.display = "block";
  curtain.style.left = `${o.left}px`;
  curtain.style.top = "0";
  curtain.style.bottom = "0";
  curtain.style.right = "0";
}

function stopPlay(): void {
  if (playTimer !== null) {
    clearInterval(playTimer);
    playTimer = null;
  }
  playAt = -1;
  setCurtain(-1);
  $<HTMLButtonElement>("#play").textContent = "播放";
}

function togglePlay(): void {
  if (playTimer !== null) {
    stopPlay();
    return;
  }
  const btn = $<HTMLButtonElement>("#play");
  btn.textContent = "停止";
  playAt = 0;
  setCurtain(0);
  playTimer = window.setInterval(() => {
    playAt++;
    if (playAt >= N_COLS) {
      stopPlay();
      return;
    }
    setCurtain(playAt);
    const commit = P.commits[playAt];
    if (commit) {
      readoutEl.innerHTML =
        `<span class="pill">播放中</span><span>c${playAt}</span>` +
        `<span class="mono">${commit.short}</span><span>${commit.date}</span>` +
        `<span>+${commit.hours} 小时</span>` +
        `<span class="subj">${escapeHtml(commit.subject)}</span>`;
    }
  }, 90);
}

/* ────────────── 交互 ────────────── */

let activeR = 0;
let activeC = 0;

function setActive(r: number, c: number, focus = false): void {
  activeR = Math.max(0, Math.min(N_ROWS - 1, r));
  activeC = Math.max(0, Math.min(N_COLS - 1, c));
  mapEl.querySelectorAll<HTMLElement>(".cell").forEach((el) => (el.tabIndex = -1));
  const el = mapEl.querySelector<HTMLElement>(`.cell[data-r="${activeR}"][data-c="${activeC}"]`);
  if (el) {
    el.tabIndex = 0;
    if (focus) el.focus();
  }
  if (el) {
    moveBands(activeR, activeC);
    showReadout(activeR, activeC);
  }
}

function renderViews(): void {
  viewsEl.innerHTML = VIEWS.map(
    (v) => `<button type="button" data-view="${v.id}" data-on="${v.id === view ? "1" : "0"}" title="${v.hint}">${v.label}</button>`,
  ).join("");
}

function renderLegend(): void {
  const legend = $("#legend");
  const counts = [0, 0, 0, 0];
  for (const c of P.claims) for (const s of c.states) counts[s] = (counts[s] ?? 0) + 1;
  // 「测不出来」只在确实出现时才进图例
  const shown = [TRUE, FALSE, ABSENT, ...((counts[UNMEASURED] ?? 0) > 0 ? [UNMEASURED] : [])];
  legend.innerHTML =
    shown
      .map(
        (s) =>
          `<button type="button" class="item" data-state="${s}" data-on="${stateFilter === s ? "1" : "0"}">
             <i class="swatch" data-s="${s}"></i>${STATE_TEXT[s]}<span class="n">${counts[s]}</span>
           </button>`,
      )
      .join("") +
    `<span class="item plain">灰色 = 这个 commit 上文档里还没有这句话（不是没做完，也不是假）</span>` +
    `<span class="item plain">左侧红点 = 写下即假，从未真过</span>`;

  // 规则本身可能写错了的那些，单独在概览里点出来。
  // 混在图例里不够 —— 一条 ruleMiss 的说法没有假段，列表里根本不会出现。
  const miss = P.claims.filter((c) => c.ruleMiss);
  const suspect = P.claims.filter((c) => c.captureHint !== null);
  const banner = $("#rulewarn");
  if (!banner) return;
  if (miss.length === 0 && suspect.length === 0) {
    banner.innerHTML = "";
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.innerHTML = [
    miss.length > 0
      ? `<div><b>${miss.length} 条说法的 locator 在整段历史里一次都没匹配到。</b>灰色不代表「文档没写」，也可能是规则写错。先跑 <code>lookup</code> 看它们到底捕获到了什么：${miss
          .map((c) => `<code>${escapeHtml(c.id)}</code>`)
          .join("、")}</div>`
      : "",
    suspect.length > 0
      ? `<div><b>${suspect.length} 条说法判假，但捕获的文本多带了字符。</b>去掉首尾标点之后路径确实存在，多半是 locator 的捕获组写错了，不是文档写错：${suspect
          .map((c) => `<code>${escapeHtml(c.id)}</code>→<code>${escapeHtml(c.captureHint ?? "")}</code>`)
          .join("、")}</div>`
      : "",
  ].join("");
}

function wire(): void {
  mapEl.addEventListener("mouseover", (e) => {
    const t = e.target as HTMLElement;
    if (!t.classList.contains("cell")) return;
    moveBands(Number(t.dataset["r"]), Number(t.dataset["c"]));
    showReadout(Number(t.dataset["r"]), Number(t.dataset["c"]));
  });

  mapEl.addEventListener("mouseleave", () => {
    if (playTimer === null) moveBands(null, null);
  });

  mapEl.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (!t.classList.contains("cell")) return;
    stopPlay();
    const r = Number(t.dataset["r"]);
    const c = Number(t.dataset["c"]);
    setActive(r, c);
    openDrawer(r, c);
  });

  mapEl.addEventListener("focusin", (e) => {
    const t = e.target as HTMLElement;
    if (!t.classList.contains("cell")) return;
    activeR = Number(t.dataset["r"]);
    activeC = Number(t.dataset["c"]);
    moveBands(activeR, activeC);
    showReadout(activeR, activeC);
  });

  mapEl.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (!t.classList.contains("cell")) return;
    const d: Record<string, [number, number]> = {
      ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
      Home: [0, -activeC], End: [0, N_COLS - 1 - activeC],
    };
    const move = d[e.key];
    if (move) {
      e.preventDefault();
      // 上下按「屏幕上的相邻行」走，不是按数据的 r，排序后才不会乱跳
      if (move[0] !== 0) {
        const pos = order.indexOf(activeR);
        const nextPos = Math.max(0, Math.min(order.length - 1, pos + move[0]));
        setActive(order[nextPos] ?? activeR, activeC, true);
      } else {
        setActive(activeR, activeC + move[1], true);
      }
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDrawer(activeR, activeC);
    }
  });

  $<HTMLElement>("#close").addEventListener("click", closeDrawer);
  scrimEl.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });

  // 搜索
  searchEl.addEventListener("input", () => {
    query = searchEl.value;
    order = computeOrder();
    render();
  });

  // 预设视图
  viewsEl.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-view]");
    if (!t) return;
    view = (t.dataset["view"] ?? "all") as ViewId;
    renderViews();
    order = computeOrder();
    render();
    const first = order[0];
    if (first !== undefined) setActive(first, activeC);
  });

  // 图例可点：只看某一种状态
  $("#legend").addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-state]");
    if (!t) return;
    const s = Number(t.dataset["state"]);
    stateFilter = stateFilter === s ? null : s;
    renderLegend();
    applyStateFilter();
  });

  // 假段列表里点 commit：打开那一格的抽屉
  detailsEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".dt-commit");
    const art = btn?.closest<HTMLElement>(".claim");
    if (!btn || !art) return;
    const r = Number(art.dataset["r"]);
    const c = Number(btn.dataset["c"]);
    setActive(r, c);
    openDrawer(r, c);
  });

  // 结局条可点：跳到那一段
  $<HTMLElement>("#outcomes").addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-outcome]");
    if (!t) return;
    const want = t.dataset["outcome"] as Outcome;
    outer: for (const [r, claim] of P.claims.entries()) {
      for (const run of claim.runs) {
        if (run.outcome === want) {
          if (!order.includes(r)) {
            view = "all";
            query = "";
            searchEl.value = "";
            renderViews();
            order = computeOrder();
            render();
          }
          setActive(r, run.from);
          openDrawer(r, run.from);
          break outer;
        }
      }
    }
  });

  // 主题
  const themeBtn = $<HTMLButtonElement>("#theme");
  const order3 = ["auto", "light", "dark"] as const;
  type ThemeName = (typeof order3)[number];
  const label: Record<ThemeName, string> = { auto: "跟系统", light: "亮色", dark: "暗色" };
  const saved = localStorage.getItem("laminae-theme");
  const initial = (deep?.theme ?? saved) as ThemeName | null;
  if (initial && order3.includes(initial)) document.documentElement.dataset["theme"] = initial;
  const sync = (): void => {
    const cur = (document.documentElement.dataset["theme"] ?? "auto") as ThemeName;
    themeBtn.textContent = `主题：${label[cur]}`;
  };
  sync();
  themeBtn.addEventListener("click", () => {
    const cur = (document.documentElement.dataset["theme"] ?? "auto") as ThemeName;
    const next = order3[(order3.indexOf(cur) + 1) % order3.length]!;
    document.documentElement.dataset["theme"] = next;
    localStorage.setItem("laminae-theme", next);
    sync();
  });

  $<HTMLButtonElement>("#play").addEventListener("click", togglePlay);
  $<HTMLButtonElement>("#print").addEventListener("click", () => window.print());

  window.addEventListener("resize", () => {
    moveBands(activeR, activeC);
    if (playTimer !== null) setCurtain(playAt);
  });
}

/* ────────────── 启动 ────────────── */

const deep = readHash();

// 时间轴缩放要先于第一次渲染：横轴的刻度间隔取决于当前每格多宽
initGridZoom(mapEl, N_COLS, () => {
  moveBands(activeR, activeC);
  if (playTimer !== null) setCurtain(playAt);
});

renderViews();
renderLegend();
order = computeOrder();
render();
wire();

setActive(deep?.r ?? order[0] ?? 0, deep?.c ?? 0);
if (deep) openDrawer(deep.r, deep.c);

requestAnimationFrame(() => moveBands(activeR, activeC));

// 调用关系图、想法与线索：各自的容器由 render.ts 按数据有无决定是否输出
timeline.c = N_COLS - 1;
if (P.graph) initGraph(P);
initIdeas(P);
