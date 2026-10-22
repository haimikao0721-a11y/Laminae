# 目录划分与命令地图

[中文](LAYOUT.md) | [English](LAYOUT.en.md)

两件事：五个命令各管什么，以及 `src/` 该怎么按职责分组。

## 命令地图

五个入口，都在目标仓库目录下运行。

| 命令 | 回答的问题 | 会不会改东西 |
|---|---|---|
| `scripts/run.ts` | main 上这句话错了多久、现在是什么状态 | 只写 `.laminae/` |
| `scripts/derive.ts` | 这些函数各自该做什么（AI 读代码，不读文档） | 只在 `--accept` 时追加 `ideas.json` |
| `scripts/trace.ts` | 从入口到空壳的调用路径是什么 | 不改 |
| `scripts/branches.ts` | 有没有分支修好了但没合进来 | 不改 |
| `scripts/merges.ts` | 合并有没有把某个修复弄丢 | 不改 |
| `scripts/verify.ts` | **这份报告是不是编出来的** | 不改 |

`verify` 已经接在 `run` 的流水线最后一步：每次生成报告都自动验一遍，不通过退出码非 0。**不依赖人记得去跑。**

**后四个都是只读**，且都从 git 对象直接读，工作区一次不动（`test-passes` 一类命令事实除外，那类要临时 worktree）。

### 它们之间的关系

```
run       判定：真假、假段、hiatus、层对账
derive    补充来源：文档之外，从代码推断
trace     解释判定：这个问题是从哪条路走下来的
branches  边界：main 之外还有没有别的状态
merges    边界：历史合并有没有把东西弄丢
```

## src/ 现在的问题

37 个模块、约 7,000 行，**平铺在一个目录里**。名字看不出归属：`types.ts` 和 `survival.ts` 平级，但一个是全局类型、一个是生存分析。

## 建议的划分

| 目录 | 放什么 | 现在的文件 |
|---|---|---|
| `core/` | 全局配置与基础设施 | `config` `gitutil` `types` `paths` `runid` `exclude` `repos` |
| `measure/` | 逐 commit 求值 | `claims` `facts` `observe` `compare` `lookup` `measure` |
| `judge/` | 从取值到判定 | `classify` `survival` `analyze` `accuracy` |
| `layers/` | 引用图与层对账 | `layers-core` `imports` `scan` `lang` `syntax*` `graph-core` `graph-util` `graph` |
| `ideas/` | 想法、边界、推断 | `ideas-core` `ideas` `candidates` `derive` |
| `output/` | 产物 | `build-data` `render` `indexhtml` `suggest` |

### 一个依赖方向上的约束

划分要能成立，**箭头只能往下走**：

```
scripts/  →  ideas/ layers/ judge/ measure/ output/ core/
web/      →  core/ measure/（只有 types、compare、graph-util）
```

**`core/` 不许反向依赖别的组**，否则又绕回去了。现在 `types.ts` 被所有组引用，正是它该在 `core/` 的理由。

## 搬动会牵动四个地方

这一步不是纯 `git mv`：

| 地方 | 为什么要改 |
|---|---|
| `src/` 内部 | 相对路径 `./x.ts` 变成 `../组/x.ts` |
| `web/` | 引用了 `types` `compare` `graph-util` 三个 |
| `scripts/` | 引用了 15 个模块 |
| `test/` | 21 种不同路径 |
| **`run.ts` 里的脚本路径** | 写死了 `"src/measure.ts"` 这种字符串，搬了要同步改 |
| **`test/` 里的脚本路径** | 同上，测试里也硬编码了 |

最后两行是真正容易漏的地方 —— 它们不是 import，是**字符串**，`tsc` 查不出来，只有跑测试才会炸。

## 搬动的正确顺序

1. 建目录，`git mv` 全部文件
2. 改 `src/` 内部的 import
3. 改 `web/` `scripts/` `test/` 的 import
4. **全局搜 `"src/xxx.ts"` 这类字符串并同步**（`run.ts` 与 `test/*.ts`）
5. `tsc --noEmit`
6. `npm test`（224 条）
7. 再 `npm run build:web`，确认前端包没坏

**第 5 步绿了不代表对**，第 6、7 步才是。字符串路径写错，只有运行时才暴露。

## 什么时候做

**要在有完整预算的时候做，不要在做别的改动做到一半时顺手做。**

它是零行为改动的纯搬动，一旦中途停下，仓库会处在「import 指向不存在的文件」的状态，比不改更糟。
