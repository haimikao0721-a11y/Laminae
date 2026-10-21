/**
 * laminae —— 想法与边界的定义、校验与求值（纯函数，不碰 git）
 *
 * ideas.json 由使用者（或调用本 skill 的 agent）针对目标仓库编写，放在 .laminae/ideas.json。
 * 每条想法用一个「引用型事实」做证据：路径存不存在、文本出没出现、JSON 里有没有这个键，
 * 或者模块之间有没有引用（import-edge：A 引用了 B）。
 * 证据和想法的方向（应该有 / 应该没有）是人声明的，工具只负责逐 commit 核对，不猜。
 */
import { describeFact, evalFact, isReferential, parseFact } from "./facts.ts";
import { repoRelative } from "./paths.ts";
import type { FactSpec, Tree } from "./facts.ts";
import { isCodeFile } from "./imports.ts";
import type { IdeaState } from "./types.ts";

/** 模块之间的引用：from 下的某个文件引用了 to 下的某个文件。from / to 是目录或单个文件 */
export interface EdgeFact {
  type: "import-edge";
  from: string;
  to: string;
}

export type IdeaFact = FactSpec | EdgeFact;

export const isEdge = (f: IdeaFact): f is EdgeFact => f.type === "import-edge";

/** 去掉开头的 ./ 与结尾的 / */
const clean = (p: string): string => p.trim().replace(/^\.\//, "").replace(/\/+$/, "");

export interface IdeaDef {
  id: string;
  text: string;
  /** 证据指向的东西：路径、文本或键，视 fact 的类型而定；import-edge 时是「from → to」 */
  target: string;
  fact: IdeaFact;
  /** present：target 应该存在；absent：应该不存在 */
  expect: "present" | "absent";
  /** 边界：刻意不做的事 */
  boundary: boolean;
  source: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 校验已解析的 ideas.json。出错抛 Error，信息指出哪一条的哪个字段 */
export function parseIdeas(raw: unknown): IdeaDef[] {
  if (!Array.isArray(raw)) throw new Error("ideas.json 必须是数组，每个元素是一条想法或边界");
  const seen = new Set<string>();
  return raw.map((item: unknown, i: number): IdeaDef => {
    const where = `ideas[${i}]`;
    if (!isObj(item)) throw new Error(`${where}：必须是对象`);

    const need = (k: string): string => {
      const v = item[k];
      if (typeof v !== "string" || v.trim() === "") throw new Error(`${where}：缺少 ${k}（非空字符串）`);
      return v;
    };

    const id = need("id");
    if (seen.has(id)) throw new Error(`${where}：id「${id}」重复`);
    seen.add(id);

    const text = need("text");

    const rawFact = item["fact"];
    let fact: IdeaFact;
    let target: string;
    if (isObj(rawFact) && rawFact["type"] === "import-edge") {
      const side = (k: "from" | "to"): string => {
        const v = rawFact[k];
        if (typeof v !== "string" || clean(v) === "") throw new Error(`${where}（${id}）：fact.${k} 必须是非空字符串（目录或文件路径）`);
        return repoRelative(clean(v), `${where}（${id}）：fact.${k}`);
      };
      const from = side("from");
      const to = side("to");
      if (from === to) throw new Error(`${where}（${id}）：fact.from 与 fact.to 不能相同`);
      fact = { type: "import-edge", from, to };
      target = `${from} → ${to}`; // 引用边界不需要 target，写了也忽略
    } else {
      target = need("target");
      const f = parseFact(rawFact, `${where}（${id}）`);
      if (!isReferential(f)) {
        throw new Error(`${where}（${id}）：想法的证据必须是引用型事实（path-exists / text-in-file / json-has-key）或 import-edge，收到 ${f.type}`);
      }
      fact = f;
    }

    const b = item["boundary"];
    if (b !== undefined && typeof b !== "boolean") throw new Error(`${where}（${id}）：boundary 必须是 true 或 false`);
    const boundary = b === true;

    const e = item["expect"];
    if (e !== undefined && e !== "present" && e !== "absent") {
      throw new Error(`${where}（${id}）：expect 只能是 "present" 或 "absent"，收到 ${JSON.stringify(e)}`);
    }
    // 边界默认是「不该出现」，想法默认是「应该出现」
    const expect = e ?? (boundary ? "absent" : "present");

    const s = item["source"];
    if (s !== undefined && typeof s !== "string") throw new Error(`${where}（${id}）：source 必须是字符串`);

    return { id, text, target, fact, expect, boundary, source: s ?? "" };
  });
}

/** 证据的一句话描述 */
export function describeIdea(d: IdeaDef): string {
  if (isEdge(d.fact)) return `${d.fact.from} ${d.expect === "present" ? "引用了" : "没有引用"} ${d.fact.to}`;
  const what = (() => {
    switch (d.fact.type) {
      case "path-exists":
        return `路径 ${d.fact.base ? d.fact.base + "/" : ""}${d.target}`;
      case "text-in-file":
        return `${d.fact.file} 里的文本「${d.target}」`;
      case "json-has-key":
        return `${d.fact.file}${d.fact.path ? " → " + d.fact.path : ""} 里的键 ${d.target}`;
      default:
        return describeFact(d.fact);
    }
  })();
  return `${what} ${d.expect === "present" ? "存在" : "不存在"}`;
}

/** 一个 commit 上的状态：证据满足为 0，不满足为 1，读不到为 3 */
export function ideaStateAt(d: IdeaDef, tree: Tree): IdeaState {
  if (isEdge(d.fact)) throw new Error("import-edge 要用 evalEdge，需要引用扫描结果");
  const v = evalFact(d.fact, tree, d.target);
  if (v === null) return 3;
  const exists = v === 1;
  return exists === (d.expect === "present") ? 0 : 1;
}

/** 从状态序列里提炼：第一次满足的下标、满足之后又退回去的次数。「测不出来」不算退回 */
export function summarizeIdea(states: readonly IdeaState[]): { firstMet: number; regressions: number } {
  let firstMet = -1;
  let regressions = 0;
  let last: IdeaState | null = null;
  for (const [i, s] of states.entries()) {
    if (s === 3) continue;
    if (s === 0 && firstMet < 0) firstMet = i;
    if (last === 0 && s === 1) regressions++;
    last = s;
  }
  return { firstMet, regressions };
}

/* ── 引用边界：from 不许（或应该）引用 to ── */

/** 一个 commit 上的引用扫描结果（来自 scan.ts） */
export interface EdgeScan {
  /** 该 commit 上的全部文件路径 */
  allFiles: readonly string[];
  /** 代码文件之间的引用：[引用方, 被引用方] */
  edges: readonly (readonly [string, string])[];
  /** 解析不了又不像第三方包的引用：[引用方, 引用字符串]，多半是别名路径 */
  unresolved: readonly (readonly [string, string])[];
}

export interface EdgeEval {
  state: IdeaState;
  /** from 下的文件引用 to 下的文件的那些边 */
  hits: [string, string][];
  /** 判不了的原因，只在 state 为 3 时有 */
  unsure: string | null;
}

const under = (file: string, dir: string): boolean => file === dir || file.startsWith(dir + "/");

/** 引用字符串里有没有出现 to 的末段（去掉扩展名与 @ ~ # $ 前缀）：是的话它有可能指向 to */
function mentions(spec: string, to: string): boolean {
  const strip = (s: string): string => s.replace(/\.[^./]+$/, "");
  const needle = strip(to.slice(to.lastIndexOf("/") + 1));
  if (needle === "") return false;
  return spec.split("/").some((seg) => strip(seg.replace(/^[@~#$]+/, "")) === needle);
}

/**
 * 在一个 commit 上判定引用边界。
 * 找到了符合的引用，结论就是确定的；没找到时，只有排除了下面两种「看不见」才敢说没有：
 *   · from 下根本没有 JS/TS/Python 代码（引用图不支持别的语言）
 *   · from 下有解析不了的别名引用，而且它的写法里带着 to 的名字（可能其实指向了 to）
 */
export function evalEdge(d: { fact: EdgeFact; expect: "present" | "absent" }, scan: EdgeScan): EdgeEval {
  const { from, to } = d.fact;
  const hits = scan.edges.filter(([s, t]) => under(s, from) && under(t, to)).map(([s, t]): [string, string] => [s, t]);
  const want = d.expect === "present";

  if (hits.length > 0) return { state: want ? 0 : 1, hits, unsure: null };

  const fromFiles = scan.allFiles.filter((f) => under(f, from));
  if (fromFiles.length > 0 && !fromFiles.some(isCodeFile)) {
    return { state: 3, hits, unsure: `${from} 下没有 JS/TS/Python 代码文件，引用图不支持这种语言，判不了` };
  }
  const maybe = scan.unresolved.filter(([f, spec]) => under(f, from) && mentions(spec, to));
  if (maybe.length > 0) {
    const [f0, spec0] = maybe[0]!;
    return {
      state: 3,
      hits,
      unsure: `${from} 下有 ${maybe.length} 处别名引用解析不了（如 ${f0} 里的 ${spec0}），不能确定它们是否指向 ${to}`,
    };
  }
  return { state: want ? 1 : 0, hits, unsure: null };
}
