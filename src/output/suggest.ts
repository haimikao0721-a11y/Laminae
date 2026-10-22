/**
 * 从 Markdown 里挑可能值得核验的句子，打成 claims 草稿。
 *
 * 只看字面，不测量事实。草稿里的 fact 经常是占位，要人改过再放进 claims.json。
 * 直接运行：在目标仓库里 `node <laminae>/src/suggest.ts`，打印 JSON，不写文件。
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseGrepLine } from "../ideas/candidates.ts";
import { assertBoundRepo, REPO } from "../core/config.ts";

/** 只用来把可能相关的行捞出来。真正匹配仍用下面的 JS 正则，git 没有先行断言 */
const GREP = "[0-9][0-9,]*[[:space:]]*\\+|(约|大约|大概|about|around|approximately)[[:space:]]*[0-9]|(npm|pnpm|yarn)[[:space:]]+run[[:space:]]|共[[:space:]]*[0-9]";

export interface ClaimDraft {
  id: string;
  label: string;
  file: string;
  locator: string;
  fact: { type: string; file?: string; path?: string; glob?: string };
  compare?: "gte" | "approx";
  /** 为什么挑出来，以及人还要改什么 */
  note: string;
}

const RULES: { re: RegExp; compare?: "gte" | "approx"; note: string; fact: ClaimDraft["fact"] }[] = [
  { re: /(\d[\d,]*)\s*\+(?!\d)/, compare: "gte", note: "像是下限。fact 还是占位，改成实际要数的文件或 JSON", fact: { type: "count-files", glob: "**/*" } },
  { re: /(?:约|大约|大概|about|around|approximately)\s*(\d[\d,]*)/i, compare: "approx", note: "像是近似。默认容差 5%，fact 仍要改", fact: { type: "count-files", glob: "**/*" } },
  { re: /(?:npm|pnpm|yarn)\s+run\s+([\w:.-]+)/, note: "像是脚本名。默认到仓库根的 package.json，monorepo 要改 file", fact: { type: "json-has-key", file: "package.json", path: "scripts" } },
  { re: /共\s*(\d[\d,]*)(?!\s*\+)/, note: "像是精确数量。如果其实是下限，加 compare: gte", fact: { type: "count-files", glob: "**/*" } },
];

function slug(s: string): string {
  const ascii = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return ascii.slice(0, 40) || "claim";
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 捕获组前后各留几个字，避免整篇里到处都是同一个数字 */
function locatorOf(line: string, m: RegExpExecArray): string {
  const cap = m[1] ?? m[0];
  const from = Math.max(0, m.index);
  const to = Math.min(line.length, m.index + m[0].length);
  const around = line.slice(Math.max(0, from - 8), Math.min(line.length, to + 8));
  const at = around.indexOf(cap);
  if (at < 0) return `(${esc(cap)})`;
  return `${esc(around.slice(0, at))}(${esc(cap)})${esc(around.slice(at + cap.length))}`;
}

/**
 * 从一个 Markdown 文件里挑草稿。同一条正则只取第一次出现。
 * lineNos 与 text 的每一行对齐（1 起）。git grep 只交回命中的行时用它，免得行号变成过滤后的序号。
 */
export function suggestClaims(file: string, text: string, lineNos?: readonly number[]): ClaimDraft[] {
  const out: ClaimDraft[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (const rule of RULES) {
    for (const [i, line] of lines.entries()) {
      const m = rule.re.exec(line);
      if (!m) continue;
      const locator = locatorOf(line, m);
      if (seen.has(locator)) break;
      seen.add(locator);
      const lineNo = lineNos?.[i] ?? i + 1;
      out.push({
        id: slug(`${path.posix.basename(file)}-${lineNo}-${m[1] ?? "x"}`),
        label: line.trim().slice(0, 40),
        file,
        locator,
        fact: rule.fact,
        ...(rule.compare ? { compare: rule.compare } : {}),
        note: `${rule.note}（${file}:${lineNo}）`,
      });
      break;
    }
  }
  return out;
}

/** git grep 命中的行，按文件交给 suggestClaims。没有命中返回空数组，仓库不是 git 时抛错 */
export function draftsFromGrep(root: string): ClaimDraft[] {
  let raw = "";
  try {
    raw = execFileSync("git", ["-c", "core.quotepath=false", "-C", root, "grep", "-n", "-I", "-i", "-E", GREP, "HEAD", "--", "*.md"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    if (err.status === 1) raw = typeof err.stdout === "string" ? err.stdout : "";
    else throw e;
  }
  const byFile = new Map<string, { no: number; text: string }[]>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const hit = parseGrepLine("HEAD", line);
    if (!hit) continue;
    const rows = byFile.get(hit.file) ?? [];
    rows.push({ no: hit.line, text: hit.text });
    byFile.set(hit.file, rows);
  }
  const drafts: ClaimDraft[] = [];
  for (const [file, rows] of byFile) {
    drafts.push(...suggestClaims(file, rows.map((r) => r.text).join("\n"), rows.map((r) => r.no)));
  }
  return drafts;
}

function main(): void {
  assertBoundRepo();
  console.log(JSON.stringify(draftsFromGrep(REPO), null, 2));
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === path.resolve(fileURLToPath(import.meta.url))) main();
