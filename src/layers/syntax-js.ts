/**
 * laminae —— JS / TS 的语法模块
 *
 * 这里只放 JS/TS 特有的写法：花括号函数体、`import … from`、`app.get("/x")`、
 * NestJS 的 `@Get("/x")`。共用零件在 syntax.ts。
 *
 * 认不出的写法的处理原则和别处一致：宁可判「有实质代码」，也不猜成空实现 ——
 * 猜错的代价是给出假的红格子。
 */
import { TRIVIAL_EXPR, bodyReason, classifyHandler, matchBrace, normRoute, readHandlerArg, trivialBody, maskNonCode } from "./syntax.ts";
import type { Binding, FoundFn, RouteDecl, SyntaxModule } from "./syntax.ts";

const isJsForwardLine = (l: string): boolean => /^(?:import|export)\s/.test(l);
const isExportFromLine = (l: string): boolean => /^export\s+(?:\*|\{)/.test(l) && /\bfrom\s+['"]/.test(l);

function findFunctions(raw: string): FoundFn[] {
  // 注释和字符串里的代码样例不是代码。见 syntax.ts 里 maskNonCode 的说明。
  const text = maskNonCode(raw, false);
  const out: FoundFn[] = [];
  const re =
    /(?:export\s+default\s+|export\s+)?(?:async\s+)?function\s*([A-Za-z_$][\w$]*)?\s*\([^)]*\)\s*\{|(?:export\s+default\s+|export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\s*\([^)]*\)|\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{|(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const brace = m.index + m[0].length - 1;
    if (text[brace] !== "{") continue;
    const end = matchBrace(text, brace);
    if (end < 0) {
      re.lastIndex = brace + 1;
      continue;
    }
    // 标出这是不是箭头函数。文件级判定（classifyDepth）仍然需要「整个文件只有一句
    // 常量箭头」这种信号，所以这里照样给 reason；要不要把它报成「需要复核」是另一回事，
    // 那一步在下游按 arrow 过滤。见 layers-core 里的说明。
    const arrow = m[0].includes("=>");
    const reason = bodyReason(text.slice(brace + 1, end));
    out.push({ name: m[1] ?? m[2] ?? null, reason, arrow, start: m.index, end: end + 1 });
    re.lastIndex = end + 1;
  }
  // 没有花括号的箭头函数：const f = () => null
  const expr = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*([^;{\n]+)/g;
  while ((m = expr.exec(text))) {
    out.push({ name: m[1] ?? null, reason: TRIVIAL_EXPR.test(m[2]!.trim()) ? "return-const" : null, arrow: true, start: m.index, end: m.index + m[0].length });
  }
  // 只再追一跳：函数体如果只是 return 另一个空函数，自己也算空的。不跨文件
  const hollowNames = new Set(out.filter((f) => f.reason && f.name).map((f) => f.name!));
  for (const f of out) {
    if (f.reason) continue;
    const src = text.slice(f.start, f.end);
    const body = /\{([\s\S]*)\}/.exec(src)?.[1] ?? "";
    const call = /^\s*return\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*;?\s*$/.exec(body.trim());
    if (call && hollowNames.has(call[1]!)) f.reason = "calls-empty";
  }
  return out;
}

function parseBindings(text: string, kind: "import" | "export"): Binding[] {
  const out: Binding[] = [];
  const re = new RegExp(`${kind}\\s+(?:type\\s+)?\\{([^}]+)\\}\\s+from\\s*(['"])([^'"]+)\\2`, "g");
  for (const m of text.matchAll(re)) {
    for (const part of m[1]!.split(",")) {
      const mm = /([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?/.exec(part.trim());
      if (!mm) continue;
      out.push({ imported: mm[1]!, local: mm[2] ?? mm[1]!, spec: m[3]! });
    }
  }
  if (kind === "export") {
    for (const m of text.matchAll(/export\s+\*\s+from\s*(['"])([^'"]+)\1/g)) out.push({ imported: "*", local: "*", spec: m[2]! });
  } else {
    for (const m of text.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s*(['"])([^'"]+)\2/g)) {
      out.push({ imported: "default", local: m[1]!, spec: m[3]! });
    }
  }
  return out;
}

function parseRoutes(text: string): RouteDecl[] {
  const fns = new Map<string, boolean>();
  for (const f of findFunctions(text)) if (f.name) fns.set(f.name, f.reason !== null);
  const imports = parseBindings(text, "import");
  const out: RouteDecl[] = [];
  const seen = new Set<string>();
  const add = (name: string, handler: Pick<RouteDecl, "handler" | "via" | "imported">): void => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ name, ...handler });
  };

  const js = /(?<!(?:axios|got|superagent|request|https?|client))\.\s*(?:get|post|put|delete|patch|route)\s*\(\s*(['"`])(\/[^\s'"`]{0,119})\1/g;
  for (const m of text.matchAll(js)) {
    const name = normRoute(m[2] ?? "");
    if (name === "" || name.includes("$") || name.includes("{")) continue;
    const after = m.index! + m[0].length;
    const comma = /^\s*,\s*/.exec(text.slice(after));
    if (!comma) continue;
    const arg = readHandlerArg(text, after + comma[0].length);
    add(name, classifyHandler(arg, fns, imports));
  }

  const nest = /@(?:Get|Post|Put|Delete|Patch)\s*\(\s*(['"`])(\/[^\s'"`]{0,119})\1/g;
  for (const m of text.matchAll(nest)) {
    const name = normRoute(m[2] ?? "");
    if (name === "" || name.includes("$") || name.includes("{")) continue;
    const after = m.index! + m[0].length;
    const brace = text.indexOf("{", after);
    if (brace < 0 || brace - after > 240) {
      add(name, { handler: "missing" });
      continue;
    }
    const close = matchBrace(text, brace);
    const body = close < 0 ? "" : text.slice(brace + 1, close);
    add(name, { handler: trivialBody(body) ? "trivial" : "substantive" });
  }
  return out;
}

export const jsModule: SyntaxModule = {
  id: "js",
  // 兜底：没有别的模块认得，就当 JS/TS。原来就是这么处理的
  looksLike: () => true,
  findFunctions,
  isPureForward: (lines) => lines.every(isJsForwardLine) && lines.some(isExportFromLine),
  isForwardLine: isJsForwardLine,
  parseBindings,
  parseRoutes,
};
