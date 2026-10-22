/**
 * laminae —— 输入输出路径
 *
 * 每次运行落到自己的目录下，不覆盖上一次：
 *
 *   <目标仓库>/.laminae/claims.json          说法定义（输入，人或 agent 写）
 *   <目标仓库>/.laminae/ideas.json           想法与边界（输入，选填）
 *   <目标仓库>/.laminae/latest              最近一次运行的 id
 *   <目标仓库>/.laminae/data/               中间数据（共享，每次覆盖，可删）
 *   <目标仓库>/.laminae/runs/<id>/
 *       payload.json                        完整数据，够重渲染；两份之间可以自己 diff
 *       laminae.html                        报告
 *
 * 只有 payload.json 与 laminae.html 是留档的。中间数据（facts / timeline / graph）
 * 是可重建的草稿，共享一份、每次覆盖，免得几百个 commit 的仓库把磁盘吃光。
 *
 * 运行 id 由 scripts/run.ts 解析一次并通过 LAMINAE_RUN 传给每一步。
 * 单独手跑某一步时若没设 LAMINAE_RUN，会新开一个 id —— 那不是同一次运行。
 *
 * 测试通过环境变量把路径改到临时目录：
 *
 *   LAMINAE_RUN      运行 id
 *   LAMINAE_CLAIMS   说法定义文件
 *   LAMINAE_IDEAS    想法与边界文件
 *   LAMINAE_DATA     中间数据目录
 *   LAMINAE_HTML     报告输出路径
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO } from "./config.ts";
import { checkRunId, defaultRunId, uniqueRunId, listRuns, readLatest } from "./runid.ts";
import fs from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** laminae 自身（skill）的根目录，用来找预构建的浏览器端脚本与样式 */
export const SKILL_ROOT = path.resolve(HERE, "../..");

const env = (name: string): string | undefined => (process.env[name] ? path.resolve(process.env[name]!) : undefined);

/** 目标仓库里 laminae 专属的目录 */
export const WORK_DIR = path.join(REPO, ".laminae");

/** 历次运行的父目录 */
export const RUNS_DIR = path.join(WORK_DIR, "runs");

/** 说法定义文件 */
export const CLAIMS_PATH: string = env("LAMINAE_CLAIMS") ?? path.join(WORK_DIR, "claims.json");

/** 想法与边界定义文件（选填） */
export const IDEAS_PATH: string = env("LAMINAE_IDEAS") ?? path.join(WORK_DIR, "ideas.json");

/** 中间数据目录。共享，每次覆盖 */
export const DATA_DIR: string = env("LAMINAE_DATA") ?? path.join(WORK_DIR, "data");

/**
 * 本次运行的 id。
 *
 * 优先级：
 *   1. LAMINAE_RUN=<id>   用这个 id（scripts/run.ts 就是这样把六步绑到同一次运行）
 *   2. LAMINAE_RUN=new    新开一个（--new-run 也走这条）
 *   3. 都没设             接着 .laminae/latest 指向的那次；没有 latest 才新开一个
 *
 * 第 3 条是为了让「每一步都可以单独运行」真的成立：手跑 build-data 再手跑 render，
 * 两者要落在同一个目录里，否则 render 找不到 payload。整次运行请走 scripts/run.ts，
 * 它总会显式给一个 id，不会误碰旧的那次。
 */
export function resolveRunId(): string {
  const fresh = (): string => uniqueRunId(defaultRunId(), (id) => fs.existsSync(path.join(RUNS_DIR, id)));

  const fromEnv = process.env["LAMINAE_RUN"];
  if (fromEnv === "new") return fresh();
  if (fromEnv !== undefined && fromEnv !== "") {
    const r = checkRunId(fromEnv);
    if (!r.ok) throw new Error(`LAMINAE_RUN ${JSON.stringify(fromEnv)} 不合法：${r.reason}`);
    return r.id;
  }

  const latest = readLatest(WORK_DIR);
  if (latest !== null) {
    const r = checkRunId(latest);
    if (r.ok && fs.existsSync(path.join(RUNS_DIR, r.id))) return r.id;
  }
  return fresh();
}

/** 本次运行的 id */
export const RUN_ID: string = resolveRunId();

/** 本次运行的目录 */
export const RUN_DIR: string = path.join(RUNS_DIR, RUN_ID);

/** 完整数据。够重渲染；两份之间可以自己 diff，工具还没有对比命令 */
export const PAYLOAD_PATH: string = path.join(RUN_DIR, "payload.json");

/** 报告输出路径 */
export const HTML_PATH: string = env("LAMINAE_HTML") ?? path.join(RUN_DIR, "laminae.html");

/** 快照目录（scripts/snapshot.ts 用）。从 WORK_DIR 推导，不从 HTML_PATH 推导 */
export const SHOTS_DIR: string = path.join(WORK_DIR, "shots");

/** latest 指针文件。内容是最近一次运行的 id */
export const LATEST_PATH: string = path.join(WORK_DIR, "latest");

/** 已有的运行 id，按时间序 */
export function existingRuns(): string[] {
  return listRuns(RUNS_DIR);
}

/**
 * 说法里的路径必须落在目标仓库内。绝对路径和 `..` 不接受。
 * 仓库外的文件不属于这一次绑定。
 */
export function repoRelative(p: string, where: string): string {
  const norm = p.replace(/\\/g, "/").trim().replace(/^\.\//, "").replace(/\/+$/, "");
  const escapes = norm === "" || norm.startsWith("/") || /^[A-Za-z]:/.test(norm) || norm.split("/").includes("..");
  if (escapes) throw new Error(`${where}：必须是目标仓库内的相对路径，收到 ${JSON.stringify(p)}`);
  return norm;
}
