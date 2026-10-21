# 安全说明

[中文](SECURITY.md) | [English](SECURITY.en.md)

## 最需要知道的一件事：会执行 shell 命令

`claims.json` 里 `test-passes`、`invariant-holds`、`output-unchanged` 三种事实的 `command` 字段，会被交给 shell 执行：

```ts
spawnSync(command, { cwd, shell: true, timeout })
```

这意味着：

- **有管道、重定向、`&&`、命令替换**，不是只跑一个可执行文件
- **工作目录是该 commit 的临时 worktree**，但命令可以 `cd` 到任何地方，读写整个文件系统
- **没有沙箱，没有命令白名单，没有网络隔离**
- **权限与运行 `run.ts` 的人相同**

`command` 只做了长度限制（2000 字符），**没有经过 `repoRelative` 之类的路径校验**。

### 什么时候这是风险

`.laminae/claims.json` 是输入，来源有两种：

1. 你自己或你的 agent 在**自己的仓库**里写的 —— 风险与你自己执行一段脚本相同
2. **从别处拿到的** —— 别人给的仓库、别人给的 `claims.json`、一个 agent 读了不可信文档后写出来的

第二种要当心。这个项目的立论是「文档会骗人」：如果文档里埋了内容，诱导 agent 把某条命令写进 `claims.json`，那条命令会被执行。

**不要运行来源不明的 `.laminae/claims.json`。** 先读一遍里面的 `command`。

### 已经做过的约束

这些是**约定和边界检查，不是沙箱**：

- `file`、`fact.file`、`fact.base`、`fact.source`、想法的 `target` 必须是仓库内的相对路径，绝对路径与 `..` 会被拒绝
- 命令在临时 worktree 里跑，**不改目标仓库的主工作区**
- worktree 用完删除
- 默认超时 60 秒（`timeout` 可改）；超时会结束直接启动的进程，**它再启动的子进程不保证被清理**
- 多个仓库并行时，只要有一个用了这三种事实，就自动改成串行（避免抢端口和测试库）
- laminae 拒绝核验自己的仓库

### 没有做的

- 不限制命令能做什么
- 不隔离网络
- 不以低权限用户执行
- 不审计命令内容

需要这些的话，在外层自己包一层：容器、`firejail`、单独的用户、或者干脆不放行需要执行命令的事实类型。

---

## 不涉及的东西

- 数仓库的九种事实（`count-files`、`json-length`、`path-exists` 等）**只读 git 对象**，不执行任何东西，不检出、不修改目标仓库已跟踪的文件
- 生成的 `laminae.html` 单文件，无外部请求，不加载远程脚本或样式
- 报告里「去 GitHub 核对」的链接指向目标仓库自己的网页地址，是用户主动点击才跳转
- laminae 不收集、不上传任何东西，没有遥测

---

## 报告问题

发现安全问题时，请用 GitHub 的 [私密漏洞报告](https://github.com/haimikao0721-a11y/Laminae/security/advisories/new)，不要开公开 issue。

如果那个入口不可用，开一个不带细节的 issue 说明「想私下报告安全问题」，再约方式。

请在报告里说清楚：影响的是哪个环节（命令执行、路径校验、产物、依赖）、怎么复现、可能的后果。

---

## 依赖

没有运行时依赖。开发依赖三个（TypeScript、esbuild、@types/node），不进产物，见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 建议在仓库设置里打开的

- **Dependabot alerts**：`package-lock.json` 里的开发依赖有已知漏洞时会提示
- **Code scanning（CodeQL）**：公开仓库免费，能扫 `src/` 与 `web/` 的 TypeScript
- **Secret scanning**：公开仓库免费，防止误提交密钥

三项都在仓库的 Settings 里开，与运行 laminae 无关，但开着一个公开仓库该开的都开着。

---

## 许可

[MIT](LICENSE)。
