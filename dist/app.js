"use strict";
(() => {
  // src/types.ts
  var TRUE = 0;
  var FALSE = 1;
  var ABSENT = 2;
  var UNMEASURED = 3;
  var OUTCOME_TEXT = {
    "hanging-reality-still": "仍挂着，现实一直没动",
    "hanging-reality-moved": "仍挂着，现实已经动过",
    "reality-caught-up": "现实追上了说法",
    "doc-caught-up": "文档追上了现实",
    "doc-corrected": "文档被改正",
    "doc-removed": "说法被删掉或改模糊",
    "unmeasurable": "事实测不出来，无法判定",
    "both-changed": "两边都变了，无法判定",
    "anomaly": "无故翻转，异常"
  };

  // src/compare.ts
  var DEFAULT_TOLERANCE = 0.05;
  function comparePrefix(compare) {
    return compare === "gte" ? "≥ " : compare === "lte" ? "≤ " : compare === "approx" ? "≈ " : "";
  }
  function describeCompare(compare, tolerance = DEFAULT_TOLERANCE) {
    switch (compare) {
      case "gte":
        return "事实不小于文档写的数";
      case "lte":
        return "事实不大于文档写的数";
      case "approx":
        return `事实与文档写的数相差不超过 ${Math.round(tolerance * 1e3) / 10}%`;
      default:
        return "";
    }
  }

  // src/graph-util.ts
  function groupOf(file, depth) {
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
    if (dir === ".") return ".";
    return dir.split("/").slice(0, depth).join("/");
  }
  function aliveAt(alive, c) {
    for (const [a, b] of alive) {
      if (c < a) return false;
      if (c <= b) return true;
    }
    return false;
  }

  // web/layout.ts
  function layoutGraph(ids, edges) {
    const n = ids.length;
    const out = Array.from({ length: n }, () => []);
    const inn = Array.from({ length: n }, () => []);
    for (const e of edges) {
      if (e.s === e.t || e.s < 0 || e.t < 0 || e.s >= n || e.t >= n) continue;
      out[e.s].push(e.t);
      inn[e.t].push(e.s);
    }
    const dagOut = Array.from({ length: n }, () => []);
    const color = new Uint8Array(n);
    for (let root = 0; root < n; root++) {
      if (color[root]) continue;
      const stack = [[root, 0]];
      color[root] = 1;
      while (stack.length) {
        const top = stack[stack.length - 1];
        const [v, k] = top;
        const next = out[v][k];
        if (next === void 0) {
          color[v] = 2;
          stack.pop();
          continue;
        }
        top[1]++;
        if (color[next] === 1) continue;
        dagOut[v].push(next);
        if (color[next] === 0) {
          color[next] = 1;
          stack.push([next, 0]);
        }
      }
    }
    const indeg = new Array(n).fill(0);
    for (let v = 0; v < n; v++) for (const t of dagOut[v]) indeg[t] = (indeg[t] ?? 0) + 1;
    const layer = new Array(n).fill(0);
    const queue = [];
    for (let v = 0; v < n; v++) if (indeg[v] === 0) queue.push(v);
    for (let qi = 0; qi < queue.length; qi++) {
      const v = queue[qi];
      for (const t of dagOut[v]) {
        layer[t] = Math.max(layer[t], layer[v] + 1);
        indeg[t] = (indeg[t] ?? 0) - 1;
        if (indeg[t] === 0) queue.push(t);
      }
    }
    const layers = n === 0 ? 0 : Math.max(...layer) + 1;
    const connected = (v) => out[v].length + inn[v].length > 0;
    const cols = Array.from({ length: layers }, () => []);
    const order2 = [...Array(n).keys()].sort((a, b) => ids[a] < ids[b] ? -1 : ids[a] > ids[b] ? 1 : 0);
    for (const v of order2) cols[layer[v]].push(v);
    const pos = new Array(n).fill(0);
    const reindex = () => {
      for (const col of cols) col.forEach((v, i) => pos[v] = i);
    };
    reindex();
    const sweep = (c, useIn) => {
      const col = cols[c];
      const key = /* @__PURE__ */ new Map();
      for (const v of col) {
        const nb = (useIn ? inn[v] : out[v]).concat(useIn ? out[v] : inn[v]);
        if (!connected(v)) key.set(v, Infinity);
        else if (nb.length === 0) key.set(v, pos[v]);
        else key.set(v, nb.reduce((s, u) => s + pos[u], 0) / nb.length);
      }
      col.sort((a, b) => key.get(a) - key.get(b) || pos[a] - pos[b]);
      col.forEach((v, i) => pos[v] = i);
    };
    for (let round = 0; round < 4; round++) {
      for (let c = 1; c < layers; c++) sweep(c, true);
      for (let c = layers - 2; c >= 0; c--) sweep(c, false);
    }
    const row = new Array(n).fill(0);
    for (const col of cols) col.forEach((v, i) => row[v] = i);
    return { layer, row, layers, rows: cols.reduce((m, c) => Math.max(m, c.length), 0) };
  }
  function shortLabels(ids) {
    const parts = ids.map((id) => id.split("/"));
    const depth = new Array(ids.length).fill(1);
    const label = (i) => parts[i].slice(-depth[i]).join("/");
    for (let guard = 0; guard < 8; guard++) {
      const seen = /* @__PURE__ */ new Map();
      for (let i = 0; i < ids.length; i++) {
        const l = label(i);
        seen.set(l, [...seen.get(l) ?? [], i]);
      }
      let changed = false;
      for (const group of seen.values()) {
        if (group.length < 2) continue;
        for (const i of group) {
          if (depth[i] < parts[i].length) {
            depth[i]++;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    return ids.map((_, i) => label(i));
  }
  var CARD_PAD = 10;
  var CARD_HEAD = 26;
  var CARD_GAP = 44;
  var NODE_GAP = 6;
  var MARGIN = 14;
  var MARGIN_R = 40;
  function layoutCards(ids, availW, nodeW, nodeH) {
    const cardW = nodeW + CARD_PAD * 2;
    const cols = Math.max(1, Math.floor((availW - MARGIN - MARGIN_R + CARD_GAP) / (cardW + CARD_GAP)));
    const groups = /* @__PURE__ */ new Map();
    ids.forEach((id, i) => {
      const p = id.lastIndexOf("/");
      const key = p < 0 ? "" : id.slice(0, p);
      const list = groups.get(key);
      if (list) list.push(i);
      else groups.set(key, [i]);
    });
    const colH = new Array(cols).fill(MARGIN);
    const x = new Array(ids.length).fill(0);
    const y = new Array(ids.length).fill(0);
    const cards = [];
    for (const key of [...groups.keys()].sort()) {
      const members = groups.get(key).sort((a, b) => ids[a] < ids[b] ? -1 : 1);
      const h = CARD_HEAD + members.length * (nodeH + NODE_GAP) - NODE_GAP + CARD_PAD * 2;
      let col = 0;
      for (let c = 1; c < cols; c++) if (colH[c] < colH[col]) col = c;
      const x0 = MARGIN + col * (cardW + CARD_GAP);
      const y0 = colH[col];
      members.forEach((m, i) => {
        x[m] = x0 + CARD_PAD;
        y[m] = y0 + CARD_HEAD + CARD_PAD / 2 + i * (nodeH + NODE_GAP);
      });
      cards.push({ title: key === "" ? "（根目录）" : key, x: x0, y: y0, w: cardW, h });
      colH[col] = y0 + h + CARD_GAP;
    }
    const used = Math.min(cols, Math.max(1, cards.length));
    return {
      x,
      y,
      cards,
      width: MARGIN + MARGIN_R + used * cardW + (used - 1) * CARD_GAP,
      height: Math.max(...colH) - CARD_GAP + MARGIN
    };
  }

  // web/shared.ts
  var escapeHtml = (s) => s.replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]);
  var timeline = {
    c: 0,
    from: null,
    listeners: [],
    set(c, from = void 0) {
      timeline.c = c;
      if (from !== void 0) timeline.from = from;
      for (const l of timeline.listeners) l();
    },
    onChange(l) {
      timeline.listeners.push(l);
    }
  };
  function commitText(commits, i) {
    const c = commits[i];
    return c ? `c${i} · ${c.short} · ${c.date} · ${c.subject}` : `c${i}`;
  }
  var normPath = (p) => p.trim().replace(/^\.\//, "").replace(/\/+$/, "");

  // web/ruler.ts
  var SVG_NS = "http://www.w3.org/2000/svg";
  var H = 58;
  var AXIS_H = 14;
  var MIN_WINDOW = 8;
  var mk = (tag, attrs) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  function niceStep(minGap) {
    if (minGap <= 1) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(minGap)));
    for (const m of [1, 2, 5, 10]) if (m * p >= minGap) return m * p;
    return 10 * p;
  }
  function createRuler(host, o) {
    const { N } = o;
    let series = o.series;
    let seriesLabel = o.seriesLabel;
    let lo = 0;
    let size = N;
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
    const reads = host.querySelector("#rl-reads");
    const track = host.querySelector("#rl-track");
    const winEl = host.querySelector("#rl-win");
    const width = () => track.clientWidth || host.clientWidth || 720;
    const clampWin = () => {
      size = Math.max(Math.min(MIN_WINDOW, N), Math.min(N, size));
      lo = Math.max(0, Math.min(N - size, lo));
    };
    const xOf = (c) => (c - lo + 0.5) / size * width();
    const cAt = (px) => Math.max(0, Math.min(N - 1, Math.round(lo + px / width() * size - 0.5)));
    function ensureVisible(c) {
      if (c < lo) lo = c - Math.round(size * 0.1);
      else if (c > lo + size - 1) lo = c - Math.round(size * 0.9);
      clampWin();
    }
    function draw() {
      const W = width();
      track.replaceChildren();
      const svg = mk("svg", { width: String(W), height: String(H), viewBox: `0 0 ${W} ${H}`, class: "rl-svg" });
      track.appendChild(svg);
      const plotH = H - AXIS_H;
      const first = Math.max(0, Math.floor(lo));
      const last = Math.min(N - 1, Math.ceil(lo + size - 1));
      const max = Math.max(1, ...series);
      const count = last - first + 1;
      const stride = Math.max(1, Math.floor(count / Math.max(1, W)));
      const pts = [];
      for (let c = first; c <= last; c += stride) {
        let v = 0;
        for (let k = c; k < Math.min(c + stride, last + 1); k++) v = Math.max(v, series[k] ?? 0);
        pts.push(`${xOf(c + (stride - 1) / 2).toFixed(1)},${(plotH - 2 - v / max * (plotH - 8)).toFixed(1)}`);
      }
      if (pts.length > 0) {
        const x0 = xOf(first).toFixed(1);
        const x1 = xOf(last).toFixed(1);
        svg.appendChild(mk("polygon", { class: "rl-area", points: `${x0},${plotH} ${pts.join(" ")} ${x1},${plotH}` }));
        svg.appendChild(mk("polyline", { class: "rl-line", points: pts.join(" ") }));
      }
      if (timeline.from !== null) {
        const a = xOf(Math.min(timeline.from, timeline.c));
        const b = xOf(Math.max(timeline.from, timeline.c));
        svg.appendChild(mk("rect", { class: "rl-span", x: a.toFixed(1), y: "0", width: Math.max(1, b - a).toFixed(1), height: String(plotH) }));
      }
      const step = niceStep(64 * size / W);
      svg.appendChild(mk("line", { class: "rl-base", x1: "0", x2: String(W), y1: String(plotH), y2: String(plotH) }));
      for (let c = Math.ceil(first / step) * step; c <= last; c += step) {
        const x = xOf(c);
        svg.appendChild(mk("line", { class: "rl-tick", x1: x.toFixed(1), x2: x.toFixed(1), y1: String(plotH), y2: String(plotH + 4) }));
        const t = mk("text", { class: "rl-tt", x: x.toFixed(1), y: String(H - 2) });
        t.textContent = `c${c}`;
        svg.appendChild(t);
      }
      const cursor = (c, cls) => {
        const x = xOf(c);
        if (x < -4 || x > W + 4) return;
        svg.appendChild(mk("line", { class: `rl-cur ${cls}`, x1: x.toFixed(1), x2: x.toFixed(1), y1: "0", y2: String(plotH) }));
        svg.appendChild(mk("circle", { class: `rl-knob ${cls}`, cx: x.toFixed(1), cy: "5", r: "5" }));
      };
      if (timeline.from !== null) cursor(timeline.from, "from");
      cursor(timeline.c, "now");
      winEl.textContent = size >= N ? `全部 ${N} 个 commit` : `c${first}–c${last}（${Math.round(size)} 个）· ${seriesLabel}`;
      track.setAttribute("aria-valuenow", String(timeline.c));
      track.setAttribute("aria-valuetext", o.text(timeline.c));
      reads.innerHTML = (timeline.from !== null ? `<div><b class="rl-k from">起点</b><span>${esc(o.text(timeline.from))}</span></div>` : "") + `<div><b class="rl-k now">${timeline.from !== null ? "当前" : "时间"}</b><span>${esc(o.text(timeline.c))}</span></div>`;
    }
    const esc = (s) => s.replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]);
    function zoomAround(anchorC, frac, factor) {
      const next = Math.max(Math.min(MIN_WINDOW, N), Math.min(N, size * factor));
      lo = anchorC - frac * next + 0.5;
      size = next;
      clampWin();
      draw();
    }
    const user = () => o.onUser?.();
    track.addEventListener(
      "wheel",
      (e) => {
        if (e.altKey || e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const r = track.getBoundingClientRect();
          const frac = (e.clientX - r.left) / Math.max(1, r.width);
          zoomAround(lo + frac * size - 0.5, frac, Math.exp(e.deltaY * 2e-3));
        } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          e.preventDefault();
          const d = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
          lo += d / width() * size;
          clampWin();
          draw();
        }
      },
      { passive: false }
    );
    let dragging = null;
    const pick = (px) => {
      if (timeline.from === null) return "now";
      return Math.abs(xOf(timeline.from) - px) < Math.abs(xOf(timeline.c) - px) ? "from" : "now";
    };
    const apply = (which, px) => {
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
    const end = () => {
      dragging = null;
    };
    track.addEventListener("pointerup", end);
    track.addEventListener("pointercancel", end);
    track.addEventListener("keydown", (e) => {
      const big = e.shiftKey ? 10 : 1;
      const to = (c) => {
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
    host.querySelector(".rl-bar").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-a]");
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
      setSeries(s, label) {
        series = s;
        if (label) seriesLabel = label;
        draw();
      },
      redraw: draw
    };
  }

  // web/graph.ts
  var NODE_W = 212;
  var NODE_H = 24;
  var COL_GAP = 64;
  var ROW_GAP = 8;
  var PAD = 16;
  var SVG_NS2 = "http://www.w3.org/2000/svg";
  var MIN_ZOOM = 0.3;
  var MAX_ZOOM = 2.5;
  var MAX_DRAWN = 1500;
  var mk2 = (tag, attrs = {}) => {
    const el = document.createElementNS(SVG_NS2, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  var STATE_WORD = ["真", "假", "尚未写入文档", "测不出来"];
  var TAIL = 9;
  var fit = (label, max, keepTail) => label.length <= max ? label : keepTail ? "…" + label.slice(-(max - 1)) : label.slice(0, max - 1 - TAIL) + "…" + label.slice(-TAIL);
  function initGraph(P2) {
    const g = P2.graph;
    const N = P2.commits.length;
    const root = document.querySelector("#graph-body");
    if (!root) return;
    const outE = g.nodes.map(() => []);
    const inE = g.nodes.map(() => []);
    g.edges.forEach((e, j) => {
      outE[e.s].push(j);
      inE[e.t].push(j);
    });
    let showTests = false;
    let showAll = false;
    let layout = "dir";
    let zoom = 1;
    let playing = null;
    let hoverK = null;
    let selK = null;
    let rule = null;
    let ruleEdge = [];
    let ruleSide = [];
    let visible = [];
    let nodeEls = [];
    let px = [];
    let py = [];
    let ledges = [];
    let vbW = 0;
    let vbH = 0;
    let edgeLayer = null;
    let outDeg = [];
    let inDeg = [];
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
    const svg = root.querySelector("#g-svg");
    const scroller = root.querySelector("#g-scroll");
    const countEl = root.querySelector("#g-count");
    const detailEl = root.querySelector("#g-detail");
    const diffEl = root.querySelector("#g-diff");
    const legendEl = root.querySelector("#g-legend");
    const ruleEl = root.querySelector("#g-rule");
    const playBtn = root.querySelector("#g-play");
    const stop = () => {
      if (playing !== null) clearInterval(playing);
      playing = null;
      playBtn.textContent = "播放";
    };
    const ruler = createRuler(root.querySelector("#g-ruler"), {
      N,
      series: new Array(N).fill(0),
      seriesLabel: `曲线 = 每个 commit 上的${word}数`,
      text: (c) => commitText(P2.commits, c),
      onUser: stop
    });
    function applyZoom() {
      svg.setAttribute("width", String(Math.round(vbW * zoom)));
      svg.setAttribute("height", String(Math.round(vbH * zoom)));
    }
    function zoomAt(factor, mx, my) {
      const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
      if (z === zoom) return;
      const wx = (scroller.scrollLeft + mx) / zoom;
      const wy = (scroller.scrollTop + my) / zoom;
      zoom = z;
      applyZoom();
      scroller.scrollLeft = wx * zoom - mx;
      scroller.scrollTop = wy * zoom - my;
    }
    const center = () => [scroller.clientWidth / 2, scroller.clientHeight / 2];
    scroller.addEventListener(
      "wheel",
      (e) => {
        if (!(e.altKey || e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        const r = scroller.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * 15e-4), e.clientX - r.left, e.clientY - r.top);
      },
      { passive: false }
    );
    let drag = null;
    let justDragged = false;
    scroller.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".gn")) return;
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
        setTimeout(() => justDragged = false, 0);
      }
      drag = null;
      delete scroller.dataset["panning"];
    });
    function rebuild() {
      visible = g.nodes.map((_, i) => i).filter((i) => showTests || !g.nodes[i].test);
      if (visible.length === 0) visible = g.nodes.map((_, i) => i);
      const local = new Map(visible.map((gi, k) => [gi, k]));
      ledges = g.edges.map((e, j) => ({ s: local.get(e.s), t: local.get(e.t), j })).filter((e) => e.s !== void 0 && e.t !== void 0);
      const ids = visible.map((gi) => g.nodes[gi].id);
      let labels;
      let cards = [];
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
        px = ids.map((_, k) => PAD + lay.layer[k] * (NODE_W + COL_GAP));
        py = ids.map((_, k) => PAD + lay.row[k] * (NODE_H + ROW_GAP));
        vbW = lay.layers * (NODE_W + COL_GAP) - COL_GAP + PAD * 2 + 40;
        vbH = lay.rows * (NODE_H + ROW_GAP) - ROW_GAP + PAD * 2;
        labels = shortLabels(ids);
        const avail = scroller.clientWidth || vbW;
        zoom = Math.max(0.6, Math.min(1, avail / vbW));
      }
      svg.setAttribute("viewBox", `0 0 ${vbW} ${vbH}`);
      applyZoom();
      svg.replaceChildren();
      const defs = mk2("defs");
      for (const kind of ["out", "in", "all", "added", "removed", "rule", "ruleok"]) {
        const marker = mk2("marker", { id: `g-arr-${kind}`, viewBox: "0 0 8 8", refX: "7", refY: "4", markerWidth: "6", markerHeight: "6", orient: "auto" });
        marker.appendChild(mk2("path", { d: "M0,0 L8,4 L0,8 z", class: `g-arrow ${kind}` }));
        defs.appendChild(marker);
      }
      svg.appendChild(defs);
      for (const card of cards) {
        const grp = mk2("g", { class: "g-card" });
        grp.appendChild(mk2("rect", { x: String(card.x), y: String(card.y), width: String(card.w), height: String(card.h), rx: "8" }));
        const t = mk2("text", { x: String(card.x + 12), y: String(card.y + 17) });
        t.textContent = fit(card.title, 28, true);
        const tt = mk2("title");
        tt.textContent = card.title;
        grp.append(t, tt);
        svg.appendChild(grp);
      }
      edgeLayer = mk2("g", { class: "g-edges" });
      svg.appendChild(edgeLayer);
      nodeEls = visible.map((gi, k) => {
        const node = g.nodes[gi];
        const grp = mk2("g", { class: "gn", transform: `translate(${px[k]},${py[k]})`, "data-k": String(k), tabindex: "-1" });
        grp.appendChild(mk2("rect", { width: String(NODE_W), height: String(NODE_H), rx: "5" }));
        const text = mk2("text", { x: "9", y: String(NODE_H / 2 + 4), class: "gl" });
        text.textContent = fit(labels[k], 21, layout === "layer");
        grp.appendChild(text);
        grp.appendChild(mk2("text", { x: String(NODE_W - 34), y: String(NODE_H / 2 + 4), class: "gb out", "text-anchor": "end" }));
        grp.appendChild(mk2("text", { x: String(NODE_W - 8), y: String(NODE_H / 2 + 4), class: "gb in", "text-anchor": "end" }));
        const title = mk2("title");
        title.textContent = node.id + (g.level === "dir" ? "（目录合并节点）" : "");
        grp.appendChild(title);
        svg.appendChild(grp);
        return grp;
      });
      if (selK !== null && selK >= visible.length) selK = null;
      hoverK = null;
      const series = new Array(N + 1).fill(0);
      for (const gi of visible) for (const [a, b] of g.nodes[gi].alive) {
        series[a]++;
        series[b + 1]--;
      }
      let run = 0;
      ruler.setSeries(series.slice(0, N).map((d) => run += d));
      refresh();
    }
    const stOf = (aliveNow, aliveFrom) => {
      if (aliveFrom === null) return aliveNow ? "on" : "off";
      if (aliveNow && aliveFrom) return "kept";
      if (aliveNow) return "added";
      if (aliveFrom) return "removed";
      return "off";
    };
    let edgeSt = [];
    function refresh() {
      const c = timeline.c;
      const from = timeline.from;
      visible.forEach((gi, k) => {
        const n = g.nodes[gi];
        nodeEls[k].dataset["st"] = stOf(aliveAt(n.alive, c), from === null ? null : aliveAt(n.alive, from));
      });
      edgeSt = g.edges.map((e) => stOf(aliveAt(e.alive, c), from === null ? null : aliveAt(e.alive, from)));
      outDeg = g.nodes.map(() => 0);
      inDeg = g.nodes.map(() => 0);
      for (const e of g.edges) {
        if (aliveAt(e.alive, c)) {
          outDeg[e.s]++;
          inDeg[e.t]++;
        }
      }
      visible.forEach((gi, k) => {
        const [o, i] = nodeEls[k].querySelectorAll(".gb");
        o.textContent = outDeg[gi] > 0 ? `→${outDeg[gi]}` : "";
        i.textContent = inDeg[gi] > 0 ? `←${inDeg[gi]}` : "";
      });
      drawFocus();
      const nodesNow = g.nodes.filter((n) => aliveAt(n.alive, c)).length;
      const edgesNow = g.edges.filter((e) => aliveAt(e.alive, c)).length;
      countEl.textContent = `c${c} 上：${nodesNow} 个${word}，${edgesNow} 条引用`;
      renderLegend2();
      renderRule();
      renderDiff();
      renderDetail();
    }
    const under = (id, dir) => id === dir || id.startsWith(dir + "/");
    function setRule(next) {
      rule = next;
      ruleSide = g.nodes.map((n) => !next ? "" : under(n.id, next.from) ? "from" : under(n.id, next.to) ? "to" : "");
      ruleEdge = g.edges.map((e) => next ? ruleSide[e.s] === "from" && ruleSide[e.t] === "to" : false);
    }
    function renderRule() {
      if (!rule) {
        ruleEl.hidden = true;
        ruleEl.innerHTML = "";
        return;
      }
      const c = timeline.c;
      const n = g.edges.filter((e, j) => ruleEdge[j] && aliveAt(e.alive, c)).length;
      const bad = rule.expect === "absent";
      const verdict = bad ? n === 0 ? `<b class="ok">c${c} 上守住：没有这样的引用</b>` : `<b class="bad">c${c} 上越界：${n} 条引用</b>` : n === 0 ? `<b class="none">c${c} 上没有这样的引用</b>` : `<b class="ok">c${c} 上有 ${n} 条引用</b>`;
      const coarse = !ruleSide.includes("from") || !ruleSide.includes("to") ? `<span class="none">图上找不到这两端（图按目录前 ${g.depth ?? 1} 级合并，规则比它更细，或对应的文件被折掉了），标不出线；上面的判定以逐 commit 的扫描为准。</span>` : "";
      ruleEl.hidden = false;
      ruleEl.innerHTML = `<span class="rtag">${bad ? "边界" : "想法"}</span><span class="rtext">${escapeHtml(rule.text)}</span>
      <code>${escapeHtml(rule.from)}</code> → <code>${escapeHtml(rule.to)}</code> ${verdict} ${coarse}
      <button type="button" class="linkbtn" data-clear-rule="1">取消标出</button>`;
    }
    ruleEl.addEventListener("click", (e) => {
      if (!e.target.closest("[data-clear-rule]")) return;
      setRule(null);
      renderLegend2();
      renderRule();
      drawFocus();
    });
    function drawFocus() {
      if (!edgeLayer) return;
      edgeLayer.replaceChildren();
      const k = hoverK ?? selK;
      const gi = k === null ? -1 : visible[k];
      const diffMode = timeline.from !== null;
      const outSet = /* @__PURE__ */ new Set();
      const inSet = /* @__PURE__ */ new Set();
      let drawn = 0;
      const anchors = (s, t) => {
        const sx = px[s];
        const sy = py[s] + NODE_H / 2;
        const tx = px[t];
        const ty = py[t] + NODE_H / 2;
        if (tx >= sx + NODE_W + 10) {
          const x12 = sx + NODE_W;
          const dx = Math.max(36, (tx - x12) / 2);
          return `M${x12},${sy} C${x12 + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`;
        }
        if (tx + NODE_W + 10 <= sx) {
          const x22 = tx + NODE_W;
          const dx = Math.max(36, (sx - x22) / 2);
          return `M${sx},${sy} C${sx - dx},${sy} ${x22 + dx},${ty} ${x22},${ty}`;
        }
        const x1 = sx + NODE_W;
        const x2 = tx + NODE_W;
        const bulge = 22 + Math.min(26, Math.abs(ty - sy) / 12);
        return `M${x1},${sy} C${x1 + bulge},${sy} ${x2 + bulge},${ty} ${x2},${ty}`;
      };
      for (const e of ledges) {
        if (drawn >= MAX_DRAWN) break;
        const st = edgeSt[e.j];
        if (st === "off") continue;
        const edge = g.edges[e.j];
        const touch = k !== null && (edge.s === gi || edge.t === gi);
        let role = null;
        if (touch) {
          role = st === "added" ? "added" : st === "removed" ? "removed" : edge.s === gi ? "out" : "in";
          if (edge.s === gi) outSet.add(edge.t);
          if (edge.t === gi) inSet.add(edge.s);
        } else if (k === null && diffMode && (st === "added" || st === "removed")) {
          role = st;
        } else if (k === null && showAll) {
          role = st === "added" ? "added" : st === "removed" ? "removed" : "all";
        }
        if (ruleEdge[e.j]) role = rule?.expect === "absent" ? "rule" : "ruleok";
        if (role === null) continue;
        const d = anchors(e.s, e.t);
        edgeLayer.appendChild(mk2("path", { class: `ge ${role}`, d, "marker-end": `url(#g-arr-${role})` }));
        drawn++;
      }
      svg.dataset["focus"] = k === null ? "0" : "1";
      visible.forEach((v, kk) => {
        nodeEls[kk].dataset["rule"] = ruleSide[v] ?? "";
        const isOut = outSet.has(v);
        const isIn = inSet.has(v);
        nodeEls[kk].dataset["hl"] = k === null ? "" : kk === k ? "self" : isOut && isIn ? "both" : isOut ? "out" : isIn ? "in" : "dim";
      });
    }
    function renderLegend2() {
      const mode = timeline.from === null ? `<span><i class="sw on"></i>当前存在</span><span><i class="sw off"></i>当前不存在（淡出）</span>` : `<span><i class="sw added"></i>新增</span><span><i class="sw removed"></i>删除</span><span><i class="sw kept"></i>两个时间点都在</span>`;
      legendEl.innerHTML = mode + `<span><i class="ln out"></i>它引用了</span><span><i class="ln in"></i>引用了它</span>` + (rule ? `<span><i class="ln ${rule.expect === "absent" ? "rule" : "ruleok"}"></i>${rule.expect === "absent" ? "越界的引用" : "符合想法的引用"}</span>` : "") + `<span class="plain">右侧小数字：<b class="o">→</b>引用了几个，<b class="i">←</b>被几个引用${g.level === "dir" ? `；文件太多（历史上共 ${g.fileCount} 个），已按目录前 ${g.depth} 级合并` : ""}</span>`;
    }
    function renderDiff() {
      const from = timeline.from;
      if (from === null) {
        diffEl.innerHTML = "";
        return;
      }
      const c = timeline.c;
      const addedN = [];
      const removedN = [];
      g.nodes.forEach((n, i) => {
        const a = aliveAt(n.alive, from);
        const b = aliveAt(n.alive, c);
        if (!a && b) addedN.push(i);
        if (a && !b) removedN.push(i);
      });
      const addedE = [];
      const removedE = [];
      g.edges.forEach((e, j) => {
        const a = aliveAt(e.alive, from);
        const b = aliveAt(e.alive, c);
        if (!a && b) addedE.push(j);
        if (a && !b) removedE.push(j);
      });
      const CAP = 24;
      const nodeList = (xs) => xs.length === 0 ? `<span class="none">无</span>` : xs.slice(0, CAP).map((i) => `<code>${escapeHtml(g.nodes[i].id)}</code>`).join(" ") + (xs.length > CAP ? ` <span class="none">另有 ${xs.length - CAP} 个</span>` : "");
      const edgeList = (xs) => xs.length === 0 ? `<span class="none">无</span>` : xs.slice(0, CAP).map((j) => `<code>${escapeHtml(g.nodes[g.edges[j].s].id)} → ${escapeHtml(g.nodes[g.edges[j].t].id)}</code>`).join(" ") + (xs.length > CAP ? ` <span class="none">另有 ${xs.length - CAP} 条</span>` : "");
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
    const contains = (nodeId, file) => g.level === "file" ? nodeId === file : groupOf(file, g.depth ?? 1) === nodeId || file.startsWith(nodeId + "/");
    const targetHits = (nodeId, target) => {
      const t = normPath(target);
      if (!t) return false;
      return nodeId === t || nodeId.startsWith(t + "/") || g.level === "dir" && (groupOf(t, g.depth ?? 1) === nodeId || t.startsWith(nodeId + "/"));
    };
    const runsText = (alive) => alive.length === 0 ? "从未存在" : alive.map(([a, b]) => b === N - 1 ? `c${a} 起至今` : a === b ? `c${a}` : `c${a} → c${b}`).join("，");
    function renderDetail() {
      const k = hoverK ?? selK;
      if (k === null) {
        detailEl.innerHTML = `<p class="hintline">把鼠标移到某个${word}上：只画它的引用线，并在这里列出它引用了谁、被谁引用，以及相关的说法与想法。点一下可以钉住。</p>`;
        return;
      }
      const gi = visible[k];
      const n = g.nodes[gi];
      const c = timeline.c;
      const chips = (xs) => xs.length === 0 ? `<span class="none">无</span>` : xs.map((s) => `<code>${escapeHtml(s)}</code>`).join(" ");
      const outs = outE[gi].filter((j) => aliveAt(g.edges[j].alive, c)).map((j) => g.nodes[g.edges[j].t].id);
      const ins = inE[gi].filter((j) => aliveAt(g.edges[j].alive, c)).map((j) => g.nodes[g.edges[j].s].id);
      const claims = P2.claims.filter((cl) => cl.evidence.some((f) => contains(n.id, f)));
      const claimsHtml = claims.length === 0 ? `<span class="none">无</span>` : claims.map((cl) => `<span class="rel"><span class="pill" data-s="${cl.states[c] ?? 2}">${STATE_WORD[cl.states[c] ?? 2]}</span>${escapeHtml(cl.label)}</span>`).join(" ");
      const ideas = (P2.ideas ?? []).filter(
        (i) => i.edge ? [i.edge.from, i.edge.to].some((p) => under(n.id, p) || contains(n.id, p)) : targetHits(n.id, i.target) || (i.evidence ?? []).some((f) => contains(n.id, f))
      );
      const ideasHtml = ideas.length === 0 ? `<span class="none">无</span>` : ideas.map((i) => {
        const s = i.states[c] ?? 3;
        const w = i.boundary ? ["守住", "越界", "", "测不出来"][s] : ["已完成", "未完成", "", "测不出来"][s];
        return `<span class="rel"><span class="ipill" data-i="${s}" data-b="${i.boundary ? 1 : 0}">c${c}：${w}</span>${escapeHtml(i.text)}</span>`;
      }).join(" ");
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
    const focusChanged = () => {
      drawFocus();
      renderDetail();
    };
    svg.addEventListener("mouseover", (e) => {
      const grp = e.target.closest(".gn");
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
      const grp = e.target.closest(".gn");
      selK = grp ? selK === Number(grp.dataset["k"]) ? null : Number(grp.dataset["k"]) : null;
      focusChanged();
    });
    root.querySelector("#g-mode").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-mode]");
      if (!b) return;
      const diff = b.dataset["mode"] === "diff";
      root.querySelectorAll("#g-mode button").forEach((x) => x.dataset["on"] = x === b ? "1" : "0");
      timeline.set(timeline.c, diff ? Math.max(0, timeline.c - Math.max(1, Math.round(N / 4))) : null);
    });
    root.querySelector("#g-layout").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-layout]");
      if (!b) return;
      layout = b.dataset["layout"] === "layer" ? "layer" : "dir";
      root.querySelectorAll("#g-layout button").forEach((x) => x.dataset["on"] = x === b ? "1" : "0");
      rebuild();
    });
    root.querySelector(".gzoom").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-z]");
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
    root.querySelector("#g-tests")?.addEventListener("change", (e) => {
      showTests = e.target.checked;
      rebuild();
    });
    root.querySelector("#g-all")?.addEventListener("change", (e) => {
      showAll = e.target.checked;
      drawFocus();
    });
    timeline.onChange(refresh);
    timeline.c = N - 1;
    rebuild();
    window.__laminaeGraph = {
      /** 标出一条引用边界涉及的线；两端在图上都找不到时返回 false */
      focusRule(r) {
        setRule(r);
        selK = null;
        focusChanged();
        renderLegend2();
        renderRule();
        const side = (v) => ruleSide[v] ?? "";
        const hit = g.edges.findIndex((e, j) => ruleEdge[j] && aliveAt(e.alive, timeline.c) && visible.includes(e.s));
        const k = hit >= 0 ? visible.indexOf(g.edges[hit].s) : visible.findIndex((gi) => side(gi) === "from");
        if (k >= 0) {
          scroller.scrollTo({
            left: Math.max(0, px[k] * zoom - scroller.clientWidth / 2),
            top: Math.max(0, py[k] * zoom - scroller.clientHeight / 2),
            behavior: "smooth"
          });
        }
        return ruleSide.includes("from") && ruleSide.includes("to");
      },
      /** 把路径指向的节点钉住并滚到可见；找不到返回 false。可以给多个候选，取第一个能找到的 */
      focusTarget(...targets) {
        let k = -1;
        for (const target of targets) {
          k = visible.findIndex((gi) => targetHits(g.nodes[gi].id, target) || contains(g.nodes[gi].id, normPath(target)));
          if (k >= 0) break;
        }
        if (k < 0) return false;
        selK = k;
        focusChanged();
        scroller.scrollTo({
          left: Math.max(0, px[k] * zoom - scroller.clientWidth / 2),
          top: Math.max(0, py[k] * zoom - scroller.clientHeight / 2),
          behavior: "smooth"
        });
        return true;
      }
    };
  }

  // web/gridzoom.ts
  var DEFAULT_CW = 13;
  var MIN_CW = 0.5;
  var MAX_CW = 32;
  var gridView = {
    cw: DEFAULT_CW,
    gap: 2,
    /** 横轴每隔多少个 commit 标一个编号 */
    step: 10
  };
  function tickSet(n, step) {
    const s = /* @__PURE__ */ new Set();
    if (n <= 0) return s;
    for (let c = 0; c < n; c += step) s.add(c);
    const last = n - 1;
    if (last - Math.floor(last / step) * step >= step / 2) s.add(last);
    return s;
  }
  var gapFor = (cw) => cw >= 7 ? 2 : cw >= 3.5 ? 1 : 0;
  function initGridZoom(mapEl2, n, onChange) {
    const wrap = mapEl2.parentElement;
    let manual = false;
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
    const zw = bar.querySelector("#zw");
    const labelW = () => parseFloat(getComputedStyle(mapEl2).getPropertyValue("--label-w")) || 208;
    const padX = () => {
      const s = getComputedStyle(wrap);
      return (parseFloat(s.paddingLeft) || 0) + (parseFloat(s.paddingRight) || 0);
    };
    function fitCw() {
      const avail = (wrap.clientWidth || 1e3) - padX() - labelW() - 4;
      for (const gap of [2, 1, 0]) {
        const cw = avail / n - gap;
        if (cw >= (gap === 2 ? 7 : gap === 1 ? 3.5 : 0)) return Math.min(DEFAULT_CW, cw);
      }
      return MIN_CW;
    }
    function apply(cw) {
      gridView.cw = Math.max(MIN_CW, Math.min(MAX_CW, cw));
      gridView.gap = gapFor(gridView.cw);
      gridView.step = niceStep(70 / (gridView.cw + gridView.gap));
      mapEl2.style.setProperty("--cw", `${gridView.cw.toFixed(2)}px`);
      mapEl2.style.setProperty("--gap", `${gridView.gap}px`);
      mapEl2.dataset["tiny"] = gridView.cw < 6 ? "1" : "0";
      zw.textContent = `每格 ${gridView.cw >= 10 ? Math.round(gridView.cw) : gridView.cw.toFixed(1)}px`;
      const ticks = tickSet(n, gridView.step);
      mapEl2.querySelectorAll(".axis .tick").forEach((t, c) => {
        t.textContent = ticks.has(c) ? String(c) : "";
      });
    }
    function zoomTo(cw, anchorX) {
      const before = gridView.cw + gridView.gap;
      const col = (wrap.scrollLeft + anchorX - padX() / 2 - labelW()) / before;
      apply(cw);
      const after = gridView.cw + gridView.gap;
      wrap.scrollLeft = col * after + labelW() + padX() / 2 - anchorX;
      onChange();
    }
    const mid = () => wrap.clientWidth / 2;
    bar.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-z]");
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
        if (!(e.altKey || e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        manual = true;
        zoomTo(gridView.cw * Math.exp(-e.deltaY * 15e-4), e.clientX - wrap.getBoundingClientRect().left);
      },
      { passive: false }
    );
    window.addEventListener("resize", () => {
      if (manual) return;
      apply(fitCw());
      onChange();
    });
    apply(fitCw());
  }

  // web/ideas.ts
  var WORD = {
    idea: ["已完成", "未完成", "", "测不出来"],
    boundary: ["守住", "越界", "", "测不出来"]
  };
  var wordOf = (i, s) => WORD[i.boundary ? "boundary" : "idea"][s] ?? "";
  function segments(states) {
    const out = [];
    for (const [i, s] of states.entries()) {
      const last = out.at(-1);
      if (last && last.s === s) last.to = i;
      else out.push({ from: i, to: i, s });
    }
    return out;
  }
  function initIdeas(P2) {
    const N = P2.commits.length;
    const ideasRoot = document.querySelector("#ideas-body");
    const candRoot = document.querySelector("#cand-body");
    if (ideasRoot && P2.ideas && P2.ideas.length > 0) renderIdeas(ideasRoot, P2.ideas);
    if (candRoot && P2.candidates) renderCandidates(candRoot, P2);
    function edgeBlock(it) {
      if (!it.edge) return "";
      const { from, to } = it.edge;
      if (it.unsure) return `<p class="idea-edge" data-k="unsure"><b>HEAD 上判不了：</b>${escapeHtml(it.unsure)}</p>`;
      const total = it.hitsTotal ?? 0;
      if (total === 0) return `<p class="idea-edge" data-k="none">HEAD 上 <code>${escapeHtml(from)}</code> 没有引用 <code>${escapeHtml(to)}</code> 下的文件。</p>`;
      const shown = (it.hits ?? []).slice(0, 8).map(([a, b]) => `<li><code>${escapeHtml(a)}</code> → <code>${escapeHtml(b)}</code></li>`).join("");
      const more = total > 8 ? `<li class="none">……还有 ${total - 8} 条</li>` : "";
      const label = it.expect === "absent" ? "越界的引用" : "符合的引用";
      return `<div class="idea-edge" data-k="${it.expect === "absent" ? "bad" : "ok"}"><b>HEAD 上${label}（${total} 条）：</b><ul>${shown}${more}</ul></div>`;
    }
    function renderIdeas(root, ideas) {
      const done = ideas.filter((i) => !i.boundary && i.atHead === 0).length;
      const todo = ideas.filter((i) => !i.boundary && i.atHead === 1).length;
      const held = ideas.filter((i) => i.boundary && i.atHead === 0).length;
      const crossed = ideas.filter((i) => i.boundary && i.atHead === 1).length;
      const back = ideas.filter((i) => i.regressions > 0).length;
      const blind = ideas.filter((i) => i.atHead === 3).length;
      const hasGraph = Boolean(P2.graph);
      const rows = ideas.map((it, k) => {
        const segs = segments(it.states);
        const rects = segs.map((sg) => `<rect x="${sg.from}" y="0" width="${sg.to - sg.from + 1}" height="1" class="ir" data-i="${sg.s}" data-b="${it.boundary ? 1 : 0}"></rect>`).join("");
        const history2 = segs.slice(0, 8).map((sg) => {
          const c = P2.commits[sg.from];
          const when = `c${sg.from}${c ? `（${c.date}）` : ""}`;
          return sg.to === N - 1 ? `${when} 起至今${wordOf(it, sg.s)}` : `${when} → c${sg.to} ${wordOf(it, sg.s)}`;
        }).join("；") + (segs.length > 8 ? "；……" : "");
        const note = it.regressions > 0 ? `<span class="warn">做完之后又退回去过 ${it.regressions} 次</span>` : it.firstMet < 0 ? it.boundary ? `<span class="warn">从没守住过</span>` : `<span class="none">从未满足</span>` : "";
        return `<article class="idea" data-k="${k}">
          <div class="idea-head">
            <span class="tag" data-b="${it.boundary ? 1 : 0}">${it.boundary ? "边界" : "想法"}</span>
            <span class="idea-text">${escapeHtml(it.text)}</span>
            <span class="ipill" data-i="${it.atHead}" data-b="${it.boundary ? 1 : 0}" data-role="now">${wordOf(it, it.atHead)}</span>
            ${hasGraph ? `<button type="button" class="linkbtn" data-focus="${k}" title="${it.edge ? "在上面的调用关系图里标出这条规则涉及的引用线" : "在上面的调用关系图里找到它指向的位置"}">在图上看</button>` : ""}
          </div>
          <div class="strip" data-k="${k}">
            <svg viewBox="0 0 ${N} 1" preserveAspectRatio="none" aria-hidden="true">${rects}</svg>
            <i class="cursor"></i>
          </div>
          <p class="idea-meta"><span>证据：${escapeHtml(it.check)}</span>${it.source ? ` <span>出处：<code>${escapeHtml(it.source)}</code></span>` : ""} ${note}
            <span class="focus-msg" data-role="msg"></span></p>
          ${edgeBlock(it)}
          <p class="idea-hist">${escapeHtml(history2)}</p>
        </article>`;
      }).join("");
      root.innerHTML = `
      <p class="isum">
        想法 ${ideas.filter((i) => !i.boundary).length} 条：已完成 <b class="ok">${done}</b>，未完成 <b>${todo}</b>；
        边界 ${ideas.filter((i) => i.boundary).length} 条：守住 <b class="ok">${held}</b>，越界 <b class="bad">${crossed}</b>。
        ${back ? `<span class="warn">${back} 条做完后退回去过。</span>` : ""}${blind ? `<span class="none">${blind} 条在 HEAD 上测不出来。</span>` : ""}
      </p>
      <div class="ilegend"><span><i class="sw idone"></i>已完成 / 守住</span><span><i class="sw ipend"></i>未完成</span><span><i class="sw icross"></i>越界</span><span><i class="sw iblind"></i>测不出来</span></div>
      <div class="ilist">${rows}</div>
      <p class="hintline" id="i-at"></p>`;
      const paint = () => {
        const c = timeline.c;
        root.querySelectorAll(".strip").forEach((s) => {
          const cur = s.querySelector(".cursor");
          cur.style.left = `${(c + 0.5) / N * 100}%`;
        });
        root.querySelectorAll(".idea").forEach((a) => {
          const it = ideas[Number(a.dataset["k"])];
          const now = a.querySelector('[data-role="now"]');
          const s = it.states[c] ?? 3;
          now.dataset["i"] = String(s);
          now.textContent = `c${c}：${wordOf(it, s)}`;
        });
        const at = root.querySelector("#i-at");
        if (at) at.textContent = `当前时间点 ${commitText(P2.commits, c)}（点任意一根条上的位置可以跳到那个 commit，调用关系图也会跟着变）`;
      };
      paint();
      timeline.onChange(paint);
      root.addEventListener("click", (e) => {
        const t = e.target;
        const strip = t.closest(".strip");
        if (strip) {
          const r = strip.getBoundingClientRect();
          const c = Math.min(N - 1, Math.max(0, Math.floor((e.clientX - r.left) / r.width * N)));
          timeline.set(c);
          return;
        }
        const btn = t.closest("button[data-focus]");
        if (btn) {
          const it = ideas[Number(btn.dataset["focus"])];
          const api = window.__laminaeGraph;
          const ok = it.edge ? api?.focusRule({ text: it.text, from: it.edge.from, to: it.edge.to, expect: it.expect }) ?? false : api?.focusTarget(it.target, ...it.evidence ?? []) ?? false;
          const msg = btn.closest(".idea").querySelector('[data-role="msg"]');
          msg.textContent = ok ? "" : it.edge ? "图上找不到规则的两端（图是按目录合并的，或对应的文件被折掉了）" : "图上没有这个节点（证据指向的不是代码文件，或被「显示测试文件」折掉了）";
          if (ok) document.querySelector("#graph-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    }
    function renderCandidates(root, p) {
      const cd = p.candidates;
      const total = cd.checklist.open + cd.checklist.done + cd.todos.total;
      if (total === 0) {
        root.innerHTML = `<p class="hintline">仓库里没有找到路线图清单（- [ ]）或 TODO 一类的标记。</p>`;
        return;
      }
      const head = p.commits.at(-1)?.sha ?? "HEAD";
      const link = (c) => {
        const where = `${escapeHtml(c.file)}:${c.line}`;
        return p.repoUrl ? `<a href="${escapeHtml(p.repoUrl)}/blob/${head}/${escapeHtml(c.file)}#L${c.line}" target="_blank" rel="noopener noreferrer" class="mono">${where}</a>` : `<span class="mono">${where}</span>`;
      };
      const items = (xs, total2, mark) => xs.length === 0 ? `<li class="none">没有</li>` : xs.slice(0, 12).map((c) => `<li>${mark(c)}${escapeHtml(c.text)} ${link(c)}</li>`).join("") + (total2 > 12 ? `<li class="none">另有 ${total2 - 12} 条没列出</li>` : "");
      const t = cd.trend;
      const max = Math.max(1, ...t.todo, ...t.open, ...t.done);
      const W = 260;
      const H2 = 44;
      const pts = (ys) => ys.map((y, i) => `${(t.at[i] / Math.max(1, N - 1) * (W - 4) + 2).toFixed(1)},${(H2 - 3 - y / max * (H2 - 8)).toFixed(1)}`).join(" ");
      const spark = t.at.length >= 2 ? `<svg class="spark" viewBox="0 0 ${W} ${H2}" width="${W}" height="${H2}" aria-label="线索数量随 commit 的变化">
             <polyline points="${pts(t.todo)}" class="l-todo"></polyline>
             <polyline points="${pts(t.open)}" class="l-open"></polyline>
             <polyline points="${pts(t.done)}" class="l-done"></polyline></svg>
           <span class="slegend"><i class="l-todo"></i>TODO ${t.todo.at(-1)}<i class="l-open"></i>未勾 ${t.open.at(-1)}<i class="l-done"></i>已勾 ${t.done.at(-1)}<em>（沿历史抽样 ${t.at.length} 个点，最高 ${max}）</em></span>` : "";
      root.innerHTML = `
      <p class="isum">路线图清单 ${cd.checklist.open + cd.checklist.done} 项（未勾 ${cd.checklist.open}，已勾 ${cd.checklist.done}），代码里 TODO 类标记 ${cd.todos.total} 处。
        <span class="none">这些只是线索：没勾不等于没做（常见的是做完直接删掉清单项），TODO 也可能早已过时。确认过的写进 <code>.laminae/ideas.json</code> 才算数。</span></p>
      <div class="spark-row">${spark}</div>
      <div class="cand-cols">
        <div><h4>路线图清单（未勾的在前）</h4><ul class="cand">${items(cd.checklist.items, cd.checklist.open + cd.checklist.done, (c) => `<span class="box" data-d="${c.done ? 1 : 0}">${c.done ? "✓" : ""}</span>`)}</ul></div>
        <div><h4>代码里的 TODO / FIXME</h4><ul class="cand">${items(cd.todos.items, cd.todos.total, () => "")}</ul></div>
      </div>`;
    }
  }

  // web/app.ts
  var P = window.__LAMINAE__;
  var $ = (sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`找不到元素：${sel}`);
    return el;
  };
  function reportError(what, err) {
    const msg = err instanceof Error ? `${err.message}` : String(err);
    const bar = document.querySelector("#readout");
    if (bar) bar.innerHTML = `<span class="pill" data-s="1">出错</span><span>${what}：${msg}</span>`;
    console.error(what, err);
  }
  window.addEventListener("error", (e) => reportError("运行时错误", e.error ?? e.message));
  window.addEventListener("unhandledrejection", (e) => reportError("未处理的 Promise", e.reason));
  var mapEl = $("#map");
  var readoutEl = $("#readout");
  var drawerEl = $("#drawer");
  var scrimEl = $("#scrim");
  var searchEl = $("#search");
  var viewsEl = $("#views");
  var N_COLS = P.commits.length;
  var N_ROWS = P.claims.length;
  var STATE_TEXT = ["真", "假", "尚未写入文档", "测不出来"];
  var escapeHtml2 = (s) => s.replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]);
  var fmtClaimed = (cl, c) => cl.kind === "number" ? `${cl.claimed[c] === null || cl.claimed[c] === void 0 ? "" : comparePrefix(cl.compare)}${cl.claimed[c] ?? "—"}` : `「${escapeHtml2(cl.claimedText[c] ?? "—")}」`;
  var fmtActual = (cl, v) => {
    if (v === null) return "—";
    if (cl.kind === "exists") return v === 1 ? "存在" : "不存在";
    if (cl.kind === "holds") return v === 1 ? "通过" : "失败";
    if (cl.kind === "stable") return v === 1 ? "没变" : "变了";
    return String(v);
  };
  var VIEWS = [
    { id: "all", label: "全部", hint: "按原顺序" },
    { id: "false", label: "仍为假", hint: "到 HEAD 还没解决的" },
    { id: "born-false", label: "写下即假", hint: "从未真过" },
    { id: "ever-false", label: "曾为假", hint: "包括已经解决的" },
    { id: "by-hiatus", label: "按 hiatus 排序", hint: "烂得最久的排最上" },
    ...P.claims.some((c) => c.impact !== "normal") ? [{ id: "by-impact", label: "按重要程度", hint: "claims.json 里标了 high 的排最上，同级按 hiatus" }] : []
  ];
  var IMPACT_RANK = { high: 0, normal: 1, low: 2 };
  var IMPACT_TEXT = { high: "重要", normal: "", low: "次要" };
  var view = "all";
  var query = "";
  var stateFilter = null;
  var order = P.claims.map((_, i) => i);
  var maxRun = (c) => c.runs.reduce((m, r) => Math.max(m, r.len), 0);
  function computeOrder() {
    const idx = P.claims.map((_, i) => i);
    let keep = () => true;
    if (view === "false") keep = (i) => P.claims[i].atHead === FALSE;
    else if (view === "born-false") keep = (i) => P.claims[i].bornFalse;
    else if (view === "ever-false") keep = (i) => P.claims[i].totalFalse > 0;
    let out = idx.filter(keep);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      out = out.filter((i) => {
        const c = P.claims[i];
        return (c.label + " " + c.file + " " + c.asserts + " " + c.verbatim).toLowerCase().includes(q);
      });
    }
    if (view === "by-hiatus") out = [...out].sort((a, b) => maxRun(P.claims[b]) - maxRun(P.claims[a]));
    if (view === "by-impact") {
      out = [...out].sort(
        (a, b) => IMPACT_RANK[P.claims[a].impact] - IMPACT_RANK[P.claims[b].impact] || maxRun(P.claims[b]) - maxRun(P.claims[a])
      );
    }
    return out;
  }
  var tickIndexes = () => tickSet(N_COLS, gridView.step);
  function renderAxis() {
    const ticks = tickIndexes();
    const frag = document.createDocumentFragment();
    const axis = document.createElement("div");
    axis.className = "axis";
    axis.appendChild(document.createElement("span"));
    for (let c = 0; c < N_COLS; c++) {
      const t = document.createElement("span");
      t.className = "tick";
      t.textContent = ticks.has(c) ? String(c) : "";
      axis.appendChild(t);
    }
    frag.appendChild(axis);
    return frag;
  }
  function renderRow(r) {
    const claim = P.claims[r];
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
  function render() {
    mapEl.style.setProperty("--cols", String(N_COLS));
    mapEl.querySelectorAll(".axis, .lb, .cell").forEach((el) => el.remove());
    const frag = document.createDocumentFragment();
    frag.appendChild(renderAxis());
    for (const r of order) frag.appendChild(renderRow(r));
    mapEl.appendChild(frag);
    if (picked) {
      mapEl.querySelector(`.cell[data-r="${picked.r}"][data-c="${picked.c}"]`)?.setAttribute("data-picked", "1");
    }
    applyStateFilter();
    renderDetails();
  }
  var detailsEl = $("#details-list");
  var detailsNoteEl = $("#details-note");
  function commitLine(c) {
    const commit = P.commits[c];
    if (!commit) return `<span class="mono">c${c}</span>`;
    return `<button type="button" class="dt-commit" data-c="${c}">c${c} <span class="mono">${commit.short}</span></button><span class="dt-subj">${escapeHtml2(commit.subject)}</span>`;
  }
  function runStory(claim, run) {
    const what = `文档写 <b>${fmtClaimed(claim, run.from)}</b>，实际 <b>${fmtActual(claim, run.actualAtStart)}</b>`;
    const start = run.bornFalse ? `写下即假：${what}` : `变假：${what}`;
    const length = `${run.len} commit / ${run.hours} 小时`;
    const end = run.to + 1 >= N_COLS ? `到 HEAD 仍为假，已挂 ${length}；${run.realityMoved ? "期间现实动过，文档没跟上" : "现实一直没动"}` : `${commitLine(run.to + 1)}<span class="dt-what">${OUTCOME_TEXT[run.outcome]}，共挂 ${length}</span>`;
    return `<li data-live="${run.censored ? "1" : "0"}">
    <div class="dt-row"><span class="dt-tag">开始</span>${commitLine(run.from)}<span class="dt-what">${start}</span></div>
    <div class="dt-row"><span class="dt-tag">结束</span>${end}</div>
  </li>`;
  }
  function renderDetails() {
    const withRuns = order.filter((r) => P.claims[r].runs.length > 0);
    const skipped = order.length - withRuns.length;
    detailsEl.innerHTML = withRuns.map((r) => {
      const c = P.claims[r];
      const where = `${escapeHtml2(c.file)}${c.line ? ":" + c.line : ""}`;
      const now = c.headClaimed === null ? "" : `文档写 ${fmtClaimed(c, N_COLS - 1)} · 实际 ${fmtActual(c, c.headActual)}`;
      return `<article class="claim" data-r="${r}">
        <header>
          <h3>${escapeHtml2(c.label)}</h3>
          ${c.impact === "normal" ? "" : `<span class="impact" data-i="${c.impact}">${IMPACT_TEXT[c.impact]}</span>`}
          <span class="mono">${where}</span>
          <span class="pill" data-s="${c.atHead}">HEAD：${STATE_TEXT[c.atHead]}</span>
          ${c.ruleMiss ? `<span class="pill" data-s="3" title="locator 从没匹配到：可能是文档没写，也可能是规则写错">规则没匹配到</span>` : ""}
          ${c.captureHint ? `<span class="pill" data-s="3" title="捕获文本多带了字符，去掉首尾标点就对得上">捕获可疑</span>` : ""}
          <span class="dt-now">${now}</span>
        </header>
        <ul class="dt-runs">${c.runs.map((run) => runStory(c, run)).join("")}</ul>
      </article>`;
    }).join("");
    detailsNoteEl.textContent = withRuns.length === 0 ? "当前视图里没有出现过假段的说法。" : skipped > 0 ? `另有 ${skipped} 条没有出现过假段，未列出。` : "";
  }
  function applyStateFilter() {
    for (const el of mapEl.querySelectorAll(".cell")) {
      const on = stateFilter === null || Number(el.dataset["s"]) === stateFilter;
      el.dataset["dim"] = on ? "0" : "1";
    }
    for (const el of mapEl.querySelectorAll(".lb")) el.dataset["dim"] = "0";
  }
  function offsetIn(el) {
    const b = el.getBoundingClientRect();
    const m = mapEl.getBoundingClientRect();
    return { top: b.top - m.top, left: b.left - m.left, w: b.width, h: b.height };
  }
  function moveBands(r, c) {
    const bandRow = $("#band-row");
    const bandCol = $("#band-col");
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
  function showReadout(r, c) {
    const claim = P.claims[r];
    const commit = P.commits[c];
    if (!claim || !commit) return;
    const s = claim.states[c] ?? ABSENT;
    const detail = s === ABSENT ? "该 commit 上文档里还没有这条说法" : s === UNMEASURED ? `文档写 <b>${fmtClaimed(claim, c)}</b>，该 commit 上测不到对应的事实` : `文档写 <b>${fmtClaimed(claim, c)}</b>，实际 <b>${fmtActual(claim, claim.actual[c] ?? null)}</b>`;
    readoutEl.innerHTML = `<span class="pill" data-s="${s}">${STATE_TEXT[s]}</span><span>${claim.label}</span><span class="sep">·</span><span>${detail}</span><span class="sep">·</span><span class="mono">${commit.short}</span><span>c${c}</span><span>${commit.date}</span><span class="subj">${escapeHtml2(commit.subject)}</span>`;
  }
  function blobUrl(sha, file, line) {
    if (!P.repoUrl) return "";
    return `${P.repoUrl}/blob/${sha}/${file.split("/").map(encodeURIComponent).join("/")}#L${line}`;
  }
  var picked = null;
  function openDrawer(r, c) {
    const claim = P.claims[r];
    const commit = P.commits[c];
    if (!claim || !commit) return;
    picked = { r, c };
    const s = claim.states[c] ?? ABSENT;
    const here = claim.verbatimRuns.find((r2) => c >= r2.from && c <= r2.to)?.text ?? null;
    const lineNo = claim.line;
    const hereText = here === null ? `<p style="color:var(--muted);font-size:12.5px;margin:0">这个 commit 上，文档里还没有这条说法。</p>` : `<div class="quote">${escapeHtml2(here)}</div>
         <p class="hint">文档写的 <b>${fmtClaimed(claim, c)}</b>　实际 <b>${fmtActual(claim, claim.actual[c] ?? null)}</b></p>
         ${s === UNMEASURED ? `<p class="hint">这个 commit 上测不到对应的事实（例如被测文件缺失或损坏），无法判断真假。</p>` : ""}`;
    const changedFromHead = here !== null && here !== claim.verbatim;
    const runsHtml = claim.runs.length ? `<ul class="runs">${claim.runs.map((run) => {
      const live = run.censored ? "1" : "0";
      const end = run.to + 1 >= N_COLS ? "到 HEAD 仍为假" : `${OUTCOME_TEXT[run.outcome]}（c${run.to + 1}）`;
      return `<li data-live="${live}">
            <div>c${run.from} 到 c${run.to}　<b>${run.len} commit / ${run.hours} 小时</b></div>
            <div class="meta">${end}</div>
          </li>`;
    }).join("")}</ul>` : `<p style="color:var(--muted);font-size:12.5px;margin:0">${N_COLS} 个 commit 上都是真的。</p>`;
    drawerEl.querySelector(".inner").innerHTML = `
    <h2>${escapeHtml2(claim.label)}</h2>
    <div class="where">
      ${blobUrl(commit.sha, claim.file, lineNo || 1) ? `<a class="mono" href="${blobUrl(commit.sha, claim.file, lineNo || 1)}" target="_blank" rel="noopener">
        ${escapeHtml2(claim.file)}${lineNo ? ":" + lineNo : ""}
      </a>` : `<span class="mono">${escapeHtml2(claim.file)}${lineNo ? ":" + lineNo : ""}</span>`}
      <span class="sep">·</span>被测事实 <code>${escapeHtml2(claim.asserts)}</code>${describeCompare(claim.compare, claim.tolerance) ? `<span class="sep">·</span>${describeCompare(claim.compare, claim.tolerance)}` : ""}
    </div>

    <section>
      <h3>文档是这么写的</h3>
      <div class="quote">${escapeHtml2(claim.verbatim)}</div>
      ${claim.inexact ? `<p class="hint inexact">措辞像是下限 / 近似（「${escapeHtml2(claim.inexact)}」），这条说法现在按严格相等比较，红色可能不是文档的本意。在 claims.json 里给它加 <code>compare</code>（gte / lte / approx）。</p>` : ""}
      ${claim.ruleMiss ? `<p class="hint inexact">这条的 locator 在整段历史里一次都没匹配到。可能是文档确实没写过这句话，也可能是 <code>${escapeHtml2(claim.locator)}</code> 写错了 —— 灰色不是「文档没写」的结论，是「没找到」。跑 <code>lookup</code> 看它到底捕获到了什么。</p>` : ""}
      ${claim.captureHint ? `<p class="hint inexact">捕获到的文本去掉首尾标点之后，「${escapeHtml2(claim.captureHint)}」在仓库里确实存在。多半是 locator 的捕获组多带了字符（比如把反引号写进了括号里），不是文档写错了。</p>` : ""}
      ${blobUrl(commit.sha, claim.file, lineNo || 1) ? `<a class="verify" href="${blobUrl(commit.sha, claim.file, lineNo || 1)}" target="_blank" rel="noopener">
        去 GitHub 核对这一行
      </a>` : ""}
    </section>

    <section>
      <h3>在 ${commit.short}（c${c}）上</h3>
      <div class="kv">
        <span class="k">状态</span><span class="v"><span class="pill" data-s="${s}">${STATE_TEXT[s]}</span></span>
      </div>
      ${hereText}
      ${changedFromHead ? `<p class="hint">注意：这一格上的措辞与 HEAD 不同，上面「文档是这么写的」显示的是 HEAD 的当前措辞。</p>` : ""}
      <div class="kv" style="margin-top:10px">
        <span class="k">提交</span><span class="v mono">${escapeHtml2(commit.subject)}</span>
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
        ${claim.evidence.length ? `<span class="k">证据文件</span><span class="v">${claim.evidence.map((f) => `<code>${escapeHtml2(f)}</code>`).join(" ")}</span>` : ""}
      </div>
    </section>
  `;
    drawerEl.dataset["open"] = "1";
    scrimEl.dataset["open"] = "1";
    mapEl.querySelectorAll('[data-picked="1"]').forEach((el) => delete el.dataset["picked"]);
    mapEl.querySelector(`.cell[data-r="${r}"][data-c="${c}"]`)?.setAttribute("data-picked", "1");
    writeHash(r, c);
  }
  function closeDrawer() {
    drawerEl.dataset["open"] = "0";
    scrimEl.dataset["open"] = "0";
  }
  function readHash() {
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
  function writeHash(r, c) {
    const next = `#r=${r}&c=${c}`;
    if (location.hash !== next) history.replaceState(null, "", next);
  }
  var playAt = -1;
  var playTimer = null;
  function setCurtain(at) {
    const curtain = $("#curtain");
    if (at < 0) {
      curtain.style.display = "none";
      return;
    }
    const firstRow = order[0];
    const cell = firstRow === void 0 ? null : mapEl.querySelector(`.cell[data-r="${firstRow}"][data-c="${Math.min(at + 1, N_COLS - 1)}"]`);
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
  function stopPlay() {
    if (playTimer !== null) {
      clearInterval(playTimer);
      playTimer = null;
    }
    playAt = -1;
    setCurtain(-1);
    $("#play").textContent = "播放";
  }
  function togglePlay() {
    if (playTimer !== null) {
      stopPlay();
      return;
    }
    const btn = $("#play");
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
        readoutEl.innerHTML = `<span class="pill">播放中</span><span>c${playAt}</span><span class="mono">${commit.short}</span><span>${commit.date}</span><span>+${commit.hours} 小时</span><span class="subj">${escapeHtml2(commit.subject)}</span>`;
      }
    }, 90);
  }
  var activeR = 0;
  var activeC = 0;
  function setActive(r, c, focus = false) {
    activeR = Math.max(0, Math.min(N_ROWS - 1, r));
    activeC = Math.max(0, Math.min(N_COLS - 1, c));
    mapEl.querySelectorAll(".cell").forEach((el2) => el2.tabIndex = -1);
    const el = mapEl.querySelector(`.cell[data-r="${activeR}"][data-c="${activeC}"]`);
    if (el) {
      el.tabIndex = 0;
      if (focus) el.focus();
    }
    if (el) {
      moveBands(activeR, activeC);
      showReadout(activeR, activeC);
    }
  }
  function renderViews() {
    viewsEl.innerHTML = VIEWS.map(
      (v) => `<button type="button" data-view="${v.id}" data-on="${v.id === view ? "1" : "0"}" title="${v.hint}">${v.label}</button>`
    ).join("");
  }
  function renderLegend() {
    const legend = $("#legend");
    const counts = [0, 0, 0, 0];
    for (const c of P.claims) for (const s of c.states) counts[s] = (counts[s] ?? 0) + 1;
    const shown = [TRUE, FALSE, ABSENT, ...(counts[UNMEASURED] ?? 0) > 0 ? [UNMEASURED] : []];
    legend.innerHTML = shown.map(
      (s) => `<button type="button" class="item" data-state="${s}" data-on="${stateFilter === s ? "1" : "0"}">
             <i class="swatch" data-s="${s}"></i>${STATE_TEXT[s]}<span class="n">${counts[s]}</span>
           </button>`
    ).join("") + `<span class="item plain">灰色 = 这个 commit 上文档里还没有这句话（不是没做完，也不是假）</span><span class="item plain">左侧红点 = 写下即假，从未真过</span>`;
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
      miss.length > 0 ? `<div><b>${miss.length} 条说法的 locator 在整段历史里一次都没匹配到。</b>灰色不代表「文档没写」，也可能是规则写错。先跑 <code>lookup</code> 看它们到底捕获到了什么：${miss.map((c) => `<code>${escapeHtml2(c.id)}</code>`).join("、")}</div>` : "",
      suspect.length > 0 ? `<div><b>${suspect.length} 条说法判假，但捕获的文本多带了字符。</b>去掉首尾标点之后路径确实存在，多半是 locator 的捕获组写错了，不是文档写错：${suspect.map((c) => `<code>${escapeHtml2(c.id)}</code>→<code>${escapeHtml2(c.captureHint ?? "")}</code>`).join("、")}</div>` : ""
    ].join("");
  }
  function wire() {
    mapEl.addEventListener("mouseover", (e) => {
      const t = e.target;
      if (!t.classList.contains("cell")) return;
      moveBands(Number(t.dataset["r"]), Number(t.dataset["c"]));
      showReadout(Number(t.dataset["r"]), Number(t.dataset["c"]));
    });
    mapEl.addEventListener("mouseleave", () => {
      if (playTimer === null) moveBands(null, null);
    });
    mapEl.addEventListener("click", (e) => {
      const t = e.target;
      if (!t.classList.contains("cell")) return;
      stopPlay();
      const r = Number(t.dataset["r"]);
      const c = Number(t.dataset["c"]);
      setActive(r, c);
      openDrawer(r, c);
    });
    mapEl.addEventListener("focusin", (e) => {
      const t = e.target;
      if (!t.classList.contains("cell")) return;
      activeR = Number(t.dataset["r"]);
      activeC = Number(t.dataset["c"]);
      moveBands(activeR, activeC);
      showReadout(activeR, activeC);
    });
    mapEl.addEventListener("keydown", (e) => {
      const t = e.target;
      if (!t.classList.contains("cell")) return;
      const d = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
        Home: [0, -activeC],
        End: [0, N_COLS - 1 - activeC]
      };
      const move = d[e.key];
      if (move) {
        e.preventDefault();
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
    $("#close").addEventListener("click", closeDrawer);
    scrimEl.addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDrawer();
    });
    searchEl.addEventListener("input", () => {
      query = searchEl.value;
      order = computeOrder();
      render();
    });
    viewsEl.addEventListener("click", (e) => {
      const t = e.target.closest("[data-view]");
      if (!t) return;
      view = t.dataset["view"] ?? "all";
      renderViews();
      order = computeOrder();
      render();
      const first = order[0];
      if (first !== void 0) setActive(first, activeC);
    });
    $("#legend").addEventListener("click", (e) => {
      const t = e.target.closest("[data-state]");
      if (!t) return;
      const s = Number(t.dataset["state"]);
      stateFilter = stateFilter === s ? null : s;
      renderLegend();
      applyStateFilter();
    });
    detailsEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".dt-commit");
      const art = btn?.closest(".claim");
      if (!btn || !art) return;
      const r = Number(art.dataset["r"]);
      const c = Number(btn.dataset["c"]);
      setActive(r, c);
      openDrawer(r, c);
    });
    $("#outcomes").addEventListener("click", (e) => {
      const t = e.target.closest("[data-outcome]");
      if (!t) return;
      const want = t.dataset["outcome"];
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
    const themeBtn = $("#theme");
    const order3 = ["auto", "light", "dark"];
    const label = { auto: "跟系统", light: "亮色", dark: "暗色" };
    const saved = localStorage.getItem("laminae-theme");
    const initial = deep?.theme ?? saved;
    if (initial && order3.includes(initial)) document.documentElement.dataset["theme"] = initial;
    const sync = () => {
      const cur = document.documentElement.dataset["theme"] ?? "auto";
      themeBtn.textContent = `主题：${label[cur]}`;
    };
    sync();
    themeBtn.addEventListener("click", () => {
      const cur = document.documentElement.dataset["theme"] ?? "auto";
      const next = order3[(order3.indexOf(cur) + 1) % order3.length];
      document.documentElement.dataset["theme"] = next;
      localStorage.setItem("laminae-theme", next);
      sync();
    });
    $("#play").addEventListener("click", togglePlay);
    $("#print").addEventListener("click", () => window.print());
    window.addEventListener("resize", () => {
      moveBands(activeR, activeC);
      if (playTimer !== null) setCurtain(playAt);
    });
  }
  var deep = readHash();
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
  timeline.c = N_COLS - 1;
  if (P.graph) initGraph(P);
  initIdeas(P);
})();
