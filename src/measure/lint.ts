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
  code: "ignored-fact-field" | "capture-not-number" | "locator-miss" | "locator-redos" | "locator-multi-match" | "placeholder-fact";
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

/**
 * 这条事实是不是**还是个占位**。
 *
 * init 生成的草稿里，fact 用的是默认值：数所有文件、或者只问 package.json
 * 有没有 scripts 这个键。这两个数**和文档那句话没有关系**。
 *
 * 危险的地方在于它照样能跑出结果：报告里会显示成「真」或「假」，
 * 看起来像结论，其实是没调好的机器。
 *
 * 只认这两种形状，不去猜别的 —— 猜错一次，人以后就不看这条警告了。
 */
export function placeholderFact(f: ClaimDef["fact"]): string | null {
  if (f.type === "count-files" && (f.glob === "**/*" || f.glob === "**" || f.glob === "*" || f.glob === "")) {
    return "还在数「仓库里的所有文件」";
  }
  if (f.type === "json-has-key" && f.path === "scripts") {
    return "只在问 package.json 有没有 scripts 这个键，任何 npm 项目都有";
  }
  return null;
}

/** 要跟数比的事实。这类说法的 locator 第 1 个捕获组必须是数 */
function isNumeric(f: ClaimDef["fact"]): boolean {
  return !isReferential(f) && !isObserved(f);
}

/**
 * @param raw   claims.json 原始内容，用来查「写了但会被丢掉的字段」
 * @param claims 解析后的说法
 * @param readDoc 读某个文件在基准 commit 上的正文，读不到返回 null
 */
/**
 * locator 里可能灾难性回溯的写法。
 *
 * 这不是理论：我自己写过一个
 *   [A-Za-z0-9_@][A-Za-z0-9_.\-]*(?:\/[A-Za-z0-9_.\-]+)*\.[A-Za-z0-9]{1,8}
 * 在 5.6 MB 正文上占掉了整条流水线 43% 的时间。而 locator 是**在整份文档上**跑的，
 * 文档动辄几十万字 —— 一个写坏的正则能让工具卡到人以为死机。
 *
 * 认三种形状：
 *   一、量词套量词        (a+)+  (\w*)*  ([^)]+)*
 *   二、量词后面还有分支   (a|a)+
 *   三、点星套在分组里再量化  (.*)* 
 *
 * 只警告，不改判定 —— 判定那一侧已经收住了，不能因为一个性能提示去碰它。
 */
export function redosRisk(locator: string): string | null {
  // 量词套量词：分组里有 * + 或 {n,}，分组本身又被 * + {n,} 量化
  const nested = /\(([^()]*?)(?:[*+]|\{\d+,\})\)\s*(?:[*+]|\{\d+,\})/;
  if (nested.test(locator)) return "量词套量词（分组里有 * 或 +，分组本身又被 * 或 + 量化）";
  // 一个分支两侧都以同一个开头收尾，配合重复会退化成指数级
  const alternation = /\(([^()|]+)\|\1\)/;
  if (alternation.test(locator)) return "分组里的两个分支写法太接近，重复匹配会退化";
  return null;
}

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

    // 一之半、locator 可能有灾难性回溯。
    //
    // 放在读文档之前：这个检查只看正则本身，不需要文档。而且万一正则真的会卡，
    // 下面那行 exec 就直接卡住了，警告也就发不出来。
    const risk = redosRisk(c.locator);
    if (risk !== null) {
      push(
        "warn",
        "locator-redos",
        `locator 有${risk}，在很长的文档上可能卡住甚至跑不完。` +
          `locator 是在整份文档上跑的，文档动辄几十万字。` +
          `建议改成不含嵌套量词的写法 —— 这只是个性能提示，不影响判定。`,
      );
    }

    if (doc === null) {
      push("warn", "locator-miss", `基准提交上读不到 ${c.file}，这条说法在第一个提交之前都没有依据。`);
      return;
    }
    // 二之半、locator 在同一份文档里匹配到多处。
    //
    // 判定只取第一处（下面那行 exec 就是这样），绑到哪句全看谁在前面。
    // 以前这件事完全静默：文档里加一句相似的话，结论就换了，而且看不出来。
    const matches = [...doc.matchAll(new RegExp(c.locator, "g"))];
    if (matches.length > 1) {
      const lines = matches.slice(0, 5).map((x) => doc.slice(0, x.index).split("\n").length);
      push(
        "warn",
        "locator-multi-match",
        `locator 在 ${c.file} 里匹配到 ${matches.length} 处（第 ${lines.join("、")} 行），判定只取第一处。` +
          `这不会让结论「错」，但会让它绑在你没打算绑的那句话上。` +
          `把 locator 前后多带几个字，让它只对上一处。`,
      );
    }

    // 二之三、事实还是 init 写下的占位。
    //
    // 它照样能跑出结果，报告里显示成「真」或「假」—— 看起来像结论，
    // 其实是没调好的机器。这一条比「测不出来」更该说：测不出来至少没人会当真。
    const placeholder = placeholderFact(c.fact);
    if (placeholder !== null) {
      push(
        "error",
        "placeholder-fact",
        `这条说法量错了东西：${placeholder}。` +
          `量出来的数和文档那句话没有关系，所以下面每一格的真假都不能当真。` +
          `locator 可以留，把 fact 改成该数的东西（见 docs/PATTERNS.md）。`,
      );
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
  const head = `${warnings.length} 条警告${errs > 0 ? `（其中 ${errs} 条会让状态不可信）` : ""}：`;
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
