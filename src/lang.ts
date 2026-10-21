/**
 * 语言模块的入口。
 *
 * 支持的语言才解析引用、判断深浅。认得出扩展名、但还没有语法模块的，单独记为 unsupported，
 * 不放进引用图，也不判假实现。既不是支持的、也不是「认得出但未支持」的，不当成代码。
 */

const SKIP = /(?:^|\/)(?:node_modules|vendor|dist|build|out|\.venv|venv|__pycache__|site-packages)\/|\.min\.[cm]?js$|\.d\.ts$/;

const JS_EXT = /\.(?:[cm]?[jt]sx?)$/;
const PY_EXT = /\.py$/;

/** 常见语言的扩展名。这里没有对应的语法模块 */
const UNSUPPORTED_EXT = /\.(?:java|go|rs|cs|c|cc|cpp|h|hpp|kt|kts|swift|rb|php|scala|m|mm)$/;

export type LangId = "js" | "py";

export function langOf(file: string): LangId | "unsupported" | null {
  if (SKIP.test(file)) return null;
  if (JS_EXT.test(file)) return "js";
  if (PY_EXT.test(file)) return "py";
  if (UNSUPPORTED_EXT.test(file)) return "unsupported";
  return null;
}

export const isSupportedCode = (file: string): boolean => {
  const lang = langOf(file);
  return lang === "js" || lang === "py";
};

export const isUnsupportedCode = (file: string): boolean => langOf(file) === "unsupported";
