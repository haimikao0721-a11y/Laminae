/**
 * laminae —— 跨仓库汇总页
 *
 *   node <laminae>/scripts/run.ts --repos a,b,c      会自动生成
 *
 * 汇总页是一张索引，不把多个仓库的网格叠在一起 —— 各仓库的 commit 数不同，
 * c27 在 A 仓库和在 B 仓库不是同一件事，叠成一张图没有意义。
 * 这里做的是：每个仓库一行，点进去看它自己的那张完整状态图。
 *
 * 产物：<父目录>/.laminae/runs/<id>/index.html
 */
import fs from "node:fs";
import path from "node:path";
import { OUTCOME_TEXT } from "../core/types.ts";
import type { Outcome, Payload } from "../core/types.ts";

export interface IndexRepo {
  name: string;
  abs: string;
  htmlPath: string;
  payloadPath: string;
}

export interface IndexOptions {
  /** 多仓库所在的父目录。汇总页写到这里 */
  parent: string;
  runId: string;
  repos: readonly IndexRepo[];
}

interface Row {
  repo: IndexRepo;
  payload: Payload | null;
  problem: string | null;
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]!);

/** 跨仓库的假段。用来回答「所有仓库里挂了最久的是哪一条」 */
interface AcrossRun {
  repo: string;
  repoAbs: string;
  claimLabel: string;
  claimIndex: number;
  from: number;
  to: number;
  len: number;
  hours: number;
  outcome: Outcome;
  censored: boolean;
  htmlPath: string;
}

function collectRuns(row: Row): AcrossRun[] {
  if (!row.payload) return [];
  const out: AcrossRun[] = [];
  for (const [i, c] of row.payload.claims.entries()) {
    for (const run of c.runs) {
      out.push({
        repo: row.repo.name,
        repoAbs: row.repo.abs,
        claimLabel: c.label,
        claimIndex: i,
        from: run.from,
        to: run.to,
        len: run.len,
        hours: run.hours,
        outcome: run.outcome,
        censored: run.censored,
        htmlPath: row.repo.htmlPath,
      });
    }
  }
  return out;
}

/** 从 index.html 跳到某个仓库报告里的具体一格。用相对路径，整包搬走也能用 */
function cellLink(r: AcrossRun, fromDir: string): string {
  const rel = path.relative(fromDir, r.htmlPath).split(path.sep).join("/");
  return `${encodeURI(rel)}#r=${r.claimIndex}&c=${r.from}`;
}

const median = (a: number[]): number => {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

export function buildIndex(opts: IndexOptions): string {
  const outDir = path.join(opts.parent, ".laminae", "runs", opts.runId);
  fs.mkdirSync(outDir, { recursive: true });

  const rows: Row[] = opts.repos.map((repo) => {
    try {
      const payload = JSON.parse(fs.readFileSync(repo.payloadPath, "utf8")) as Payload;
      return { repo, payload, problem: null };
    } catch (e) {
      return { repo, payload: null, problem: (e as Error).message };
    }
  });

  const ok = rows.filter((r): r is Row & { payload: Payload } => r.payload !== null);
  const across = ok.flatMap(collectRuns).sort((a, b) => b.len - a.len);

  const totalClaims = ok.reduce((s, r) => s + r.payload.summary.claimCount, 0);
  const totalFalseHead = ok.reduce((s, r) => s + r.payload.summary.falseAtHead, 0);
  const totalRuns = across.length;
  const hanging = across.filter((r) => r.censored).length;
  const medHiatus = median(across.map((r) => r.len));

  const stat = (k: string, v: string, unit?: string): string =>
    `<div class="stat"><span class="k">${esc(k)}</span><span class="v">${esc(v)}${unit ? ` <small>${esc(unit)}</small>` : ""}</span></div>`;

  const repoRows = rows
    .map((r) => {
      if (!r.payload) {
        return `<tr class="bad"><td>${esc(r.repo.name)}</td><td colspan="6">读不到 payload.json：${esc(r.problem ?? "")}</td></tr>`;
      }
      const s = r.payload.summary;
      const href = encodeURI(path.relative(outDir, r.repo.htmlPath).split(path.sep).join("/"));
      // 生存曲线没降到 50% 时 median 是 null，不能当成 0
      const med = s.survival.medianCommits === null ? "无法估计" : String(s.survival.medianCommits);
      return `<tr>
        <td><a href="${href}">${esc(r.repo.name)}</a></td>
        <td class="n">${s.claimCount}</td>
        <td class="n">${s.commitCount}</td>
        <td class="n">${s.everFalse}</td>
        <td class="n ${s.falseAtHead > 0 ? "hot" : ""}">${s.falseAtHead}</td>
        <td class="n">${med}</td>
        <td>${s.bornFalse > 0 ? `${s.bornFalse} 条从未真过` : "—"}</td>
      </tr>`;
    })
    .join("");

  const worst = across.slice(0, 20);
  const worstRows = worst.length
    ? worst
        .map((r) => {
          const href = cellLink(r, outDir);
          const end = r.censored ? "到 HEAD 仍为假" : OUTCOME_TEXT[r.outcome];
          return `<tr>
            <td class="n">${r.len}</td>
            <td class="n">${r.hours}</td>
            <td><a href="${href}">${esc(r.repo)}</a></td>
            <td>${esc(r.claimLabel)}</td>
            <td class="muted">c${r.from}–c${r.to}</td>
            <td class="${r.censored ? "hot" : ""}">${esc(end)}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="6" class="muted">所有仓库都没有出现过假段。</td></tr>`;

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>laminae — ${opts.repos.length} 个仓库 · ${esc(opts.runId)}</title>
<style>
:root{--bg:#fff;--panel:#f7f8fa;--panel2:#eef1f5;--bd:#e3e6ec;--bd2:#cbd1db;--tx:#1a1d23;--mu:#6b7280;--ac:#2563eb;--hot:#dc2626;--ok:#16a34a}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--panel:#171a21;--panel2:#1d222b;--bd:#262b36;--bd2:#3a424f;--tx:#e6e8ee;--mu:#9aa3b2;--ac:#7aa2f7;--hot:#ef4444;--ok:#22c55e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1100px;margin:0 auto;padding:26px 24px 60px}
h1{margin:0;font-size:20px;font-weight:650;letter-spacing:.2px}
.sub{margin:4px 0 0;color:var(--mu);font-size:13px}
.stats{display:flex;flex-wrap:wrap;background:var(--panel);border:1px solid var(--bd);border-radius:10px;padding:0 18px;margin:20px 0}
.stat{padding:12px 26px 12px 0;margin-right:26px;border-right:1px solid var(--bd)}
.stat:last-child{border-right:0}
.stat .k{display:block;color:var(--mu);font-size:12px}
.stat .v{display:block;font-size:19px;font-weight:650;font-variant-numeric:tabular-nums}
.stat .v small{font-size:12px;font-weight:400;color:var(--mu)}
h2{font-size:14px;font-weight:600;margin:28px 0 10px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--bd)}
th{color:var(--mu);font-weight:600;font-size:12px}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.muted{color:var(--mu)}
.hot{color:var(--hot);font-weight:600}
tr.bad td{color:var(--hot)}
a{color:var(--ac);text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--ac) 35%,transparent)}
a:hover{border-bottom-color:var(--ac)}
.note{color:var(--mu);font-size:12px;margin-top:8px;line-height:1.7}
@media print{.wrap{padding:0}@page{size:A4 landscape;margin:10mm}}
</style>
</head>
<body>
<div class="wrap">
<h1>laminae — 跨仓库汇总</h1>
<p class="sub">运行 id ${esc(opts.runId)}　·　${opts.repos.length} 个仓库　·　每个仓库的报告是它自己的一张状态图</p>

<div class="stats">
${stat("说法总数", String(totalClaims), `跨 ${ok.length} 个仓库`)}
${stat("HEAD 仍为假", String(totalFalseHead), "所有仓库相加")}
${stat("假段总数", String(totalRuns), `仍挂着 ${hanging} 段`)}
${stat("中位 hiatus", String(medHiatus), "commit，跨仓库取中位")}
</div>

<h2>各仓库</h2>
<table>
<thead><tr><th>仓库</th><th class="n">说法</th><th class="n">commit</th><th class="n">曾为假</th><th class="n">HEAD 仍为假</th><th class="n">中位 hiatus</th><th>备注</th></tr></thead>
<tbody>${repoRows}</tbody>
</table>
${rows.length !== ok.length ? `<p class="note">有 ${rows.length - ok.length} 个仓库没读出 payload，见上表红字。</p>` : ""}

<h2>所有仓库里挂得最久的 ${worst.length} 段</h2>
<table>
<thead><tr><th class="n">commit</th><th class="n">小时</th><th>仓库</th><th>说法</th><th>区间</th><th>怎么收场的</th></tr></thead>
<tbody>${worstRows}</tbody>
</table>

<p class="note">
中位 hiatus 是把所有仓库的假段混在一起取的中位数，不是各仓库中位数再平均——后者会让只有一两条说法的小仓库权重过大。<br>
点仓库名进它自己的报告；点假段的仓库名会直接定位到那一格。<br>
这些数字只描述观测到的区间，不等于问题在现实中恰好持续了那么久。
</p>
</div>
</body>
</html>
`;

  const outPath = path.join(outDir, "index.html");
  fs.writeFileSync(outPath, html, "utf8");
  return outPath;
}
