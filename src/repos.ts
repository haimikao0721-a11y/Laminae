/**
 * laminae —— 目标仓库的解析
 *
 * 三种来源，优先级从高到低：
 *
 *   --repos a,b,c        / LAMINAE_REPOS     命令行或环境变量直接给
 *   <目录>/.laminae/repos.json               写在文件里，可审查、可提交
 *   单仓库                                   当前目录所在仓库
 *
 * 一个项目文件夹下常有多个子仓库（services/api、services/web、vendor/sdk……），
 * 在父目录运行 git rev-parse 会失败。这里的做法是：不硬失败，把下面的仓库列出来，
 * 让调用方决定是跑一个还是全跑。
 *
 * 注意：这里的「多仓库」只影响编排。每一次实际核验仍然只绑一个仓库 ——
 * git worktree、repoRelative、.git/info/exclude 全都假设只有一个仓库，
 * 那个约束没有放宽。
 */
import fs from "node:fs";
import path from "node:path";

/** 向下找子仓库时最多进几层。services/api 是第 2 层 */
const MAX_DEPTH = 3;

/**
 * 不进这些目录找。全是依赖或构建产物，进去只会又慢又容易认错。
 * 名字按常见的来，不追求穷尽。
 */
const SKIP = new Set([
  "node_modules",
  "vendor",
  "bower_components",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  "target",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".parcel-cache",
  ".gradle",
  ".idea",
  ".vscode",
  "Pods",
  "coverage",
  "tmp",
  "temp",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "site-packages",
]);

export interface SubRepo {
  /** 绝对路径 */
  abs: string;
  /** 相对父目录的路径，用 / 分隔 */
  rel: string;
}

/**
 * 判断一个目录是不是 git 仓库的根。
 * .git 可能是目录（普通仓库），也可能是文件（子模块、worktree）。
 */
function isRepoRoot(dir: string): boolean {
  try {
    const st = fs.statSync(path.join(dir, ".git"));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

/**
 * 在 dir 下面找仓库。找到就不再往下钻 —— 要的是最外层那几个，
 * 而不是把一个仓库里的嵌套仓库也当成并列的目标。
 */
export function findSubRepos(dir: string): SubRepo[] {
  const out: SubRepo[] = [];

  const walk = (cur: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const child = path.join(cur, e.name);
      if (isRepoRoot(child)) {
        out.push({ abs: child, rel: path.relative(dir, child).split(path.sep).join("/") });
        continue;
      }
      walk(child, depth + 1);
    }
  };

  // dir 自己就是仓库根时，不再往里找：那不是「包含多个子仓库的项目文件夹」
  if (!isRepoRoot(dir)) walk(dir, 1);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** repos.json 的形状：字符串数组，或 {name, path} 数组 */
type RepoEntry = string | { name?: string; path?: string };

export interface RepoSpec {
  /** 绝对路径 */
  abs: string;
  /** 显示名。默认取目录名 */
  name: string;
}

function toSpec(parent: string, e: RepoEntry): RepoSpec | null {
  const raw = typeof e === "string" ? e : e?.path;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const abs = path.resolve(parent, raw);
  const name = typeof e === "object" && typeof e.name === "string" && e.name.trim() !== ""
    ? e.name.trim()
    : path.basename(abs);
  return { abs, name };
}

/**
 * 读 <dir>/.laminae/repos.json。没有这个文件返回 null（区别于「有但写错了」）。
 * 写错了要抛，不能静默当成单仓库 —— 那会让人以为全跑了，其实只跑了一个。
 */
export function readReposFile(dir: string): RepoSpec[] | null {
  const file = path.join(dir, ".laminae", "repos.json");
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} 不是合法 JSON：${(e as Error).message}`);
  }
  const list = Array.isArray(raw) ? raw : (raw as { repos?: unknown })?.repos;
  if (!Array.isArray(list)) {
    throw new Error(`${file} 应当是数组，或带 repos 数组的对象，收到 ${JSON.stringify(raw).slice(0, 80)}`);
  }
  const specs: RepoSpec[] = [];
  for (const [i, e] of list.entries()) {
    const s = toSpec(dir, e as RepoEntry);
    if (s === null) throw new Error(`${file} 第 ${i + 1} 项没有 path`);
    if (!fs.existsSync(s.abs)) throw new Error(`${file} 第 ${i + 1} 项指向的目录不存在：${s.abs}`);
    specs.push(s);
  }
  if (specs.length === 0) throw new Error(`${file} 是空的`);
  return specs;
}

/** 解析 `a,b,c` 这种逗号分隔的清单。相对路径按 parent 展开 */
export function parseRepoList(parent: string, raw: string): RepoSpec[] {
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("仓库清单是空的");
  const specs: RepoSpec[] = [];
  for (const p of parts) {
    const abs = path.resolve(parent, p);
    if (!fs.existsSync(abs)) throw new Error(`仓库目录不存在：${abs}`);
    specs.push({ abs, name: path.basename(abs) });
  }
  return specs;
}

/** 去重：同一个绝对路径出现两次只跑一次 */
export function dedupe(specs: readonly RepoSpec[]): RepoSpec[] {
  const seen = new Set<string>();
  const out: RepoSpec[] = [];
  for (const s of specs) {
    const key = path.resolve(s.abs).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
