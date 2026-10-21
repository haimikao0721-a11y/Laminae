/**
 * laminae —— 时间标尺（浏览器端）
 *
 * 取代原来的滑动条。commit 很多时滑动条一格只有零点几像素，根本拨不准。
 * 标尺的做法：
 *   · 底下画一条每个 commit 的数量曲线，一眼看出哪一段变化大
 *   · 点一下或拖动选时间点；对比模式下动离鼠标近的那一个（起点或当前）
 *   · Alt + 滚轮（或 Ctrl + 滚轮、触控板捏合）缩放时间轴，Shift + 滚轮左右移动
 *   · 聚焦后可用 ← → 逐个 commit 移动，Shift 十个一跳，Home / End 跳到两端
 *
 * 只读写共享的 timeline，不知道图长什么样。
 */
import { timeline } from "./shared.ts";

export interface RulerOpts {
  N: number;
  /** 每个 commit 一个数，画成底下的曲线；可以以后再换 */
  series: number[];
  seriesLabel: string;
  text(c: number): string;
  /** 用户亲手动了标尺（用来停掉播放） */
  onUser?: () => void;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const H = 58;
const AXIS_H = 14;
const MIN_WINDOW = 8;

const mk = (tag: string, attrs: Record<string, string>): SVGElement => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

/** 刻度间隔取 1、2、5 × 10^n，保证相邻刻度至少隔 minGap 个 commit */
export function niceStep(minGap: number): number {
  if (minGap <= 1) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(minGap)));
  for (const m of [1, 2, 5, 10]) if (m * p >= minGap) return m * p;
  return 10 * p;
}

export interface Ruler {
  setSeries(series: number[], label?: string): void;
  redraw(): void;
}

export function createRuler(host: HTMLElement, o: RulerOpts): Ruler {
  const { N } = o;
  let series = o.series;
  let seriesLabel = o.seriesLabel;
  let lo = 0;
  let size = N; // 窗口：从 lo 起的 size 个 commit

  host.classList.add("ruler");
  host.innerHTML = `
    <div class="rl-reads" id="rl-reads"></div>
    <div class="rl-bar">
      <button type="button" data-a="first" title="跳到最早（Home）">⏮</button>
      <button type="button" data-a="prev" title="前一个 commit（←）">◀</button>
      <button type="button" data-a="next" title="后一个 commit（→）">▶</button>
      <button type="button" data-a="last" title="跳到最新（End）">⏭</button>
      <span class="rl-sp"></span>
      <span class="rl-win" id="rl-win"></span>
      <button type="button" data-a="out" title="缩小时间轴（Alt + 滚轮向下）">−</button>
      <button type="button" data-a="in" title="放大时间轴（Alt + 滚轮向上）">+</button>
      <button type="button" data-a="all" title="显示全部历史">全部</button>
    </div>
    <div class="rl-track" id="rl-track" tabindex="0" role="slider" aria-label="时间点" aria-valuemin="0" aria-valuemax="${N - 1}"></div>
    <div class="rl-hint">点击或拖动选时间点（对比模式下动离鼠标近的那个）· Alt + 滚轮缩放时间轴 · Shift + 滚轮左右移 · 聚焦后 ← → 逐个 commit，Shift 十个一跳</div>`;

  const reads = host.querySelector<HTMLElement>("#rl-reads")!;
  const track = host.querySelector<HTMLElement>("#rl-track")!;
  const winEl = host.querySelector<HTMLElement>("#rl-win")!;

  const width = (): number => track.clientWidth || host.clientWidth || 720;
  const clampWin = (): void => {
    size = Math.max(Math.min(MIN_WINDOW, N), Math.min(N, size));
    lo = Math.max(0, Math.min(N - size, lo));
  };
  const xOf = (c: number): number => ((c - lo + 0.5) / size) * width();
  const cAt = (px: number): number => Math.max(0, Math.min(N - 1, Math.round(lo + (px / width()) * size - 0.5)));

  function ensureVisible(c: number): void {
    if (c < lo) lo = c - Math.round(size * 0.1);
    else if (c > lo + size - 1) lo = c - Math.round(size * 0.9);
    clampWin();
  }

  function draw(): void {
    const W = width();
    track.replaceChildren();
    const svg = mk("svg", { width: String(W), height: String(H), viewBox: `0 0 ${W} ${H}`, class: "rl-svg" });
    track.appendChild(svg);

    const plotH = H - AXIS_H;
    const first = Math.max(0, Math.floor(lo));
    const last = Math.min(N - 1, Math.ceil(lo + size - 1));
    const max = Math.max(1, ...series);

    // 曲线：窗口里 commit 比像素多时按像素分桶取最大值，别画出几万个点
    const count = last - first + 1;
    const stride = Math.max(1, Math.floor(count / Math.max(1, W)));
    const pts: string[] = [];
    for (let c = first; c <= last; c += stride) {
      let v = 0;
      for (let k = c; k < Math.min(c + stride, last + 1); k++) v = Math.max(v, series[k] ?? 0);
      pts.push(`${xOf(c + (stride - 1) / 2).toFixed(1)},${(plotH - 2 - (v / max) * (plotH - 8)).toFixed(1)}`);
    }
    if (pts.length > 0) {
      const x0 = xOf(first).toFixed(1);
      const x1 = xOf(last).toFixed(1);
      svg.appendChild(mk("polygon", { class: "rl-area", points: `${x0},${plotH} ${pts.join(" ")} ${x1},${plotH}` }));
      svg.appendChild(mk("polyline", { class: "rl-line", points: pts.join(" ") }));
    }

    // 对比区间
    if (timeline.from !== null) {
      const a = xOf(Math.min(timeline.from, timeline.c));
      const b = xOf(Math.max(timeline.from, timeline.c));
      svg.appendChild(mk("rect", { class: "rl-span", x: a.toFixed(1), y: "0", width: Math.max(1, b - a).toFixed(1), height: String(plotH) }));
    }

    // 刻度
    const step = niceStep((64 * size) / W);
    svg.appendChild(mk("line", { class: "rl-base", x1: "0", x2: String(W), y1: String(plotH), y2: String(plotH) }));
    for (let c = Math.ceil(first / step) * step; c <= last; c += step) {
      const x = xOf(c);
      svg.appendChild(mk("line", { class: "rl-tick", x1: x.toFixed(1), x2: x.toFixed(1), y1: String(plotH), y2: String(plotH + 4) }));
      const t = mk("text", { class: "rl-tt", x: x.toFixed(1), y: String(H - 2) });
      t.textContent = `c${c}`;
      svg.appendChild(t);
    }

    const cursor = (c: number, cls: string): void => {
      const x = xOf(c);
      if (x < -4 || x > W + 4) return;
      svg.appendChild(mk("line", { class: `rl-cur ${cls}`, x1: x.toFixed(1), x2: x.toFixed(1), y1: "0", y2: String(plotH) }));
      svg.appendChild(mk("circle", { class: `rl-knob ${cls}`, cx: x.toFixed(1), cy: "5", r: "5" }));
    };
    if (timeline.from !== null) cursor(timeline.from, "from");
    cursor(timeline.c, "now");

    winEl.textContent =
      size >= N ? `全部 ${N} 个 commit` : `c${first}–c${last}（${Math.round(size)} 个）· ${seriesLabel}`;
    track.setAttribute("aria-valuenow", String(timeline.c));
    track.setAttribute("aria-valuetext", o.text(timeline.c));

    reads.innerHTML =
      (timeline.from !== null ? `<div><b class="rl-k from">起点</b><span>${esc(o.text(timeline.from))}</span></div>` : "") +
      `<div><b class="rl-k now">${timeline.from !== null ? "当前" : "时间"}</b><span>${esc(o.text(timeline.c))}</span></div>`;
  }

  const esc = (s: string): string => s.replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]!);

  /* ── 交互 ── */

  function zoomAround(anchorC: number, frac: number, factor: number): void {
    const next = Math.max(Math.min(MIN_WINDOW, N), Math.min(N, size * factor));
    lo = anchorC - frac * next + 0.5;
    size = next;
    clampWin();
    draw();
  }

  const user = (): void => o.onUser?.();

  track.addEventListener(
    "wheel",
    (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = track.getBoundingClientRect();
        const frac = (e.clientX - r.left) / Math.max(1, r.width);
        zoomAround(lo + frac * size - 0.5, frac, Math.exp(e.deltaY * 0.002));
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const d = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
        lo += (d / width()) * size;
        clampWin();
        draw();
      }
    },
    { passive: false },
  );

  let dragging: "now" | "from" | null = null;
  const pick = (px: number): "now" | "from" => {
    if (timeline.from === null) return "now";
    return Math.abs(xOf(timeline.from) - px) < Math.abs(xOf(timeline.c) - px) ? "from" : "now";
  };
  const apply = (which: "now" | "from", px: number): void => {
    const c = cAt(px);
    if (which === "now") timeline.set(c);
    else timeline.set(timeline.c, c);
  };

  track.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    user();
    track.focus();
    const px = e.clientX - track.getBoundingClientRect().left;
    dragging = pick(px);
    track.setPointerCapture(e.pointerId);
    apply(dragging, px);
  });
  track.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    apply(dragging, e.clientX - track.getBoundingClientRect().left);
  });
  const end = (): void => {
    dragging = null;
  };
  track.addEventListener("pointerup", end);
  track.addEventListener("pointercancel", end);

  track.addEventListener("keydown", (e) => {
    const big = e.shiftKey ? 10 : 1;
    const to = (c: number): void => {
      e.preventDefault();
      user();
      timeline.set(Math.max(0, Math.min(N - 1, c)));
    };
    if (e.key === "ArrowLeft") to(timeline.c - big);
    else if (e.key === "ArrowRight") to(timeline.c + big);
    else if (e.key === "PageUp") to(timeline.c - Math.max(1, Math.round(size / 10)));
    else if (e.key === "PageDown") to(timeline.c + Math.max(1, Math.round(size / 10)));
    else if (e.key === "Home") to(0);
    else if (e.key === "End") to(N - 1);
  });

  host.querySelector(".rl-bar")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-a]");
    if (!b) return;
    user();
    const a = b.dataset["a"];
    const mid = timeline.c >= lo && timeline.c <= lo + size - 1 ? timeline.c : lo + size / 2;
    const frac = Math.max(0, Math.min(1, (mid - lo + 0.5) / size));
    if (a === "first") timeline.set(0);
    else if (a === "last") timeline.set(N - 1);
    else if (a === "prev") timeline.set(Math.max(0, timeline.c - 1));
    else if (a === "next") timeline.set(Math.min(N - 1, timeline.c + 1));
    else if (a === "in") zoomAround(mid, frac, 0.5);
    else if (a === "out") zoomAround(mid, frac, 2);
    else if (a === "all") {
      lo = 0;
      size = N;
      draw();
    }
  });

  timeline.onChange(() => {
    ensureVisible(timeline.c);
    if (timeline.from !== null) ensureVisible(timeline.from);
    draw();
  });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => draw()).observe(track);

  draw();

  return {
    setSeries(s, label): void {
      series = s;
      if (label) seriesLabel = label;
      draw();
    },
    redraw: draw,
  };
}
