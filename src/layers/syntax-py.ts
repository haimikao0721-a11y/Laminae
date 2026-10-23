/**
 * laminae —— Python 的语法模块
 *
 * 这里只放 Python 特有的写法：按缩进判函数体、`from … import …`、
 * `@router.get("/x")` 这类装饰器、`APIRouter(prefix=)` 与 `include_router`。
 * 共用零件在 syntax.ts。
 *
 * 已知限制（写得准比写得全重要）：跨行的 `from x import (\n a,\n b)` 只读到第一行的名字。
 * 这里按行解析，结构上就读不到第二行。真正的解法是接 Python 的 ast，见 docs/LANGUAGES.md。
 */
import { bodyReason, normRoute, readParen, maskNonCode } from "./syntax.ts";
import type { Binding, FoundFn, PyMount, PyRouter, RouteDecl, SyntaxModule } from "./syntax.ts";

const isPyForwardLine = (l: string): boolean => /^from\s+\./.test(l) || /^import\s+\./.test(l);

function findPythonFunctions(raw: string): FoundFn[] {
  // 注释和字符串里的代码样例不是代码。Python 里 # 是行注释，所以 hash = true。
  const text = maskNonCode(raw, true);
  const lines = text.split("\n");
  const out: FoundFn[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /^([ \t]*)def\s+([A-Za-z_][\w]*)\s*\([^)]*\)\s*:/.exec(lines[i]!);
    if (!head) continue;
    const indent = head[1]!.length;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() === "") continue;
      if (/^[ \t]*/.exec(line)![0].length <= indent) break;
      body.push(line);
    }
    const start = lines.slice(0, i).join("\n").length + (i === 0 ? 0 : 1);
    const end = lines.slice(0, j).join("\n").length;
    out.push({ name: head[2]!, reason: bodyReason(body.join("\n")), start, end });
    i = j - 1;
  }
  return out;
}

function parseBindings(text: string, kind: "import" | "export"): Binding[] {
  // Python 没有 export
  if (kind === "export") return [];
  const out: Binding[] = [];
  for (const m of text.matchAll(/^\s*from\s+(\S+)\s+import\s+(.+)$/gm)) {
    for (const part of m[2]!.split(",")) {
      const mm = /^([A-Za-z_][\w]*)(?:\s+as\s+([A-Za-z_][\w]*))?/.exec(part.trim());
      if (!mm) continue;
      out.push({ imported: mm[1]!, local: mm[2] ?? mm[1]!, spec: m[1]! });
    }
  }
  return out;
}

function parseRoutes(text: string): RouteDecl[] {
  const fns = new Map<string, boolean>();
  for (const f of findPythonFunctions(text)) if (f.name) fns.set(f.name, f.reason !== null);
  const out: RouteDecl[] = [];
  const seen = new Set<string>();
  const add = (name: string, handler: Pick<RouteDecl, "handler" | "via" | "imported">, router?: string): void => {
    const key = `${router ?? ""}\0${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(router ? { name, ...handler, router } : { name, ...handler });
  };

  const py = /@(?:([A-Za-z_]\w*)\.)?(?:route|get|post|put|delete|patch)\s*\(\s*(['"])(\/[^\s'"]{0,119})\2/g;
  for (const m of text.matchAll(py)) {
    const name = normRoute(m[3] ?? "");
    if (name === "") continue;
    const rest = text.slice(m.index! + m[0].length);
    const def = /\bdef\s+([A-Za-z_][\w]*)\s*\(/.exec(rest);
    const trivial = def ? fns.get(def[1]!) === true : false;
    const known = def ? fns.has(def[1]!) : false;
    add(name, { handler: !known ? "missing" : trivial ? "trivial" : "substantive" }, m[1] || undefined);
  }
  return out;
}

/** `name = APIRouter(prefix="...")` / `FastAPI(...)`。prefix 不是字符串字面量的记成空串 */
function parsePyRouters(text: string): PyRouter[] {
  const out: PyRouter[] = [];
  const re = /([A-Za-z_]\w*)\s*=\s*(?:APIRouter|FastAPI)\s*\(/g;
  for (const m of text.matchAll(re)) {
    const args = readParen(text, m.index! + m[0].length - 1);
    const prefix = /prefix\s*=\s*(['"])(\/[^'"]*)\1/.exec(args)?.[2] ?? "";
    out.push({ local: m[1]!, prefix });
  }
  return out;
}

/** `app.include_router(router, prefix="/api")`，也认 `app.include_router(users.router, prefix=...)` */
function parsePyMounts(text: string): PyMount[] {
  const out: PyMount[] = [];
  const re = /([A-Za-z_]\w*)\.include_router\s*\(/g;
  for (const m of text.matchAll(re)) {
    const args = readParen(text, m.index! + m[0].length - 1);
    const target = /^\s*([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?/.exec(args);
    if (!target) continue;
    const prefix = /prefix\s*=\s*(['"])(\/[^'"]*)\1/.exec(args)?.[2] ?? "";
    const mount: PyMount = { parent: m[1]!, local: target[1]!, prefix };
    if (target[2]) mount.attr = target[2];
    out.push(mount);
  }
  return out;
}

export const pyModule: SyntaxModule = {
  id: "py",
  // 有 def 函数，而且没有 JS 的函数写法，才算 Python。这条判据原来就散在三处，现在收在这里
  looksLike: (text) => findPythonFunctions(text).length > 0 && !/(?:function\s*\(|=>)/.test(text),
  findFunctions: findPythonFunctions,
  isPureForward: (lines) => lines.every(isPyForwardLine),
  isForwardLine: isPyForwardLine,
  parseBindings,
  parseRoutes,
  routers: parsePyRouters,
  mounts: parsePyMounts,
};
