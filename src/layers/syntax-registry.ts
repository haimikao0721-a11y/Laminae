/**
 * laminae —— 语言模块的查表
 *
 * **这是整个流程里唯一判断「这段文本是哪门语言」的地方**，别处一律问模块。
 *
 * 这里有两张表，用途不同，别合并：
 *   - `MODULES`：认语言的优先顺序。先问判据严格的（Python），最后是不挑的（JS/TS 兜底）。
 *     原来三处调用点的判据是 `findPythonFunctions(text).length > 0 && !/(?:function\s*\(|=>)/`，
 *     拿不准时都落到 JS/TS，这里保持同样的结果。
 *   - `MERGE_ORDER`：把多个模块的结果拼起来时的先后。路由与 import 解析原来是
 *     「两种写法都试一遍」，而且顺序是 JS → Nest → Python，先命中的算数。
 *
 * 为什么不能统一成「只问认出来的那个模块」：一个没有 `def` 的 Python 文件
 * （只写了 `router = APIRouter(...)` 和装饰器）认不出是 Python，但它里面的路由是真的，
 * 只问 JS 模块就会把它们丢掉。
 */
import { jsModule } from "./syntax-js.ts";
import { pyModule } from "./syntax-py.ts";
import { rsModule } from "./syntax-rs.ts";
import type { Binding, PyMount, PyRouter, RouteDecl, SyntaxModule } from "./syntax.ts";

/** 认语言的优先顺序：先严后松 */
export const MODULES: readonly SyntaxModule[] = [pyModule, rsModule, jsModule];

/** 多模块结果合并时的顺序，保持原来的 JS → Nest → Python */
const MERGE_ORDER: readonly SyntaxModule[] = [jsModule, pyModule, rsModule];

export function pickModule(text: string): SyntaxModule {
  for (const m of MODULES) if (m.looksLike(text)) return m;
  return jsModule;
}

/** 所有模块的 import / export 绑定拼起来。原来是同一个函数里两种写法都试 */
export function allBindings(text: string, kind: "import" | "export"): Binding[] {
  return MERGE_ORDER.flatMap((m) => m.parseBindings(text, kind));
}

/** 所有模块声明的路由。按「挂在哪个变量上 + 路径」去重，先命中的算数 */
export function allRoutes(text: string): RouteDecl[] {
  const out: RouteDecl[] = [];
  const seen = new Set<string>();
  for (const m of MERGE_ORDER) {
    for (const r of m.parseRoutes(text)) {
      const key = `${r.router ?? ""}\0${r.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

/**
 * APIRouter 与 include_router 的声明。
 *
 * 这两个也必须跨模块合并：一个只有 `app = FastAPI()` 和 `include_router` 的文件里
 * 没有 `def`，认不出是 Python，但它确实在做挂载。只问认出来的模块会把挂载丢掉，
 * 前缀就拼不上了。
 */
export function allRouters(text: string): PyRouter[] {
  return MERGE_ORDER.flatMap((m) => m.routers?.(text) ?? []);
}

export function allMounts(text: string): PyMount[] {
  return MERGE_ORDER.flatMap((m) => m.mounts?.(text) ?? []);
}

export { jsModule, pyModule, rsModule };
