/**
 * laminae —— 状态图的时间轴缩放（浏览器端）
 *
 * 提交很多时，每格固定 13px 会把图拉得很长，要拖很远的横向滚动条。现在：
 *   · 默认「适应宽度」：整段历史塞进一屏（最窄到每格 0.5px），一眼看到全貌
 *   · Alt + 滚轮（或 Ctrl + 滚轮、触控板捏合）以鼠标位置为中心缩放，Shift + 滚轮左右移
 *   · 工具条上也有 − / + / 适应宽度 / 原始大小
 * 只改 CSS 变量 --cw 与 --gap，不重建任何格子；缩放前后鼠标下面的那个 commit 保持不动。
 */
import { niceStep } from "./ruler.ts";

const DEFAULT_CW = 13;
const MIN_CW = 0.5;
const MAX_CW = 32;

export const gridView = {
  cw: DEFAULT_CW,
  gap: 2,
  /** 横轴每隔多少个 commit 标一个编号 */
  step: 10,
};

/** 横轴上要标编号的 commit：每 step 个一个；最后一格离上一个刻度够远才标，免得数字挤在一起 */
export function tickSet(n: number, step: number): Set<number> {
  const s = new Set<number>();
  if (n <= 0) return s;
  for (let c = 0; c < n; c += step) s.add(c);
  const last = n - 1;
  if (last - Math.floor(last / step) * step >= step / 2) s.add(last);
  return s;
}

/** 格子越窄，格间距越小，窄到 3.5px 以下就不留缝，否则全是缝 */
const gapFor = (cw: number): number => (cw >= 7 ? 2 : cw >= 3.5 ? 1 : 0);

export function initGridZoom(mapEl: HTMLElement, n: number, onChange: () => void): void {
  const wrap = mapEl.parentElement as HTMLElement;
  let manual = false; // 用户手动缩放过，窗口变化时就别再自动适应了

  const bar = document.createElement("div");
  bar.className = "zoombar";
  bar.innerHTML = `
    <span>时间轴</span>
    <button type="button" data-z="out" title="缩小（Alt + 滚轮向下）">−</button>
    <button type="button" data-z="in" title="放大（Alt + 滚轮向上）">+</button>
    <button type="button" data-z="fit" title="整段历史放进一屏">适应宽度</button>
    <button type="button" data-z="one" title="每格 ${DEFAULT_CW}px">原始大小</button>
    <span class="zw" id="zw"></span>
    <span>Alt + 滚轮缩放 · Shift + 滚轮左右移</span>`;
  wrap.before(bar);
  const zw = bar.querySelector<HTMLElement>("#zw")!;

  const labelW = (): number => parseFloat(getComputedStyle(mapEl).getPropertyValue("--label-w")) || 208;
  const padX = (): number => {
    const s = getComputedStyle(wrap);
    return (parseFloat(s.paddingLeft) || 0) + (parseFloat(s.paddingRight) || 0);
  };

  function fitCw(): number {
    const avail = (wrap.clientWidth || 1000) - padX() - labelW() - 4;
    for (const gap of [2, 1, 0]) {
      const cw = avail / n - gap;
      if (cw >= (gap === 2 ? 7 : gap === 1 ? 3.5 : 0)) return Math.min(DEFAULT_CW, cw);
    }
    return MIN_CW;
  }

  function apply(cw: number): void {
    gridView.cw = Math.max(MIN_CW, Math.min(MAX_CW, cw));
    gridView.gap = gapFor(gridView.cw);
    gridView.step = niceStep(70 / (gridView.cw + gridView.gap));
    mapEl.style.setProperty("--cw", `${gridView.cw.toFixed(2)}px`);
    mapEl.style.setProperty("--gap", `${gridView.gap}px`);
    mapEl.dataset["tiny"] = gridView.cw < 6 ? "1" : "0";
    zw.textContent = `每格 ${gridView.cw >= 10 ? Math.round(gridView.cw) : gridView.cw.toFixed(1)}px`;
    // 横轴编号随缩放重新取舍
    const ticks = tickSet(n, gridView.step);
    mapEl.querySelectorAll<HTMLElement>(".axis .tick").forEach((t, c) => {
      t.textContent = ticks.has(c) ? String(c) : "";
    });
  }

  /** 缩放，并让 anchorX（相对 wrap 左边）下面的那个 commit 保持不动 */
  function zoomTo(cw: number, anchorX: number): void {
    const before = gridView.cw + gridView.gap;
    const col = (wrap.scrollLeft + anchorX - padX() / 2 - labelW()) / before;
    apply(cw);
    const after = gridView.cw + gridView.gap;
    wrap.scrollLeft = col * after + labelW() + padX() / 2 - anchorX;
    onChange();
  }

  const mid = (): number => wrap.clientWidth / 2;

  bar.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-z]");
    if (!b) return;
    manual = true;
    const z = b.dataset["z"];
    if (z === "in") zoomTo(gridView.cw * 1.4, mid());
    else if (z === "out") zoomTo(gridView.cw / 1.4, mid());
    else if (z === "one") zoomTo(DEFAULT_CW, mid());
    else {
      manual = false;
      apply(fitCw());
      wrap.scrollLeft = 0;
      onChange();
    }
  });

  wrap.addEventListener(
    "wheel",
    (e) => {
      if (!(e.altKey || e.ctrlKey || e.metaKey)) return; // 普通滚轮照常滚页面
      e.preventDefault();
      manual = true;
      zoomTo(gridView.cw * Math.exp(-e.deltaY * 0.0015), e.clientX - wrap.getBoundingClientRect().left);
    },
    { passive: false },
  );

  window.addEventListener("resize", () => {
    if (manual) return;
    apply(fitCw());
    onChange();
  });

  apply(fitCw());
}
