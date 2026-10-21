/**
 * laminae —— 运行标识
 *
 * 每次运行落到 .laminae/runs/<id>/ 下，带上自己的 payload.json 与 laminae.html。
 * 不覆盖上一次的产物，是为了留下每次调用的快照：某一天的报告说了什么、换了判定规则之后
 * 同一个仓库的结论从哪一条开始不一样、仓库本身动了多少。
 *
 * 这跟「这句话错着多久」不是一回事。那个由一次运行内的逐 commit 假段回答（hiatus），
 * 一份报告就够了，用不着两份。两份报告回答的是另一次调用之间报告变没变 ——
 * 而把两份 payload.json 对起来的命令还没有做，目前只能自己 diff。
 *
 * id 的两种来源：
 *   默认  按开始时间生成，形如 20261020T031422
 *   指定  --run <名字> 或 LAMINAE_RUN=<名字>，用于「重构前」「v1.2 发版后」这类意图
 *
 * 名字只能含字母、数字、点、下划线、连字符。不允许 `..`、`/`、`\`，
 * 免得一个来自外部的字符串把产物写到仓库外面去。
 */
import fs from "node:fs";
import path from "node:path";

/** 最长 64，够放时间戳也够放一个可读的名字 */
const MAX_LEN = 64;

/** 允许的字符。刻意不含空格：命令行、URL、文件系统三处都不需要转义 */
const SAFE = /^[A-Za-z0-9._-]+$/;

export interface RunIdProblem {
  ok: false;
  reason: string;
}
export interface RunIdOk {
  ok: true;
  id: string;
}
export type RunIdCheck = RunIdOk | RunIdProblem;

/** 校验一个运行 id。不合法时给出为什么，不做静默兜底 */
export function checkRunId(raw: string): RunIdCheck {
  const id = raw.trim();
  if (id === "") return { ok: false, reason: "不能为空" };
  if (id.length > MAX_LEN) return { ok: false, reason: `最长 ${MAX_LEN} 个字符，收到 ${id.length} 个` };
  if (id.includes("..")) return { ok: false, reason: "不能含 .." };
  if (/[\\/]/.test(id)) return { ok: false, reason: "不能含路径分隔符" };
  if (!SAFE.test(id)) {
    const bad = [...new Set(id.split("").filter((c) => !SAFE.test(c)))].join("");
    return { ok: false, reason: `只能含字母、数字、点、下划线、连字符，收到 ${JSON.stringify(bad)}` };
  }
  // Windows 上 . 和 .. 作为目录名不可用，前面已挡 ..，这里挡单独的 .
  if (/^\.+$/.test(id)) return { ok: false, reason: "不能只是点" };
  return { ok: true, id };
}

/** 按本地时间生成，形如 20261020T031422。不带冒号：Windows 目录名不允许 */
export function defaultRunId(now: Date = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `T${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/**
 * 同一秒可能跑两次（脚本里连着调用），加序号避免撞车。
 * 撞了不覆盖：宁可多一个目录，也不要把上一次的产物顶掉。
 */
export function uniqueRunId(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const next = `${base}-${i}`;
    if (!taken(next)) return next;
  }
  // 一秒钟一千次不可能，走到这里说明 taken 的实现坏了，不要静默改名
  throw new Error(`无法为 ${base} 找到空闲的运行 id`);
}

/** latest 指针文件名。放在 .laminae 下，和 runs/ 并列 */
export const LATEST_FILE = "latest";

/** 写 latest 指针。内容就是 id 加一个换行，方便 cat */
export function writeLatest(workDir: string, id: string): void {
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, LATEST_FILE), id + "\n", "utf8");
}

/** 读 latest 指针。没有或读不出来返回 null */
export function readLatest(workDir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(workDir, LATEST_FILE), "utf8").trim();
    return raw === "" ? null : raw;
  } catch {
    return null;
  }
}

/**
 * 列出已有的运行 id，按目录名排序（默认 id 是时间戳，所以即时间序）。
 * 只认目录，忽略 latest 之类的文件。
 */
export function listRuns(runsDir: string): string[] {
  try {
    return fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
