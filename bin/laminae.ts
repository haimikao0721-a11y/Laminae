#!/usr/bin/env node
/**
 * laminae —— 统一入口
 *
 *   laminae <命令> [参数...]
 *
 * 八个脚本还是各自独立的文件，这里只做分发：**不重写逻辑，只加一层壳**。
 * 每个命令仍然是「在哪个项目目录下运行，就核验哪个项目」。
 *
 * 为什么要有这一层：原来要记住八个路径，还得记住每个脚本的参数；
 * 装成全局命令之后是一件事。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

interface Command {
  /** 脚本在仓库里的相对路径 */
  file: string;
  /** 一句话：它回答什么问题 */
  summary: string;
  /** 什么时候用它 */
  when: string;
  /** 典型用法 */
  usage: string;
}

const COMMANDS: Record<string, Command> = {
  init: {
    file: "scripts/init.ts",
    summary: "从文档里挑候选说法，在 HEAD 上核一遍，写成 claims.json",
    when: "第一次在这个仓库上用；或者文档大改之后想补几条说法",
    usage: "laminae init [--dry-run] [--yes] [--limit N] [--all] [--out 文件]",
  },
  run: {
    file: "scripts/run.ts",
    summary: "跑完整流水线，产出单文件 HTML 报告",
    when: "日常；改了解析或规则之后",
    usage: "laminae run [--run id] [--from 步骤] [--to 步骤] [--no-commands] [--trust-commands]",
  },
  diff: {
    file: "scripts/diff.ts",
    summary: "比较两次运行：改了一条规则之后，结论从哪一条开始不一样",
    when: "改完规则，想知道影响了哪些结论",
    usage: "laminae diff <旧运行> <新运行> [--json] [--out 文件]",
  },
  verify: {
    file: "scripts/verify.ts",
    summary: "校验产物：报告里的每个数能不能从 git 重新算出来",
    when: "怀疑报告被动过，或者想确认它不是编出来的",
    usage: "laminae verify [--run id] [--json]",
  },
  derive: {
    file: "scripts/derive.ts",
    summary: "从代码推每个函数该做什么，出想法草稿",
    when: "想从代码反推接口该长什么样",
    usage: "laminae derive [--accept]",
  },
  trace: {
    file: "scripts/trace.ts",
    summary: "从入口追到空壳的调用路径，可拆子任务",
    when: "定位一条链要从哪儿下手",
    usage: "laminae trace [--file 文件] [--at 文件#函数] [--find 关键词] [--json]",
  },
  branches: {
    file: "scripts/branches.ts",
    summary: "有没有分支已经修好了但没合进来",
    when: "合并之前清一遍",
    usage: "laminae branches [--all] [--json]",
  },
  merges: {
    file: "scripts/merges.ts",
    summary: "合并有没有把某个修复弄丢",
    when: "大量合并之后核对一遍",
    usage: "laminae merges [--json]",
  },
};

const ORDER = ["init", "run", "diff", "verify", "derive", "trace", "branches", "merges"];

function version(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function help(): string {
  const lines: string[] = [
    "laminae —— 把文档里的一句话，在每个 commit 上验一遍真假",
    "",
    "用法",
    "  laminae <命令> [参数...]",
    "",
    "命令",
  ];
  for (const name of ORDER) {
    const c = COMMANDS[name]!;
    lines.push(`  ${name.padEnd(10)}${c.summary}`);
  }
  lines.push(
    "",
    "第一次用",
    "  1. 进到要核验的仓库根目录（哪个目录都行，工具自己找仓库）",
    "  2. laminae init --dry-run     先看看文档里能挑出什么，不写文件",
    "  3. laminae init               逐条确认，写出 .laminae/claims.json",
    "  4. 把生成的 fact 改成该数的东西（草稿里是占位）",
    "  5. laminae run                跑完在 .laminae/runs/<id>/laminae.html",
    "",
    "看某个命令的细节",
    "  laminae <命令> --help",
    "",
    "文档",
    `  ${ROOT}`,
    "  README.md / docs/STATUS.md / docs/LESSONS.md / docs/REFERENCE.md",
  );
  return lines.join("\n");
}

function commandHelp(name: string): string {
  const c = COMMANDS[name]!;
  return [
    `laminae ${name} —— ${c.summary}`,
    "",
    "用法",
    `  ${c.usage}`,
    "",
    "什么时候用",
    `  ${c.when}`,
    "",
    "它还是那个脚本，参数一模一样：",
    `  ${path.join(ROOT, c.file)}`,
  ].join("\n");
}

function main(): void {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    console.log(help());
    return;
  }
  if (first === "--version" || first === "-v" || first === "version") {
    console.log(version());
    return;
  }

  const name = first;
  const command = COMMANDS[name];
  if (command === undefined) {
    console.error(`不认识的命令：${name}`);
    console.error("");
    console.error(`可用的：${ORDER.join("、")}`);
    console.error("输 laminae --help 看全部。");
    process.exit(1);
  }

  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(commandHelp(name));
    return;
  }

  // 装成包之后跑的是打包产物（Node 不给 node_modules 下的 .ts 擦除类型）；
  // 在仓库里直接跑时没有 build/，就退回源码。两边走的是同一份逻辑。
  const built = path.join(ROOT, "build", `${name}.mjs`);
  const source = path.join(ROOT, command.file);
  const file = fs.existsSync(built) ? built : source;
  if (!fs.existsSync(file)) {
    console.error(`找不到 ${built}，也没有 ${source}。安装不完整？重装一次。`);
    process.exit(1);
  }

  // 直接用当前这个 node 跑那个脚本：不经过 shell，参数原样传，
  // 子进程的退出码原样返回 —— 脚本自己怎么判断成功失败，这里不改。
  const child = spawn(process.execPath, [file, ...rest], {
    stdio: "inherit",
    cwd: process.cwd(),
    windowsHide: false,
  });
  child.on("error", (e) => {
    console.error(`启动失败：${e.message}`);
    process.exit(1);
  });
  child.on("close", (code) => process.exit(code ?? 1));
}

main();
