/**
 * laminae —— 跑命令之前的预检：把要执行的东西摊开给人看
 *
 * 为什么要有这一步：
 *
 * `test-passes` 这类事实会**执行命令**。命令来自 `.laminae/claims.json`，
 * 而那个文件是**可以被提交进仓库的**（`exclude.ts` 里明写了这条）。
 * 也就是说：克隆一个仓库、跑一次 laminae，就可能执行别人写好的命令。
 *
 * 同理，一份写得不好的 claims 会让工具在一万个 commit 上各跑一次测试 ——
 * 那不是安全问题是时间问题，但同样得先看见再决定。
 *
 * 所以跑之前先摊开三件事：
 *   一、这条命令到底长什么样（原文，不截断 —— 截断正好能藏住尾巴）
 *   二、它来自哪里（哪个说法、claims.json 是不是被 git 跟踪、最后一次谁改的）
 *   三、要跑多少次（commit 数；配了 watch 只会跑文件变了的那些）
 *
 * 这不是沙箱。沙箱会让人以为「关起来了」，这里要做的是让人**看见**。
 */
import type { ClaimDef } from "../core/types.ts";
import { isObserved } from "./facts.ts";

/** 一条要执行的命令，以及它会被执行多少次 */
export interface CommandPreview {
  claimId: string;
  label: string;
  type: string;
  /** 命令原文。不截断：截断正好能藏住尾巴 */
  command: string;
  timeoutSec: number | null;
  /** watch 的通配符。空数组表示每个 commit 都要跑 */
  watch: readonly string[];
  /** 主线上有多少个 commit */
  commits: number;
}

/** claims.json 的出处：谁放进来的 */
export interface ClaimsSource {
  file: string;
  /** 被 git 跟踪 = 它可能是随仓库来的，不一定是使用者自己写的 */
  tracked: boolean;
  /** 最后一次改它的人（只在被跟踪时有意义） */
  lastAuthor: string | null;
  lastDate: string | null;
}

export function previewCommands(claims: readonly ClaimDef[], commitCount: number): CommandPreview[] {
  return claims
    .filter((c) => isObserved(c.fact))
    .map((c) => {
      const f = c.fact as Extract<ClaimDef["fact"], { command: string }>;
      return {
        claimId: c.id,
        label: c.label,
        type: f.type,
        command: f.command,
        timeoutSec: f.timeout ?? null,
        watch: f.watch ?? [],
        commits: commitCount,
      };
    });
}

/**
 * 摊开给人看。
 *
 * 措辞上有两处是刻意的：
 *   - 「跑多少次」在没配 watch 时直接写总数，因为那才是一次测试套件跑一万遍的样子
 *   - 出处不是自己写的时候，说「这个文件是随仓库来的」，而不是说「不安全」
 */
/** 为什么没跑。null 表示会跑 */
export type SkipReason = "flag" | "untrusted" | null;

export function formatPreflight(previews: readonly CommandPreview[], source: ClaimsSource, skip: SkipReason): string {
  if (previews.length === 0) return "";
  const lines: string[] = [];

  if (skip !== null) {
    lines.push(
      skip === "flag"
        ? `命令类事实：${previews.length} 条，已按 --no-commands 跳过。`
        : `命令类事实：${previews.length} 条，没有执行 —— 这份 claims 不是你写的。`,
    );
    lines.push("  这些说法会记成「测不出来」，不会记成假 —— 没跑就是没跑，不是不成立。");
    lines.push("");
  } else {
    lines.push(`要执行 ${previews.length} 条命令。先看清楚它们是什么：`);
    lines.push("");
  }

  for (const p of previews) {
    lines.push(`  ${p.label}`);
    lines.push(`    命令  ${p.command}`);
    const runs = p.watch.length === 0 ? `主线上 ${p.commits} 个 commit，每个都要跑一次` : `watch ${p.watch.join(" ")}（只有这些文件变了的 commit 才跑）`;
    lines.push(`    次数  ${runs}`);
    lines.push(`    超时  ${p.timeoutSec === null ? "默认 60 秒" : `${p.timeoutSec} 秒`}`);
    lines.push("");
  }

  lines.push(`  出处  ${source.file}`);
  if (source.tracked) {
    // 这句是整个预检里最要紧的一行：命令是随仓库来的，还是使用者自己写的，性质完全不同
    lines.push(`        **这个文件被 git 跟踪**，是随仓库来的，不一定是使用者自己写的`);
    if (source.lastAuthor) lines.push(`        最后一次修改：${source.lastAuthor}，${source.lastDate ?? "日期未知"}`);
    if (skip === null) lines.push(`        确认之后要跑，不确认就加 --no-commands 跳过`);
  } else {
    lines.push(`        没有被 git 跟踪，是本地的文件`);
  }

  return lines.join("\n");
}
