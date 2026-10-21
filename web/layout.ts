/**
 * laminae —— 引用关系图的分层布局（纯函数，不碰 DOM，可以直接在 node 里测）
 *
 * 不引外部库：引用关系大多是「入口 → 工具」的有向图，用最简单的分层就够读：
 *   - 引用别人的在左，被引用的在右（layer = 离入口最长的路径）
 *   - 同一层里按「邻居的平均位置」排，减少线条交叉；没有任何引用的孤立节点排在每层最后
 *   - 有环时把环上最后碰到的那条边忽略，只用来定层，画的时候照常画
 */

export interface LayoutEdge {
  s: number;
  t: number;
}

export interface Layout {
  /** 每个节点所在的层（从左到右） */
  layer: number[];
  /** 每个节点在本层里的行号（从上到下） */
  row: number[];
  layers: number;
  /** 各层里最多有几行 */
  rows: number;
}

export function layoutGraph(ids: readonly string[], edges: readonly LayoutEdge[]): Layout {
  const n = ids.length;
  const out: number[][] = Array.from({ length: n }, () => []);
  const inn: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    if (e.s === e.t || e.s < 0 || e.t < 0 || e.s >= n || e.t >= n) continue;
    out[e.s]!.push(e.t);
    inn[e.t]!.push(e.s);
  }

  // 1. 去环：深度优先，碰到回边就忽略它（只影响分层）
  const dagOut: number[][] = Array.from({ length: n }, () => []);
  const color = new Uint8Array(n); // 0 未访问 1 在栈上 2 完成
  for (let root = 0; root < n; root++) {
    if (color[root]) continue;
    const stack: [number, number][] = [[root, 0]];
    color[root] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const [v, k] = top;
      const next = out[v]![k];
      if (next === undefined) {
        color[v] = 2;
        stack.pop();
        continue;
      }
      top[1]++;
      if (color[next] === 1) continue; // 回边
      dagOut[v]!.push(next);
      if (color[next] === 0) {
        color[next] = 1;
        stack.push([next, 0]);
      }
    }
  }

  // 2. 最长路径分层（Kahn 拓扑序）
  const indeg = new Array<number>(n).fill(0);
  for (let v = 0; v < n; v++) for (const t of dagOut[v]!) indeg[t] = (indeg[t] ?? 0) + 1;
  const layer = new Array<number>(n).fill(0);
  const queue: number[] = [];
  for (let v = 0; v < n; v++) if (indeg[v] === 0) queue.push(v);
  for (let qi = 0; qi < queue.length; qi++) {
    const v = queue[qi]!;
    for (const t of dagOut[v]!) {
      layer[t] = Math.max(layer[t]!, layer[v]! + 1);
      indeg[t] = (indeg[t] ?? 0) - 1;
      if (indeg[t] === 0) queue.push(t);
    }
  }

  const layers = n === 0 ? 0 : Math.max(...layer) + 1;
  const connected = (v: number): boolean => out[v]!.length + inn[v]!.length > 0;

  // 3. 层内排序：先按名字，再做几轮「邻居平均位置」
  const cols: number[][] = Array.from({ length: layers }, () => []);
  const order = [...Array(n).keys()].sort((a, b) => (ids[a]! < ids[b]! ? -1 : ids[a]! > ids[b]! ? 1 : 0));
  for (const v of order) cols[layer[v]!]!.push(v);

  const pos = new Array<number>(n).fill(0);
  const reindex = (): void => {
    for (const col of cols) col.forEach((v, i) => (pos[v] = i));
  };
  reindex();

  const sweep = (c: number, useIn: boolean): void => {
    const col = cols[c]!;
    const key = new Map<number, number>();
    for (const v of col) {
      const nb = (useIn ? inn[v]! : out[v]!).concat(useIn ? out[v]! : inn[v]!);
      if (!connected(v)) key.set(v, Infinity);
      else if (nb.length === 0) key.set(v, pos[v]!);
      else key.set(v, nb.reduce((s, u) => s + pos[u]!, 0) / nb.length);
    }
    col.sort((a, b) => key.get(a)! - key.get(b)! || pos[a]! - pos[b]!);
    col.forEach((v, i) => (pos[v] = i));
  };
  for (let round = 0; round < 4; round++) {
    for (let c = 1; c < layers; c++) sweep(c, true);
    for (let c = layers - 2; c >= 0; c--) sweep(c, false);
  }

  const row = new Array<number>(n).fill(0);
  for (const col of cols) col.forEach((v, i) => (row[v] = i));
  return { layer, row, layers, rows: cols.reduce((m, c) => Math.max(m, c.length), 0) };
}

/** 给一组路径取最短且互不相同的末尾几段当标签，例如两个 index.js 会变成 lib/index.js 与 src/index.js */
export function shortLabels(ids: readonly string[]): string[] {
  const parts = ids.map((id) => id.split("/"));
  const depth = new Array<number>(ids.length).fill(1);
  const label = (i: number): string => parts[i]!.slice(-depth[i]!).join("/");
  for (let guard = 0; guard < 8; guard++) {
    const seen = new Map<string, number[]>();
    for (let i = 0; i < ids.length; i++) {
      const l = label(i);
      seen.set(l, [...(seen.get(l) ?? []), i]);
    }
    let changed = false;
    for (const group of seen.values()) {
      if (group.length < 2) continue;
      for (const i of group) {
        if (depth[i]! < parts[i]!.length) {
          depth[i]!++;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return ids.map((_, i) => label(i));
}

/* ── 按目录分组的布局：同一目录的模块放进同一张卡片，卡片按列排（瀑布流） ── */

export interface CardLayout {
  /** 每个节点左上角的位置，下标与 ids 一致 */
  x: number[];
  y: number[];
  cards: { title: string; x: number; y: number; w: number; h: number }[];
  width: number;
  height: number;
}

const CARD_PAD = 10;
const CARD_HEAD = 26;
/** 卡片之间留出走线的通道：同一列里的引用从节点右边绕出去，需要这点空间 */
const CARD_GAP = 44;
const NODE_GAP = 6;
const MARGIN = 14;
/** 右边多留一截，最右一列的绕线才不会被画布裁掉 */
const MARGIN_R = 40;

export function layoutCards(ids: readonly string[], availW: number, nodeW: number, nodeH: number): CardLayout {
  const cardW = nodeW + CARD_PAD * 2;
  const cols = Math.max(1, Math.floor((availW - MARGIN - MARGIN_R + CARD_GAP) / (cardW + CARD_GAP)));

  const groups = new Map<string, number[]>();
  ids.forEach((id, i) => {
    const p = id.lastIndexOf("/");
    const key = p < 0 ? "" : id.slice(0, p);
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  });

  const colH = new Array<number>(cols).fill(MARGIN);
  const x = new Array<number>(ids.length).fill(0);
  const y = new Array<number>(ids.length).fill(0);
  const cards: CardLayout["cards"] = [];

  for (const key of [...groups.keys()].sort()) {
    const members = groups.get(key)!.sort((a, b) => (ids[a]! < ids[b]! ? -1 : 1));
    const h = CARD_HEAD + members.length * (nodeH + NODE_GAP) - NODE_GAP + CARD_PAD * 2;
    let col = 0;
    for (let c = 1; c < cols; c++) if (colH[c]! < colH[col]!) col = c;
    const x0 = MARGIN + col * (cardW + CARD_GAP);
    const y0 = colH[col]!;
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
    height: Math.max(...colH) - CARD_GAP + MARGIN,
  };
}
