/**
 * laminae —— 模块引用关系图（浏览器端）
 *
 * 为什么不把所有引用线都画出来：几十个模块、上百条线画在一起只会是一团毛线，谁连谁根本看不出来。
 * 所以默认只画「你正在看的那个模块」的线：
 *   蓝色 = 它引用了谁，橙色 = 谁引用了它；鼠标移开线就消失，点一下可以钉住。
 * 想看全貌，勾「画出所有引用线」。对比模式下，新增和删除的引用线始终会画出来。
 *
 * 两种摆法：
 *   按目录  同一目录的模块放进同一张卡片（默认，一眼看出代码是怎么分区的）
 *   按依赖  引用别人的放左边、被引用的放右边，分层排列
 *
 * 时间由页面上的时间标尺控制（web/ruler.ts）：可以缩放、拖动，提交很多也拨得准。
 * 图本身可以 Alt + 滚轮缩放，按住空白处拖动平移。
 * 节点位置只在布局切换时重算；换时间点只改颜色，图不会跳。
 */
import { aliveAt, groupOf } from "../src/graph-util.ts";
import type { GraphData, Payload } from "../src/types.ts";
import { layoutCards, layoutGraph, shortLabels } from "./layout.ts";
import { createRuler, type Ruler } from "./ruler.ts";
import { commitText, escapeHtml, normPath, timeline } from "./shared.ts";
import type { GraphApi } from "./shared.ts";

const NODE_W = 212;
const NODE_H = 24;
const COL_GAP = 64;
const ROW_GAP = 8;
const PAD = 16;
const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.5;
const MAX_DRAWN = 1500;

type St = "on" | "off" | "added" | "removed" | "kept";
type Layout = "dir" | "layer";

const mk = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

const STATE_WORD = ["真", "假", "尚未写入文档", "测不出来"] as const;

/** 中间省略时结尾保留几个字符：要看得出扩展名，不然 x.story.js 和 x.story.tsx 会缩成同一个样子 */
const TAIL = 9;

/** 标签放不下时截断：目录布局保留开头和结尾（含扩展名），分层布局的标签带路径，只保留结尾 */
const fit = (label: string, max: number, keepTail: boolean): string =>
  label.length <= max ? label : keepTail ? "…" + label.slice(-(max - 1)) : label.slice(0, max - 1 - TAIL) + "…" + label.slice(-TAIL);

export function initGraph(P: Payload): void {
  const g: GraphData = P.graph!;
  const N = P.commits.length;
  const root = document.querySelector<HTMLElement>("#graph-body");
  if (!root) return;

  /** 边按端点归类，详情里要列「它引用了谁、被谁引用」 */
  const outE: number[][] = g.nodes.map(() => []);
  const inE: number[][] = g.nodes.map(() => []);
  g.edges.forEach((e, j) => {
    outE[e.s]!.push(j);
    inE[e.t]!.push(j);
  });

  let showTests = false;
  let showAll = false;
  let layout: Layout = "dir";
  let zoom = 1;
  let playing: number | null = null;
  let hoverK: number | null = null;
  let selK: number | null = null;

  /** 从想法里点「在图上看」的引用边界：把符合规则的那几条引用线标红（边界）或标绿（想法） */
  interface Rule {
    text: string;
    from: string;
    to: string;
    expect: "present" | "absent";
  }
  let rule: Rule | null = null;
  /** 每条边是否符合规则；每个节点在规则里是哪一端 */
  let ruleEdge: boolean[] = [];
  let ruleSide: ("from" | "to" | "")[] = [];

  // 当前可见的节点（图里的下标 → 全局下标）以及布局出来的元素
  let visible: number[] = [];
  let nodeEls: SVGGElement[] = [];
  let px: number[] = [];
  let py: number[] = [];
  let ledges: { s: number; t: number; j: number }[] = [];
  let vbW = 0;
  let vbH = 0;
  let edgeLayer: SVGGElement | null = null;
  /** 当前时间点上每个节点引用了几个、被几个引用 */
  let outDeg: number[] = [];
  let inDeg: number[] = [];

  const hasTests = g.nodes.some((n) => n.test);
  const word = g.level === "dir" ? "目录" : "模块";

  root.innerHTML = `
    <div class="gtools">
      <div class="views" id="g-mode" role="group" aria-label="看法">
        <button type="button" data-mode="at" data-on="1">某一刻</button>
        <button type="button" data-mode="diff" data-on="0" title="选一个起点，和当前时间点比较">对比两个时间点</button>
      </div>
      <div class="views" id="g-layout" role="group" aria-label="摆法">
        <button type="button" data-layout="dir" data-on="1" title="同一目录的放进一张卡片">按目录</button>
        <button type="button" data-layout="layer" data-on="0" title="引用别人的在左，被引用的在右">按依赖</button>
      </div>
      <button type="button" id="g-play" class="play" title="按 commit 一格一格推进">播放</button>
      ${hasTests ? `<label class="chk"><input type="checkbox" id="g-tests"> 显示测试文件</label>` : ""}
      <label class="chk" title="默认只画鼠标指着的那个模块的线，全画出来会很乱"><input type="checkbox" id="g-all"> 画出所有引用线</label>
      <span class="gcount" id="g-count"></span>
    </div>
    <div class="gruler" id="g-ruler"></div>
    <div class="grule" id="g-rule" hidden></div>
    <div class="gview">
      <div class="gzoom" role="group" aria-label="缩放">
        <button type="button" data-z="in" title="放大（Alt + 滚轮向上）">+</button>
        <button type="button" data-z="out" title="缩小（Alt + 滚轮向下）">−</button>
        <button type="button" data-z="fit" title="按当前宽度重新排布">适应</button>
      </div>
      <div class="gscroll" id="g-scroll"><svg id="g-svg" role="img" aria-label="模块之间的引用关系"></svg></div>
    </div>
    <div class="glegend" id="g-legend"></div>
    <div class="gdiff" id="g-diff"></div>
    <div class="gdetail" id="g-detail"></div>`;

  const svg = root.querySelector<SVGSVGElement>("#g-svg")!;
  const scroller = root.querySelector<HTMLElement>("#g-scroll")!;
  const countEl = root.querySelector<HTMLElement>("#g-count")!;
  const detailEl = root.querySelector<HTMLElement>("#g-detail")!;
  const diffEl = root.querySelector<HTMLElement>("#g-diff")!;
  const legendEl = root.querySelector<HTMLElement>("#g-legend")!;
  const ruleEl = root.querySelector<HTMLElement>("#g-rule")!;
  const playBtn = root.querySelector<HTMLButtonElement>("#g-play")!;

  const stop = (): void => {
    if (playing !== null) clearInterval(playing);
    playing = null;
    playBtn.textContent = "播放";
  };

  const ruler: Ruler = createRuler(root.querySelector<HTMLElement>("#g-ruler")!, {
    N,
    series: new Array<number>(N).fill(0),
    seriesLabel: `曲线 = 每个 commit 上的${word}数`,
    text: (c) => commitText(P.commits, c),
    onUser: stop,
  });

  /* ── 缩放：改 svg 的显示尺寸，viewBox 不动 ── */

  function applyZoom(): void {
    svg.setAttribute("width", String(Math.round(vbW * zoom)));
    svg.setAttribute("height", String(Math.round(vbH * zoom)));
  }

  /** 以容器里 (mx, my) 这个点为中心缩放，缩放前后这一点下面的内容不动 */
  function zoomAt(factor: number, mx: number, my: number): void {
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
    if (z === zoom) return;
    const wx = (scroller.scrollLeft + mx) / zoom;
    const wy = (scroller.scrollTop + my) / zoom;
    zoom = z;
    applyZoom();
    scroller.scrollLeft = wx * zoom - mx;
    scroller.scrollTop = wy * zoom - my;
  }

  const center = (): [number, number] => [scroller.clientWidth / 2, scroller.clientHeight / 2];

  scroller.addEventListener(
    "wheel",
    (e) => {
      // 只有按着 Alt / Ctrl（触控板捏合也算 Ctrl）才缩放，普通滚轮照常滚动页面
      if (!(e.altKey || e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const r = scroller.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false },
  );

  // 按住空白处拖动平移
  let drag: { x: number; y: number; sl: number; st: number; moved: boolean } | null = null;
  let justDragged = false;
  scroller.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || (e.target as Element).closest(".gn")) return;
    drag = { x: e.clientX, y: e.clientY, sl: scroller.scrollLeft, st: scroller.scrollTop, moved: false };
  });
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    drag.moved = true;
    scroller.dataset["panning"] = "1";
    scroller.scrollLeft = drag.sl - dx;
    scroller.scrollTop = drag.st - dy;
  });
  window.addEventListener("pointerup", () => {
    if (drag?.moved) {
      justDragged = true;
      setTimeout(() => (justDragged = false), 0);
    }
    drag = null;
    delete scroller.dataset["panning"];
  });

  /* ── 布局与绘制：只在「显示测试文件」或「摆法」切换时重做 ── */

  function rebuild(): void {
    visible = g.nodes.map((_, i) => i).filter((i) => showTests || !g.nodes[i]!.test);
    if (visible.length === 0) visible = g.nodes.map((_, i) => i); // 全是测试文件时别画一张空图
    const local = new Map(visible.map((gi, k) => [gi, k]));
    ledges = g.edges
      .map((e, j) => ({ s: local.get(e.s), t: local.get(e.t), j }))
      .filter((e): e is { s: number; t: number; j: number } => e.s !== undefined && e.t !== undefined);

    const ids = visible.map((gi) => g.nodes[gi]!.id);
    let labels: string[];
    let cards: { title: string; x: number; y: number; w: number; h: number }[] = [];

    if (layout === "dir") {
      const lay = layoutCards(ids, scroller.clientWidth || 980, NODE_W, NODE_H);
      px = lay.x;
      py = lay.y;
      cards = lay.cards;
      vbW = lay.width;
      vbH = lay.height;
      labels = ids.map((id) => id.slice(id.lastIndexOf("/") + 1) + (g.level === "dir" ? "/" : ""));
      zoom = 1;
    } else {
      const lay = layoutGraph(ids, ledges);
      px = ids.map((_, k) => PAD + lay.layer[k]! * (NODE_W + COL_GAP));
      py = ids.map((_, k) => PAD + lay.row[k]! * (NODE_H + ROW_GAP));
      vbW = lay.layers * (NODE_W + COL_GAP) - COL_GAP + PAD * 2 + 40; // 右边多留一截给绕线
      vbH = lay.rows * (NODE_H + ROW_GAP) - ROW_GAP + PAD * 2;
      labels = shortLabels(ids);
      // 太宽就缩到刚好放下，但最多缩到 0.6，再小字就看不清了，横向滚动或 Alt + 滚轮自己调
      const avail = scroller.clientWidth || vbW;
      zoom = Math.max(0.6, Math.min(1, avail / vbW));
    }

    svg.setAttribute("viewBox", `0 0 ${vbW} ${vbH}`);
    applyZoom();
    svg.replaceChildren();

    const defs = mk("defs");
    for (const kind of ["out", "in", "all", "added", "removed", "rule", "ruleok"]) {
      const marker = mk("marker", { id: `g-arr-${kind}`, viewBox: "0 0 8 8", refX: "7", refY: "4", markerWidth: "6", markerHeight: "6", orient: "auto" });
      marker.appendChild(mk("path", { d: "M0,0 L8,4 L0,8 z", class: `g-arrow ${kind}` }));
      defs.appendChild(marker);
    }
    svg.appendChild(defs);

    for (const card of cards) {
      const grp = mk("g", { class: "g-card" });
      grp.appendChild(mk("rect", { x: String(card.x), y: String(card.y), width: String(card.w), height: String(card.h), rx: "8" }));
      const t = mk("text", { x: String(card.x + 12), y: String(card.y + 17) });
      t.textContent = fit(card.title, 28, true);
      const tt = mk("title");
      tt.textContent = card.title;
      grp.append(t, tt);
      svg.appendChild(grp);
    }

    // 引用线放在节点下面、卡片上面，每次刷新时重画
    edgeLayer = mk("g", { class: "g-edges" });
    svg.appendChild(edgeLayer);

    nodeEls = visible.map((gi, k) => {
      const node = g.nodes[gi]!;
      const grp = mk("g", { class: "gn", transform: `translate(${px[k]},${py[k]})`, "data-k": String(k), tabindex: "-1" });
      grp.appendChild(mk("rect", { width: String(NODE_W), height: String(NODE_H), rx: "5" }));
      const text = mk("text", { x: "9", y: String(NODE_H / 2 + 4), class: "gl" });
      text.textContent = fit(labels[k]!, 21, layout === "layer");
      grp.appendChild(text);
      grp.appendChild(mk("text", { x: String(NODE_W - 34), y: String(NODE_H / 2 + 4), class: "gb out", "text-anchor": "end" }));
      grp.appendChild(mk("text", { x: String(NODE_W - 8), y: String(NODE_H / 2 + 4), class: "gb in", "text-anchor": "end" }));
      const title = mk("title");
      title.textContent = node.id + (g.level === "dir" ? "（目录合并节点）" : "");
      grp.appendChild(title);
      svg.appendChild(grp);
      return grp;
    });

    if (selK !== null && selK >= visible.length) selK = null;
    hoverK = null;

    // 标尺底下的曲线：每个 commit 上有多少个模块（只数当前可见的）
    const series = new Array<number>(N + 1).fill(0);
    for (const gi of visible) for (const [a, b] of g.nodes[gi]!.alive) {
      series[a]!++;
      series[b + 1]!--;
    }
    let run = 0;
    ruler.setSeries(series.slice(0, N).map((d) => (run += d)));

    refresh();
  }

  /* ── 随时间点刷新：改状态、徽标、引用线 ── */

  const stOf = (aliveNow: boolean, aliveFrom: boolean | null): St => {
    if (aliveFrom === null) return aliveNow ? "on" : "off";
    if (aliveNow && aliveFrom) return "kept";
    if (aliveNow) return "added";
    if (aliveFrom) return "removed";
    return "off";
  };

  /** 两个时间点上各条引用的存在情况，按图里的边下标索引 */
  let edgeSt: St[] = [];

  function refresh(): void {
    const c = timeline.c;
    const from = timeline.from;

    visible.forEach((gi, k) => {
      const n = g.nodes[gi]!;
      nodeEls[k]!.dataset["st"] = stOf(aliveAt(n.alive, c), from === null ? null : aliveAt(n.alive, from));
    });

    edgeSt = g.edges.map((e) => stOf(aliveAt(e.alive, c), from === null ? null : aliveAt(e.alive, from)));
    outDeg = g.nodes.map(() => 0);
    inDeg = g.nodes.map(() => 0);
    for (const e of g.edges) {
      if (aliveAt(e.alive, c)) {
        outDeg[e.s]!++;
        inDeg[e.t]!++;
      }
    }
    visible.forEach((gi, k) => {
      const [o, i] = nodeEls[k]!.querySelectorAll<SVGTextElement>(".gb");
      o!.textContent = outDeg[gi]! > 0 ? `→${outDeg[gi]}` : "";
      i!.textContent = inDeg[gi]! > 0 ? `←${inDeg[gi]}` : "";
    });

    drawFocus();

    const nodesNow = g.nodes.filter((n) => aliveAt(n.alive, c)).length;
    const edgesNow = g.edges.filter((e) => aliveAt(e.alive, c)).length;
    countEl.textContent = `c${c} 上：${nodesNow} 个${word}，${edgesNow} 条引用`;

    renderLegend();
    renderRule();
    renderDiff();
    renderDetail();
  }

  /* ── 引用边界的标出 ── */

  const under = (id: string, dir: string): boolean => id === dir || id.startsWith(dir + "/");

  function setRule(next: Rule | null): void {
    rule = next;
    ruleSide = g.nodes.map((n) => (!next ? "" : under(n.id, next.from) ? "from" : under(n.id, next.to) ? "to" : ""));
    ruleEdge = g.edges.map((e) => (next ? ruleSide[e.s] === "from" && ruleSide[e.t] === "to" : false));
  }

  /** 横幅：标出了什么、这个时间点上命中几条，以及一键取消 */
  function renderRule(): void {
    if (!rule) {
      ruleEl.hidden = true;
      ruleEl.innerHTML = "";
      return;
    }
    const c = timeline.c;
    const n = g.edges.filter((e, j) => ruleEdge[j] && aliveAt(e.alive, c)).length;
    const bad = rule.expect === "absent";
    const verdict = bad
      ? n === 0 ? `<b class="ok">c${c} 上守住：没有这样的引用</b>` : `<b class="bad">c${c} 上越界：${n} 条引用</b>`
      : n === 0 ? `<b class="none">c${c} 上没有这样的引用</b>` : `<b class="ok">c${c} 上有 ${n} 条引用</b>`;
    const coarse = !ruleSide.includes("from") || !ruleSide.includes("to")
      ? `<span class="none">图上找不到这两端（图按目录前 ${g.depth ?? 1} 级合并，规则比它更细，或对应的文件被折掉了），标不出线；上面的判定以逐 commit 的扫描为准。</span>`
      : "";
    ruleEl.hidden = false;
    ruleEl.innerHTML = `<span class="rtag">${bad ? "边界" : "想法"}</span><span class="rtext">${escapeHtml(rule.text)}</span>
      <code>${escapeHtml(rule.from)}</code> → <code>${escapeHtml(rule.to)}</code> ${verdict} ${coarse}
      <button type="button" class="linkbtn" data-clear-rule="1">取消标出</button>`;
  }
  ruleEl.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest("[data-clear-rule]")) return;
    setRule(null);
    renderLegend();
    renderRule();
    drawFocus();
  });

  /** 引用线与节点高亮：只跟「当前看的那个节点」和时间点有关，悬停时只需要重画这一块 */
  function drawFocus(): void {
    if (!edgeLayer) return;
    edgeLayer.replaceChildren();
    const k = hoverK ?? selK;
    const gi = k === null ? -1 : visible[k]!;
    const diffMode = timeline.from !== null;
    const outSet = new Set<number>();
    const inSet = new Set<number>();
    let drawn = 0;

    const anchors = (s: number, t: number): string => {
      const sx = px[s]!;
      const sy = py[s]! + NODE_H / 2;
      const tx = px[t]!;
      const ty = py[t]! + NODE_H / 2;
      if (tx >= sx + NODE_W + 10) {
        const x1 = sx + NODE_W;
        const dx = Math.max(36, (tx - x1) / 2);
        return `M${x1},${sy} C${x1 + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`;
      }
      if (tx + NODE_W + 10 <= sx) {
        const x2 = tx + NODE_W;
        const dx = Math.max(36, (sx - x2) / 2);
        return `M${sx},${sy} C${sx - dx},${sy} ${x2 + dx},${ty} ${x2},${ty}`;
      }
      // 同一列：从右侧绕出去再绕回来，避免线从一排节点中间穿过
      const x1 = sx + NODE_W;
      const x2 = tx + NODE_W;
      const bulge = 22 + Math.min(26, Math.abs(ty - sy) / 12); // 贝塞尔曲线实际鼓出去约 3/4，最多 36px，在卡片间的通道和右边距里放得下
      return `M${x1},${sy} C${x1 + bulge},${sy} ${x2 + bulge},${ty} ${x2},${ty}`;
    };

    for (const e of ledges) {
      if (drawn >= MAX_DRAWN) break;
      const st = edgeSt[e.j]!;
      if (st === "off") continue;
      const edge = g.edges[e.j]!;
      const touch = k !== null && (edge.s === gi || edge.t === gi);
      let role: "out" | "in" | "all" | "added" | "removed" | "rule" | "ruleok" | null = null;
      if (touch) {
        role = st === "added" ? "added" : st === "removed" ? "removed" : edge.s === gi ? "out" : "in";
        if (edge.s === gi) outSet.add(edge.t);
        if (edge.t === gi) inSet.add(edge.s);
      } else if (k === null && diffMode && (st === "added" || st === "removed")) {
        role = st; // 对比模式：变化的引用始终画出来
      } else if (k === null && showAll) {
        role = st === "added" ? "added" : st === "removed" ? "removed" : "all";
      }
      if (ruleEdge[e.j]) role = rule?.expect === "absent" ? "rule" : "ruleok"; // 规则命中的线盖过其它颜色
      if (role === null) continue;
      const d = anchors(e.s, e.t);
      edgeLayer.appendChild(mk("path", { class: `ge ${role}`, d, "marker-end": `url(#g-arr-${role})` }));
      drawn++;
    }

    svg.dataset["focus"] = k === null ? "0" : "1";
    visible.forEach((v, kk) => {
      nodeEls[kk]!.dataset["rule"] = ruleSide[v] ?? "";
      const isOut = outSet.has(v);
      const isIn = inSet.has(v);
      nodeEls[kk]!.dataset["hl"] =
        k === null ? "" : kk === k ? "self" : isOut && isIn ? "both" : isOut ? "out" : isIn ? "in" : "dim";
    });
  }

  function renderLegend(): void {
    const mode =
      timeline.from === null
        ? `<span><i class="sw on"></i>当前存在</span><span><i class="sw off"></i>当前不存在（淡出）</span>`
        : `<span><i class="sw added"></i>新增</span><span><i class="sw removed"></i>删除</span><span><i class="sw kept"></i>两个时间点都在</span>`;
    legendEl.innerHTML =
      mode +
      `<span><i class="ln out"></i>它引用了</span><span><i class="ln in"></i>引用了它</span>` +
      (rule ? `<span><i class="ln ${rule.expect === "absent" ? "rule" : "ruleok"}"></i>${rule.expect === "absent" ? "越界的引用" : "符合想法的引用"}</span>` : "") +
      `<span class="plain">右侧小数字：<b class="o">→</b>引用了几个，<b class="i">←</b>被几个引用${
        g.level === "dir" ? `；文件太多（历史上共 ${g.fileCount} 个），已按目录前 ${g.depth} 级合并` : ""
      }</span>`;
  }

  /* ── 对比的文字结论：直接列出来，不用点 ── */

  function renderDiff(): void {
    const from = timeline.from;
    if (from === null) {
      diffEl.innerHTML = "";
      return;
    }
    const c = timeline.c;
    const addedN: number[] = [];
    const removedN: number[] = [];
    g.nodes.forEach((n, i) => {
      const a = aliveAt(n.alive, from);
      const b = aliveAt(n.alive, c);
      if (!a && b) addedN.push(i);
      if (a && !b) removedN.push(i);
    });
    const addedE: number[] = [];
    const removedE: number[] = [];
    g.edges.forEach((e, j) => {
      const a = aliveAt(e.alive, from);
      const b = aliveAt(e.alive, c);
      if (!a && b) addedE.push(j);
      if (a && !b) removedE.push(j);
    });

    const CAP = 24;
    const nodeList = (xs: number[]): string =>
      xs.length === 0
        ? `<span class="none">无</span>`
        : xs.slice(0, CAP).map((i) => `<code>${escapeHtml(g.nodes[i]!.id)}</code>`).join(" ") +
          (xs.length > CAP ? ` <span class="none">另有 ${xs.length - CAP} 个</span>` : "");
    const edgeList = (xs: number[]): string =>
      xs.length === 0
        ? `<span class="none">无</span>`
        : xs
            .slice(0, CAP)
            .map((j) => `<code>${escapeHtml(g.nodes[g.edges[j]!.s]!.id)} → ${escapeHtml(g.nodes[g.edges[j]!.t]!.id)}</code>`)
            .join(" ") + (xs.length > CAP ? ` <span class="none">另有 ${xs.length - CAP} 条</span>` : "");

    const lo = Math.min(from, c);
    const hi = Math.max(from, c);
    diffEl.innerHTML = `
      <p class="gsum">从 c${from} 到 c${c}${from > c ? "（倒着看，新增与删除互换）" : ""}：${word} <b class="add">+${addedN.length}</b> <b class="del">−${removedN.length}</b>，
        引用 <b class="add">+${addedE.length}</b> <b class="del">−${removedE.length}</b>，隔了 ${hi - lo} 个 commit。</p>
      <dl class="gdl">
        <dt>新增的${word}</dt><dd>${nodeList(addedN)}</dd>
        <dt>删除的${word}</dt><dd>${nodeList(removedN)}</dd>
        <dt>新增的引用</dt><dd>${edgeList(addedE)}</dd>
        <dt>删除的引用</dt><dd>${edgeList(removedE)}</dd>
      </dl>`;
  }

  /* ── 节点详情 ── */

  const contains = (nodeId: string, file: string): boolean =>
    g.level === "file" ? nodeId === file : groupOf(file, g.depth ?? 1) === nodeId || file.startsWith(nodeId + "/");

  const targetHits = (nodeId: string, target: string): boolean => {
    const t = normPath(target);
    if (!t) return false;
    return nodeId === t || nodeId.startsWith(t + "/") || (g.level === "dir" && (groupOf(t, g.depth ?? 1) === nodeId || t.startsWith(nodeId + "/")));
  };

  const runsText = (alive: readonly (readonly [number, number])[]): string =>
    alive.length === 0
      ? "从未存在"
      : alive.map(([a, b]) => (b === N - 1 ? `c${a} 起至今` : a === b ? `c${a}` : `c${a} → c${b}`)).join("，");

  function renderDetail(): void {
    const k = hoverK ?? selK;
    if (k === null) {
      detailEl.innerHTML = `<p class="hintline">把鼠标移到某个${word}上：只画它的引用线，并在这里列出它引用了谁、被谁引用，以及相关的说法与想法。点一下可以钉住。</p>`;
      return;
    }
    const gi = visible[k]!;
    const n = g.nodes[gi]!;
    const c = timeline.c;
    const chips = (xs: string[]): string =>
      xs.length === 0 ? `<span class="none">无</span>` : xs.map((s) => `<code>${escapeHtml(s)}</code>`).join(" ");

    const outs = outE[gi]!.filter((j) => aliveAt(g.edges[j]!.alive, c)).map((j) => g.nodes[g.edges[j]!.t]!.id);
    const ins = inE[gi]!.filter((j) => aliveAt(g.edges[j]!.alive, c)).map((j) => g.nodes[g.edges[j]!.s]!.id);

    const claims = P.claims.filter((cl) => cl.evidence.some((f) => contains(n.id, f)));
    const claimsHtml =
      claims.length === 0
        ? `<span class="none">无</span>`
        : claims
            .map((cl) => `<span class="rel"><span class="pill" data-s="${cl.states[c] ?? 2}">${STATE_WORD[cl.states[c] ?? 2]}</span>${escapeHtml(cl.label)}</span>`)
            .join(" ");

    // 想法挂在两处：证据指向的路径（target），或证据读的那个文件（比如 text-in-file 的 file）
    const ideas = (P.ideas ?? []).filter((i) =>
      i.edge
        ? [i.edge.from, i.edge.to].some((p) => under(n.id, p) || contains(n.id, p))
        : targetHits(n.id, i.target) || (i.evidence ?? []).some((f) => contains(n.id, f)),
    );
    const ideasHtml =
      ideas.length === 0
        ? `<span class="none">无</span>`
        : ideas
            .map((i) => {
              const s = i.states[c] ?? 3;
              const w = i.boundary ? (["守住", "越界", "", "测不出来"] as const)[s] : (["已完成", "未完成", "", "测不出来"] as const)[s];
              return `<span class="rel"><span class="ipill" data-i="${s}" data-b="${i.boundary ? 1 : 0}">c${c}：${w}</span>${escapeHtml(i.text)}</span>`;
            })
            .join(" ");

    detailEl.innerHTML = `
      <h3><code>${escapeHtml(n.id)}</code>${g.level === "dir" ? ` <small>目录合并节点</small>` : ""}${selK === k ? ` <small>已钉住，点空白处取消</small>` : ""}</h3>
      <dl class="gdl">
        <dt>存在于</dt><dd>${escapeHtml(runsText(n.alive))}</dd>
        <dt>在 c${c} 上引用了</dt><dd class="d-out">${chips(outs)}</dd>
        <dt>在 c${c} 上被引用于</dt><dd class="d-in">${chips(ins)}</dd>
        <dt>相关的说法</dt><dd>${claimsHtml}</dd>
        <dt>相关的想法</dt><dd>${ideasHtml}</dd>
      </dl>`;
  }

  /* ── 交互 ── */

  const focusChanged = (): void => {
    drawFocus();
    renderDetail();
  };

  svg.addEventListener("mouseover", (e) => {
    const grp = (e.target as Element).closest<SVGGElement>(".gn");
    const k = grp ? Number(grp.dataset["k"]) : null;
    if (k !== hoverK) {
      hoverK = k;
      focusChanged();
    }
  });
  svg.addEventListener("mouseleave", () => {
    hoverK = null;
    focusChanged();
  });
  svg.addEventListener("click", (e) => {
    if (justDragged) return;
    const grp = (e.target as Element).closest<SVGGElement>(".gn");
    selK = grp ? (selK === Number(grp.dataset["k"]) ? null : Number(grp.dataset["k"])) : null;
    focusChanged();
  });

  root.querySelector("#g-mode")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-mode]");
    if (!b) return;
    const diff = b.dataset["mode"] === "diff";
    root.querySelectorAll<HTMLButtonElement>("#g-mode button").forEach((x) => (x.dataset["on"] = x === b ? "1" : "0"));
    // 对比的起点默认取往前约四分之一的位置，一进来就有东西可看
    timeline.set(timeline.c, diff ? Math.max(0, timeline.c - Math.max(1, Math.round(N / 4))) : null);
  });

  root.querySelector("#g-layout")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-layout]");
    if (!b) return;
    layout = b.dataset["layout"] === "layer" ? "layer" : "dir";
    root.querySelectorAll<HTMLButtonElement>("#g-layout button").forEach((x) => (x.dataset["on"] = x === b ? "1" : "0"));
    rebuild();
  });

  root.querySelector(".gzoom")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-z]");
    if (!b) return;
    const [mx, my] = center();
    if (b.dataset["z"] === "in") zoomAt(1.25, mx, my);
    else if (b.dataset["z"] === "out") zoomAt(0.8, mx, my);
    else rebuild();
  });

  playBtn.addEventListener("click", () => {
    if (playing !== null) return stop();
    if (timeline.c >= N - 1) timeline.set(0);
    playBtn.textContent = "暂停";
    playing = window.setInterval(() => {
      if (timeline.c >= N - 1) return stop();
      timeline.set(Math.min(N - 1, timeline.c + Math.max(1, Math.round(N / 150))));
    }, 90);
  });

  root.querySelector<HTMLInputElement>("#g-tests")?.addEventListener("change", (e) => {
    showTests = (e.target as HTMLInputElement).checked;
    rebuild();
  });
  root.querySelector<HTMLInputElement>("#g-all")?.addEventListener("change", (e) => {
    showAll = (e.target as HTMLInputElement).checked;
    drawFocus();
  });

  timeline.onChange(refresh);

  // 初始：看 HEAD；想法那边点了某个目标时，会通过 focusTarget 把对应节点钉住
  timeline.c = N - 1;
  rebuild();

  (window as unknown as { __laminaeGraph: GraphApi }).__laminaeGraph = {
    /** 标出一条引用边界涉及的线；两端在图上都找不到时返回 false */
    focusRule(r: Rule): boolean {
      setRule(r);
      selK = null;
      focusChanged();
      renderLegend();
      renderRule();
      const side = (v: number): string => ruleSide[v] ?? "";
      // 优先滚到第一条命中的线的起点，其次是 from 一端的第一个节点
      const hit = g.edges.findIndex((e, j) => ruleEdge[j] && aliveAt(e.alive, timeline.c) && visible.includes(e.s));
      const k = hit >= 0 ? visible.indexOf(g.edges[hit]!.s) : visible.findIndex((gi) => side(gi) === "from");
      if (k >= 0) {
        scroller.scrollTo({
          left: Math.max(0, px[k]! * zoom - scroller.clientWidth / 2),
          top: Math.max(0, py[k]! * zoom - scroller.clientHeight / 2),
          behavior: "smooth",
        });
      }
      return ruleSide.includes("from") && ruleSide.includes("to");
    },
    /** 把路径指向的节点钉住并滚到可见；找不到返回 false。可以给多个候选，取第一个能找到的 */
    focusTarget(...targets: string[]): boolean {
      let k = -1;
      for (const target of targets) {
        k = visible.findIndex((gi) => targetHits(g.nodes[gi]!.id, target) || contains(g.nodes[gi]!.id, normPath(target)));
        if (k >= 0) break;
      }
      if (k < 0) return false;
      selK = k;
      focusChanged();
      // 只滚图自己的容器，别把整页拖走
      scroller.scrollTo({
        left: Math.max(0, px[k]! * zoom - scroller.clientWidth / 2),
        top: Math.max(0, py[k]! * zoom - scroller.clientHeight / 2),
        behavior: "smooth",
      });
      return true;
    },
  };
}
