/**
 * laminae —— 想法、边界与线索（浏览器端）
 *
 * 想法与边界：每条一根时间条，横轴是 commit，颜色是「证据在那个 commit 上满不满足」。
 * 条下面直接写出证据是什么、什么时候满足、有没有退回去，不用点开。
 * 线索：路线图清单与 TODO，只列出来并画数量趋势，不替人判定。
 *
 * 时间点与调用关系图共用：点条上的任意位置，图也跳到那个 commit。
 */
import type { Candidate, IdeaTimeline, Payload } from "../src/core/types.ts";
import { commitText, escapeHtml, timeline } from "./shared.ts";
import type { GraphApi } from "./shared.ts";

const WORD = {
  idea: ["已完成", "未完成", "", "测不出来"],
  boundary: ["守住", "越界", "", "测不出来"],
} as const;

const wordOf = (i: IdeaTimeline, s: number): string => WORD[i.boundary ? "boundary" : "idea"][s] ?? "";

/** 状态序列折成区间，「测不出来」单独成段 */
function segments(states: readonly number[]): { from: number; to: number; s: number }[] {
  const out: { from: number; to: number; s: number }[] = [];
  for (const [i, s] of states.entries()) {
    const last = out.at(-1);
    if (last && last.s === s) last.to = i;
    else out.push({ from: i, to: i, s });
  }
  return out;
}

export function initIdeas(P: Payload): void {
  const N = P.commits.length;
  const ideasRoot = document.querySelector<HTMLElement>("#ideas-body");
  const candRoot = document.querySelector<HTMLElement>("#cand-body");

  if (ideasRoot && P.ideas && P.ideas.length > 0) renderIdeas(ideasRoot, P.ideas);
  if (candRoot && P.candidates) renderCandidates(candRoot, P);

  /** 引用边界在 HEAD 上的实况：哪几条引用越界了，或者为什么判不了。其它想法没有这一块 */
  function edgeBlock(it: IdeaTimeline): string {
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

  function renderIdeas(root: HTMLElement, ideas: IdeaTimeline[]): void {
    const done = ideas.filter((i) => !i.boundary && i.atHead === 0).length;
    const todo = ideas.filter((i) => !i.boundary && i.atHead === 1).length;
    const held = ideas.filter((i) => i.boundary && i.atHead === 0).length;
    const crossed = ideas.filter((i) => i.boundary && i.atHead === 1).length;
    const back = ideas.filter((i) => i.regressions > 0).length;
    const blind = ideas.filter((i) => i.atHead === 3).length;

    const hasGraph = Boolean(P.graph);

    const rows = ideas
      .map((it, k) => {
        const segs = segments(it.states);
        const rects = segs
          .map((sg) => `<rect x="${sg.from}" y="0" width="${sg.to - sg.from + 1}" height="1" class="ir" data-i="${sg.s}" data-b="${it.boundary ? 1 : 0}"></rect>`)
          .join("");

        const history = segs
          .slice(0, 8)
          .map((sg) => {
            const c = P.commits[sg.from];
            const when = `c${sg.from}${c ? `（${c.date}）` : ""}`;
            return sg.to === N - 1 ? `${when} 起至今${wordOf(it, sg.s)}` : `${when} → c${sg.to} ${wordOf(it, sg.s)}`;
          })
          .join("；") + (segs.length > 8 ? "；……" : "");

        const note =
          it.regressions > 0
            ? `<span class="warn">做完之后又退回去过 ${it.regressions} 次</span>`
            : it.firstMet < 0
              ? it.boundary
                ? `<span class="warn">从没守住过</span>`
                : `<span class="none">从未满足</span>`
              : "";

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
          <p class="idea-hist">${escapeHtml(history)}</p>
        </article>`;
      })
      .join("");

    root.innerHTML = `
      <p class="isum">
        想法 ${ideas.filter((i) => !i.boundary).length} 条：已完成 <b class="ok">${done}</b>，未完成 <b>${todo}</b>；
        边界 ${ideas.filter((i) => i.boundary).length} 条：守住 <b class="ok">${held}</b>，越界 <b class="bad">${crossed}</b>。
        ${back ? `<span class="warn">${back} 条做完后退回去过。</span>` : ""}${blind ? `<span class="none">${blind} 条在 HEAD 上测不出来。</span>` : ""}
      </p>
      <div class="ilegend"><span><i class="sw idone"></i>已完成 / 守住</span><span><i class="sw ipend"></i>未完成</span><span><i class="sw icross"></i>越界</span><span><i class="sw iblind"></i>测不出来</span></div>
      <div class="ilist">${rows}</div>
      <p class="hintline" id="i-at"></p>`;

    const paint = (): void => {
      const c = timeline.c;
      root.querySelectorAll<HTMLElement>(".strip").forEach((s) => {
        const cur = s.querySelector<HTMLElement>(".cursor")!;
        cur.style.left = `${((c + 0.5) / N) * 100}%`;
      });
      root.querySelectorAll<HTMLElement>(".idea").forEach((a) => {
        const it = ideas[Number(a.dataset["k"])]!;
        const now = a.querySelector<HTMLElement>('[data-role="now"]')!;
        const s = it.states[c] ?? 3;
        now.dataset["i"] = String(s);
        now.textContent = `c${c}：${wordOf(it, s)}`;
      });
      const at = root.querySelector<HTMLElement>("#i-at");
      if (at) at.textContent = `当前时间点 ${commitText(P.commits, c)}（点任意一根条上的位置可以跳到那个 commit，调用关系图也会跟着变）`;
    };
    paint();
    timeline.onChange(paint);

    root.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const strip = t.closest<HTMLElement>(".strip");
      if (strip) {
        const r = strip.getBoundingClientRect();
        const c = Math.min(N - 1, Math.max(0, Math.floor(((e as MouseEvent).clientX - r.left) / r.width * N)));
        timeline.set(c);
        return;
      }
      const btn = t.closest<HTMLButtonElement>("button[data-focus]");
      if (btn) {
        const it = ideas[Number(btn.dataset["focus"])]!;
        const api = (window as unknown as { __laminaeGraph?: GraphApi }).__laminaeGraph;
        const ok = it.edge
          ? api?.focusRule({ text: it.text, from: it.edge.from, to: it.edge.to, expect: it.expect }) ?? false
          : api?.focusTarget(it.target, ...(it.evidence ?? [])) ?? false;
        const msg = btn.closest(".idea")!.querySelector<HTMLElement>('[data-role="msg"]')!;
        msg.textContent = ok ? "" : it.edge ? "图上找不到规则的两端（图是按目录合并的，或对应的文件被折掉了）" : "图上没有这个节点（证据指向的不是代码文件，或被「显示测试文件」折掉了）";
        if (ok) document.querySelector("#graph-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }

  function renderCandidates(root: HTMLElement, p: Payload): void {
    const cd = p.candidates!;
    const total = cd.checklist.open + cd.checklist.done + cd.todos.total;
    if (total === 0) {
      root.innerHTML = `<p class="hintline">仓库里没有找到路线图清单（- [ ]）或 TODO 一类的标记。</p>`;
      return;
    }
    const head = p.commits.at(-1)?.sha ?? "HEAD";
    const link = (c: Candidate): string => {
      const where = `${escapeHtml(c.file)}:${c.line}`;
      return p.repoUrl ? `<a href="${escapeHtml(p.repoUrl)}/blob/${head}/${escapeHtml(c.file)}#L${c.line}" target="_blank" rel="noopener noreferrer" class="mono">${where}</a>` : `<span class="mono">${where}</span>`;
    };
    const items = (xs: Candidate[], total: number, mark: (c: Candidate) => string): string =>
      xs.length === 0
        ? `<li class="none">没有</li>`
        : xs.slice(0, 12).map((c) => `<li>${mark(c)}${escapeHtml(c.text)} ${link(c)}</li>`).join("") +
          (total > 12 ? `<li class="none">另有 ${total - 12} 条没列出</li>` : "");

    // 趋势：三条线共用一个纵轴
    const t = cd.trend;
    const max = Math.max(1, ...t.todo, ...t.open, ...t.done);
    const W = 260;
    const H = 44;
    const pts = (ys: number[]): string =>
      ys.map((y, i) => `${((t.at[i]! / Math.max(1, N - 1)) * (W - 4) + 2).toFixed(1)},${(H - 3 - (y / max) * (H - 8)).toFixed(1)}`).join(" ");
    const spark =
      t.at.length >= 2
        ? `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-label="线索数量随 commit 的变化">
             <polyline points="${pts(t.todo)}" class="l-todo"></polyline>
             <polyline points="${pts(t.open)}" class="l-open"></polyline>
             <polyline points="${pts(t.done)}" class="l-done"></polyline></svg>
           <span class="slegend"><i class="l-todo"></i>TODO ${t.todo.at(-1)}<i class="l-open"></i>未勾 ${t.open.at(-1)}<i class="l-done"></i>已勾 ${t.done.at(-1)}<em>（沿历史抽样 ${t.at.length} 个点，最高 ${max}）</em></span>`
        : "";

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
