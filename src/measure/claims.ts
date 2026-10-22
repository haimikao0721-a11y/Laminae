/**
 * laminae —— 说法定义的读取与校验
 *
 * claims.json 由使用者（或调用本 skill 的 agent）针对目标仓库编写，
 * 放在目标仓库的 .laminae/claims.json。这里只负责读与校验，不含任何仓库相关的内容。
 */
import fs from "node:fs";
import { COMPARES, DEFAULT_TOLERANCE } from "./compare.ts";
import type { Compare } from "./compare.ts";
import { isObserved, isReferential, parseFact } from "./facts.ts";
import { repoRelative } from "../core/paths.ts";
import { IMPACTS, type ClaimDef, type Impact } from "../core/types.ts";

/** 校验已解析的 JSON，返回规范化后的说法列表。出错抛 Error */
export function parseClaims(raw: unknown): ClaimDef[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("claims.json 必须是非空数组，每个元素是一条说法");
  }

  const seen = new Set<string>();
  return raw.map((item: unknown, i: number): ClaimDef => {
    const where = `claims[${i}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`${where}：必须是对象`);
    }
    const o = item as Record<string, unknown>;

    const need = (k: string): string => {
      const v = o[k];
      if (typeof v !== "string" || v === "") throw new Error(`${where}：缺少 ${k}（非空字符串）`);
      return v;
    };

    const id = need("id");
    if (seen.has(id)) throw new Error(`${where}：id「${id}」重复`);
    seen.add(id);

    const file = repoRelative(need("file"), `${where}：file`);
    const locator = need("locator");

    let re: RegExp;
    try {
      re = new RegExp(locator);
    } catch (e) {
      throw new Error(`${where}（${id}）：locator 不是合法正则：${(e as Error).message}`);
    }
    // 第 1 个捕获组必须存在：它就是文档里断言的那个数
    if (new RegExp(`${re.source}|`, re.flags).exec("")!.length < 2) {
      throw new Error(`${where}（${id}）：locator 需要至少一个捕获组，第 1 个捕获组是文档里的那个数，例如 "(\\\\d+) 个文件"`);
    }

    const label = typeof o["label"] === "string" && o["label"] !== "" ? o["label"] : id;
    const fact = parseFact(o["fact"], `${where}（${id}）`);

    const rawImpact = o["impact"];
    if (rawImpact !== undefined && !IMPACTS.includes(rawImpact as Impact)) {
      throw new Error(`${where}（${id}）：impact 只能是 ${IMPACTS.map((s) => `"${s}"`).join("、")}，收到 ${JSON.stringify(rawImpact)}`);
    }
    const impact = (rawImpact as Impact | undefined) ?? "normal";

    const rawCompare = o["compare"];
    if (rawCompare !== undefined && !(COMPARES as readonly unknown[]).includes(rawCompare)) {
      throw new Error(`${where}（${id}）：compare 只能是 ${COMPARES.map((s) => `"${s}"`).join("、")}，收到 ${JSON.stringify(rawCompare)}`);
    }
    const compare = (rawCompare as Compare | undefined) ?? "eq";
    if (compare !== "eq" && isReferential(fact)) {
      throw new Error(`${where}（${id}）：compare 只用于数值型事实；${fact.type} 断言的是「存在」，不能写 ${JSON.stringify(compare)}`);
    }
    if (compare !== "eq" && isObserved(fact)) {
      throw new Error(`${where}（${id}）：compare 只用于数值型事实；${fact.type} 的结果是过或不过，不能写 ${JSON.stringify(compare)}`);
    }

    const rawTol = o["tolerance"];
    if (rawTol !== undefined) {
      if (compare !== "approx") throw new Error(`${where}（${id}）：tolerance 只在 compare 为 "approx" 时有意义`);
      if (typeof rawTol !== "number" || !(rawTol > 0 && rawTol < 1)) {
        throw new Error(`${where}（${id}）：tolerance 是相对误差，必须是 0 到 1 之间的数（0.05 表示相差不超过 5%），收到 ${JSON.stringify(rawTol)}`);
      }
    }
    const tolerance = typeof rawTol === "number" ? rawTol : DEFAULT_TOLERANCE;

    return { id, file, locator, label, fact, impact, compare, tolerance };
  });
}

/** 读取并校验 claims.json */
export function loadClaims(file: string): ClaimDef[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`找不到说法定义文件：${file}\n先在目标仓库里创建它，格式见 SKILL.md`);
  }
  try {
    return parseClaims(JSON.parse(text.replace(/^\uFEFF/, ""))); // Windows PowerShell 5 的 Set-Content -Encoding utf8 会写 BOM
  } catch (e) {
    throw new Error(`${file}：${(e as Error).message}`);
  }
}
