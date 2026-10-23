/**
 * laminae —— 语法模块的接口与共用零件
 *
 * 支持的语言各提供一个 `SyntaxModule`。**语言判断只发生在 `pickModule` 一处**，
 * 其余地方一律调模块的方法，不再写「像不像 Python」这类三元表达式。
 * 加一门语言 = 加一个模块文件并注册，所有调用点一行都不用改。
 *
 * 这个文件只放两样东西：两边都要用的词法零件（括号配对、跳过字符串、函数体判空），
 * 以及模块接口本身。具体语言在 syntax-js.ts 与 syntax-py.ts，查表在 syntax-registry.ts。
 *
 * 不在这里 import 具体模块，否则会和它们互相依赖。
 */

export type FnReason = "empty" | "return-const" | "unimplemented" | "calls-empty" | "calls-other";

export interface FoundFn {
  /** 是不是箭头函数（JS）。箭头是表达式，它空不空不能说明功能有没有做 */
  arrow?: boolean;
  name: string | null;
  /** 这个函数本身有问题；null 表示看着有实现 */
  reason: FnReason | null;
  start: number;
  end: number;
}

export interface Binding {
  local: string;
  imported: string;
  spec: string;
}

export type HandlerKind = "trivial" | "substantive" | "missing";

export interface RouteDecl {
  name: string;
  handler: HandlerKind;
  via?: string;
  imported?: string;
  /** Python 装饰器挂在哪个变量上。路径还是装饰器上的那一段，前缀在 mountRoutes 里拼 */
  router?: string;
}

export interface PyRouter {
  local: string;
  /** APIRouter / FastAPI 的 prefix，没有就是空串 */
  prefix: string;
}

export interface PyMount {
  /** 调用 include_router 的那个变量，例如 app */
  parent: string;
  /** 被挂上的变量。module.router 时这是 module */
  local: string;
  prefix: string;
  /** module.router 里点后面的名字 */
  attr?: string;
}

/* ── 词法零件 ── */

export const TRIVIAL_EXPR = /^(?:null|undefined|None|false|true|0|\[\]|\{\}|""|'')$|^-?\d+(?:\.\d+)?$/;

export const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*(\/\/|#)[^\n]*/g, "$1");

/**
 * 把注释和字符串的**正文**替换成空格，长度和换行都不变。
 *
 * 为什么需要它：`findFunctions` 直接扫原文时，注释里的代码样例会被当成真代码。
 * vue 上就报出了这两个「空函数」：
 *
 *   // Note: functions inside this closure should use `const xxx = () => {}`
 *   // no: function NODE() {}
 *
 * 这不是小概率 —— 注释里写代码样例是很常见的写法，而且一旦命中，
 * hollowFunctions、delegatedCalls、classifyDepth 全都跟着错。
 *
 * 保留长度是为了偏移不变：匹配出来的位置还能直接拿去切原文取行号、取函数体。
 * 保留引号本身，这样 `skipString` 一类按引号找边界的函数仍然работа。
 *
 * @param hash 这个语言里 `#` 是不是行注释（Python 是，JS 不是 —— JS 的 `#x` 是私有字段）
 */
export function maskNonCode(text: string, hash = false): string {
  // 按切片累积，不把整份正文拆成字符数组。
  // 第一版用的是 text.split("") + 改 + join("")：一个 100 KB 的文件会造出十万个
  // 单字符串，profile 里这一段占了 29.8%，是整条流水线最大的一项。
  const out: string[] = [];
  let last = 0;
  let i = 0;
  // 换行必须保留 —— 行号要靠它
  const blank = (s: string): string => s.replace(/[^\n]/g, " ");

  while (i < text.length) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === c) break;
        j++;
      }
      out.push(text.slice(last, i + 1));
      out.push(blank(text.slice(i + 1, j)));
      last = j;
      // 要跳过收尾引号本身。停在它上面的话，下一轮会把它当成开引号，
      // 于是从这个字符串的结尾一直吞到下一个引号（或者吞到文件尾）。
      i = j + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      const stop = nl < 0 ? text.length : nl;
      out.push(text.slice(last, i));
      out.push(blank(text.slice(i, stop)));
      last = stop;
      i = stop;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const stop = close < 0 ? text.length : close + 2;
      out.push(text.slice(last, i));
      out.push(blank(text.slice(i, stop)));
      last = stop;
      i = stop;
      continue;
    }
    if (hash && c === "#") {
      const nl = text.indexOf("\n", i);
      const stop = nl < 0 ? text.length : nl;
      out.push(text.slice(last, i));
      out.push(blank(text.slice(i, stop)));
      last = stop;
      i = stop;
      continue;
    }
    i++;
  }
  out.push(text.slice(last));
  return out.join("");
}

export const codeLines = (text: string): string[] =>
  stripComments(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * 「这一行不算代码」的通用判定：import、export、以及 Python 的相对 import。
 * 判「剩下的有没有实质代码」时用它。两种语言合起来用同一条，是为了兼容
 * 一份文件里两种写法都出现的情况 —— 原来就是这么过滤的。
 */
export const isNonCodeLine = (l: string): boolean =>
  /^import\s/.test(l) || /^export\b/.test(l) || /^from\s+\./.test(l);

/** 去掉查询串、hash 和结尾的 /，让声明和引用对得上 */
export const normRoute = (p: string): string => {
  const cut = p.split(/[?#]/)[0] ?? "";
  return cut.length > 1 ? cut.replace(/\/+$/, "") : cut;
};

export function trivialBody(body: string): boolean {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  return lines.every((l) => {
    if (l === "pass" || l === "..." || l === "return") return true;
    const m = /^return\s+([\s\S]*?);?$/.exec(l);
    return m !== null && TRIVIAL_EXPR.test(m[1]!.trim());
  });
}

export function skipString(text: string, i: number): number {
  const q = text[i]!;
  i++;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === q) return i;
    if (q === "`" && text[i] === "$" && text[i + 1] === "{") {
      i += 2;
      let d = 1;
      while (i < text.length && d > 0) {
        if (text[i] === "{") d++;
        else if (text[i] === "}") d--;
        i++;
      }
      continue;
    }
    i++;
  }
  return i;
}

/** 从 open 处的 `(` 读到配对的 `)`，跳过字符串和行注释。读不到返回空串 */
export function readParen(text: string, open: number): string {
  if (text[open] !== "(") return "";
  let d = 0;
  for (let i = open; i < text.length && i < open + 2000; i++) {
    const c = text[i]!;
    if (c === "(") d++;
    else if (c === ")") {
      d--;
      if (d === 0) return text.slice(open + 1, i);
    } else if (c === "#") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
    } else if (c === "'" || c === '"' || c === "`") i = skipString(text, i);
  }
  return "";
}

export function matchBrace(text: string, open: number): number {
  let d = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === "{") d++;
    else if (c === "}") {
      d--;
      if (d === 0) return i;
    } else if (c === "'" || c === '"' || c === "`") i = skipString(text, i);
  }
  return -1;
}

export function bodyReason(body: string): FnReason | null {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "empty";
  const unimplemented = (l: string): boolean => /not implemented|NotImplementedError|未实现|unimplemented!|todo!/i.test(l);
  if (lines.every((l) => unimplemented(l) || l === "pass" || l === "..." || /^raise\s+NotImplementedError\b/.test(l))) {
    return lines.some(unimplemented) ? "unimplemented" : "empty";
  }
  if (trivialBody(body)) return "return-const";
  return null;
}

/** 路由的处理函数参数，从 i 读到配对的 `)` 或同一层的 `,` */
export function readHandlerArg(text: string, i: number): string {
  let d = 0;
  let j = i;
  while (j < text.length) {
    const c = text[j]!;
    if (c === "(" || c === "{" || c === "[") d++;
    else if (c === ")" || c === "}" || c === "]") {
      if (d === 0 && c === ")") return text.slice(i, j);
      d--;
    } else if (d === 0 && c === ",") return text.slice(i, j);
    else if (c === "'" || c === '"' || c === "`") j = skipString(text, j);
    j++;
  }
  return text.slice(i);
}

export function classifyHandler(
  arg: string,
  fns: Map<string, boolean>,
  imports: readonly Binding[],
): Pick<RouteDecl, "handler" | "via" | "imported"> {
  const a = arg.trim();
  const named = /^([A-Za-z_$][\w$]*)$/.exec(a);
  if (named) {
    const n = named[1]!;
    if (fns.has(n)) return { handler: fns.get(n) ? "trivial" : "substantive" };
    const imp = imports.find((b) => b.local === n);
    return imp ? { handler: "missing", via: imp.spec, imported: imp.imported } : { handler: "missing" };
  }
  const brace = a.indexOf("{");
  const arrow = a.indexOf("=>");
  if (brace >= 0 && (arrow < 0 || brace > arrow)) {
    const open = a.indexOf("{");
    const close = matchBrace(a, open);
    return { handler: trivialBody(close < 0 ? "" : a.slice(open + 1, close)) ? "trivial" : "substantive" };
  }
  if (arrow >= 0) {
    const expr = a.slice(arrow + 2).trim().replace(/;$/, "");
    return { handler: TRIVIAL_EXPR.test(expr) || expr === "" ? "trivial" : "substantive" };
  }
  return { handler: "substantive" };
}

/* ── 模块接口 ── */

/**
 * 一门语言的语法模块。
 *
 * 加语言要做的事：实现这个接口，在 syntax-registry.ts 里注册，再把扩展名加进 lang.ts。
 * 不需要改 classifyDepth / scanFileLayer / parseRoutes 任何一处。
 *
 * `routers` 与 `mounts` 只有 Python 有（APIRouter 前缀、include_router 挂载），
 * 别的语言可以不实现，调用侧按空数组处理。
 */
export interface SyntaxModule {
  readonly id: "js" | "py" | "rs";

  /** 这段文本像不像这门语言。只在 pickModule 里调用 */
  looksLike(text: string): boolean;

  /** 有名字的函数，以及它的函数体是不是空的。匿名函数也收，名字为 null */
  findFunctions(text: string): FoundFn[];

  /** 整份文件是不是纯转发（只剩把名字转到别处的语句） */
  isPureForward(lines: readonly string[], text: string): boolean;

  /** 这一行是不是转发语句 */
  isForwardLine(line: string): boolean;

  parseBindings(text: string, kind: "import" | "export"): Binding[];

  parseRoutes(text: string): RouteDecl[];

  routers?(text: string): PyRouter[];

  mounts?(text: string): PyMount[];
}
