/**
 * laminae —— 说法体检
 *
 * 有些说法本身写不出来，但工具不会报错，而是**静默判成「尚未写入文档」**。
 * 这比报错更糟：读起来像「文档没说这件事」，实际是这条说法没法测。
 *
 * 真实例子（click 上踩的）：
 *
 *   locator: "## Version (\\d+\\.\\d+\\.\\d+)"     捕获 "8.6.0"
 *   fact:    { "type": "regex-count", ... }
 *
 * 数字类事实要拿捕获文本去比数，而 "8.6.0" 读不成数 → claimed 变成 null →
 * 状态落到「尚未写入文档」。文档明明白白写着 8.6.0，却被说成没写。
 *
 * 另一类同样安静：fact 里写该类型不用的字段。parseFact 会把多余字段丢掉，
 * 于是「我写了 compare: gte」这件事根本不会发生，也不会有任何提示。
 *
 * 所以这里在跑之前先体检一遍。**只报警告，不改判定** —— 判定归判定，
 * 说法写得对不对是另一回事，两件事不能混。
 */
import fs from "node:fs";
import { parseClaimedNumber } from "../judge/classify.ts";
import type { ClaimDef } from "../core/types.ts";
import { isObserved, isReferential } from "./facts.ts";

export interface ClaimWarning {
  id: string;
  label: string;
  level: "error" | "warn";
  code: "ignored-fact-field" | "capture-not-number" | "locator-miss";
  /** 会原样出现在报告里，所以要能被人看懂、能照着改 */
  message: string;
}

/** 每种事实认哪些字段。parseFact 不认的会被静默丢掉，所以要在这里点名 */
const FIELDS: Record<string, readonly string[]> = {
  "count-files": ["type", "glob"],
  "json-length": ["type", "file", "path"],
  "json-number": ["type", "file", "path"],
  "regex-count": ["type", "file", "pattern", "flags"],
  "line-count": ["type", "file"],
  "file-bytes": ["type", "file"],
  "path-exists": ["type", "base"],
  "text-in-file": ["type", "file"],
  "json-has-key": ["type", "file", "path"],
  "test-passes": ["type", "command", "watch", "timeout", "source"],
  "invariant-holds": ["type", "command", "watch", "timeout", "source"],
  "output-unchanged": ["type", "command", "watch", "timeout"],
};

/** 要跟数比的事实。这类说法的 locator 第 1 个捕获组必须是数 */
function isNumeric(f: ClaimDef["fact"]): boolean {
  return !isReferential(f) && !isObserved(f);
}

/**
 * @param raw   claims.json 原始内容，用来查「写了但会被丢掉的字段」
 * @param claims 解析后的说法
 * @param readDoc 读某个文件在基准 commit 上的正文，读不到返回 null
 */
export function lintClaims(
  raw: readonly unknown[],
  claims: readonly ClaimDef[],
  readDoc: (file: string) => string | null,
): ClaimWarning[] {
  const out: ClaimWarning[] = [];

  claims.forEach((c, i) => {
    const push = (level: ClaimWarning["level"], code: ClaimWarning["code"], message: string): void => {
      out.push({ id: c.id, label: c.label, level, code, message });
    };

    // 一、fact 里写了这个类型不认的字段。parseFact 会直接丢掉，不留痕迹
    const rawFact = (raw[i] as Record<string, unknown> | undefined)?.["fact"];
    if (typeof rawFact === "object" && rawFact !== null && !Array.isArray(rawFact)) {
      const allowed = FIELDS[c.fact.type];
      const extra = Object.keys(rawFact).filter((k) => allowed && !allowed.includes(k));
      if (allowed && extra.length > 0) {
        push(
          "error",
          "ignored-fact-field",
          `fact 里的 ${extra.map((k) => `"${k}"`).join("、")} 不会被用到（${c.fact.type} 只认 ${allowed.join("、")}）。` +
            `写在这里不会生效，也不会报错 —— 想让它生效，得换个事实类型或者挪到说法那一层。`,
        );
      }
    }

    // 二、数字类事实，但捕获到的不是数
    const doc = readDoc(c.file);
    if (doc === null) {
      push("warn", "locator-miss", `基准提交上读不到 ${c.file}，这条说法在第一个提交之前都没有依据。`);
      return;
    }
    const m = new RegExp(c.locator).exec(doc);
    if (!m) {
      push("error", "locator-miss", `locator 在 ${c.file} 里一处都没匹配到。整段历史都会是「尚未写入文档」，先跑 lookup 看它到底捕获到了什么。`);
    } else if (isNumeric(c.fact) && parseClaimedNumber(m[1] ?? "") === null) {
      push(
        "error",
        "capture-not-number",
        `locator 捕获的是 ${JSON.stringify(m[1] ?? "")}，读不成数，而 ${c.fact.type} 要跟数比。` +
          `这样每条 commit 都会判成「尚未写入文档」—— 不是文档没写，是这条说法没法测。` +
          `要么让捕获组只包数字，要么换成不以数字为准的事实类型。`,
      );
    }

  });

  return out;
}

/** 控制台用：有 error 时说明这次跑出来的状态不可信在哪些说上 */
export function formatWarnings(warnings: readonly ClaimWarning[]): string {
  if (warnings.length === 0) return "";
  const errs = warnings.filter((w) => w.level === "error").length;
  const head = `${warnings.length} 条说法的写法有问题${errs > 0 ? `（其中 ${errs} 条会导致状态不可信）` : ""}：`;
  const body = warnings.map((w) => `  ${w.level === "error" ? "✗" : "!"} ${w.label}：${w.message}`);
  return [head, ...body].join("\n");
}

/** claims.json 直接读原始内容，因为「写了但会被丢掉的字段」只有原文里看得到 */
export function lintClaimsFile(
  file: string,
  claims: readonly ClaimDef[],
  readDoc: (file: string) => string | null,
): ClaimWarning[] {
  let raw: unknown = [];
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return [];
  }
  return lintClaims(Array.isArray(raw) ? raw : [], claims, readDoc);
}
