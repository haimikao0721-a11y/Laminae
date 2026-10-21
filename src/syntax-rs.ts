/**
 * laminae —— Rust 的语法模块
 *
 * 这里只放 Rust 特有的写法：`fn` 定义与花括号体、`mod` 声明、`use` 引用、
 * `pub use` 转发。共用零件在 syntax.ts。
 *
 * 判定原则和其他语言一致，但 Rust 有两个坑要说清楚：
 *
 *   - `unimplemented!()` / `todo!()` 是宏，写在函数体里。bodyReason 认得它们，
 *     所以「写着没实现」这一档能对上。
 *   - `unreachable!()` **不算**没实现。它表示「这个分支不可能发生」，是守卫，
 *     不是空壳。不要把它并进 unimplemented。
 *
 * 认不出结构时判「有实质代码」，不猜成空实现 —— 猜错的代价是给出假的红格子。
 */
import { bodyReason, matchBrace, skipString } from "./syntax.ts";
import type { Binding, FoundFn, RouteDecl, SyntaxModule } from "./syntax.ts";

/** `pub`、`pub(crate)`、`const`、`async`、`unsafe`、`extern "C"` 都可能出现在 fn 前面 */
const FN_HEAD = /(?:^|\n)[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(?:const[ \t]+)?(?:async[ \t]+)?(?:unsafe[ \t]+)?(?:extern[ \t]+"[^"]*"[ \t]+)?fn[ \t]+([A-Za-z_]\w*)/g;

const isRsForwardLine = (l: string): boolean => /^(?:pub(?:\([^)]*\))?\s+)?use\s/.test(l);

/** 从 open 处的 `(` 找到配对的 `)` 的位置，读不到返回 -1 */
function closingParen(text: string, open: number): number {
  let d = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(") d++;
    else if (c === ")") {
      d--;
      if (d === 0) return i;
    } else if (c === '"') i = skipString(text, i);
    else if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
    }
  }
  return -1;
}

function findFunctions(text: string): FoundFn[] {
  const out: FoundFn[] = [];
  FN_HEAD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FN_HEAD.exec(text))) {
    const name = m[1]!;
    // 名字后面可能跟泛型参数，然后是参数列表
    let i = m.index + m[0].length;
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text[i] === "<") {
      // 跳过 <...>（简单计数，泛型里很少出现嵌套花括号）
      let d = 0;
      for (; i < text.length; i++) {
        if (text[i] === "<") d++;
        else if (text[i] === ">") {
          d--;
          if (d === 0) {
            i++;
            break;
          }
        }
      }
      while (i < text.length && /\s/.test(text[i]!)) i++;
    }
    if (text[i] !== "(") continue;
    const close = closingParen(text, i);
    if (close < 0) continue;

    // 参数列表之后：可能是 `-> Type`、`where ...`，然后是 `{` 或 `;`
    let j = close + 1;
    let sawBrace = -1;
    for (; j < text.length; j++) {
      const c = text[j]!;
      if (c === "{") {
        sawBrace = j;
        break;
      }
      if (c === ";") break; // trait 里的声明，没有函数体
      if (c === '"') j = skipString(text, j);
    }
    if (sawBrace < 0) continue;
    const end = matchBrace(text, sawBrace);
    if (end < 0) continue;
    const body = text.slice(sawBrace + 1, end);
    const reason = bodyReason(body);
    // Rust 里空函数体是常见写法：trait 的默认实现、标记实现、回调占位。
    // 空着不等于「写着没做」，所以 empty 不当作空壳；真正没实现的是 unimplemented!() / todo!()，
    // bodyReason 已经把它判成 unimplemented，那一档保留。
    out.push({
      name,
      reason: reason === "empty" ? null : reason,
      start: m.index + (m[0].startsWith("\n") ? 1 : 0),
      end: end + 1,
    });
    FN_HEAD.lastIndex = end + 1;
  }
  return out;
}

function parseBindings(text: string, kind: "import" | "export"): Binding[] {
  const out: Binding[] = [];
  for (const line of text.split("\n")) {
    const t = line.replace(/\/\/.*$/, "").trim();
    if (kind === "export") {
      // Rust 的转发是 `pub use`
      const pubUse = /^pub(?:\([^)]*\))?\s+use\s+([A-Za-z_][\w:]*)/.exec(t);
      if (pubUse) out.push({ imported: "*", local: "*", spec: pubUse[1]! });
      continue;
    }
    const use = /^use\s+([A-Za-z_][\w:]*)/.exec(t);
    if (use) {
      const spec = use[1]!;
      const parts = spec.split("::");
      const local = parts[parts.length - 1]!;
      out.push({ imported: local, local, spec });
      continue;
    }
    // `mod foo;` 也是一条结构边
    const mod = /^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/.exec(t);
    if (mod) out.push({ imported: mod[1]!, local: mod[1]!, spec: `self::${mod[1]!}` });
  }
  return out;
}

export const rsModule: SyntaxModule = {
  id: "rs",
  // 有 fn 定义、又没有 JS 的 function 声明，才当成 Rust。
  // 判据里不能用 `=>` —— Rust 的 match 分支也用 `=>`，那样会把一半 Rust 文件判成 JS。
  looksLike: (text) => /\bfn\s+[A-Za-z_]\w*\s*[(<]/.test(text) && !/\bfunction\s+[A-Za-z_$]*\s*\(/.test(text),
  findFunctions,
  isPureForward: (lines) => lines.length > 0 && lines.every(isRsForwardLine),
  isForwardLine: isRsForwardLine,
  parseBindings,
  // Rust 没有 HTTP 路由声明这种统一写法，各家框架自己定，先不认
  parseRoutes: (): RouteDecl[] => [],
};
