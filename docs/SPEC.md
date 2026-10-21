# laminae 设计规格

[中文](SPEC.md) | [English](SPEC.en.md)

本文档说明 laminae 的数据模型、测量方式和界面实现。运行方式见根目录 `README.md`。

---

## 一、测量

- 一次运行只绑一个仓库：运行时所在目录的 git 根（可用 `LAMINAE_REPO` 覆盖）。这个根不能是 laminae 自己的仓库。说法里的文件路径必须是该仓库内的相对路径。laminae 的代码里不含任何具体项目的路径或数字
- 逐 commit 从 git 对象库读取文件内容。数仓库的事实不检出、不修改目标仓库已跟踪的文件。`test-passes`、`invariant-holds`、`output-unchanged` 在临时 git worktree 里执行 claims.json 写的命令，测完删除，不改主工作区。生成物写在目标仓库内：`.laminae/data/` 与 `laminae.html`
- 提交序列取 `git log --first-parent --reverse`，只沿主线，每次合并只算合并提交本身；被合并分支上的提交不进入序列，否则同一条说法的真假会在不同分支的状态之间来回跳。`measure.ts` 与 `build-data.ts` 共用 `config.ts` 里的 `LOG_ARGS`，两边按下标对齐，参数必须一致
- 每条说法在目标仓库的 `.laminae/claims.json` 中声明（路径可用 `LAMINAE_CLAIMS` 覆盖）：

| 字段 | 含义 |
|---|---|
| `id` | 唯一标识 |
| `file` | 说法所在文件 |
| `locator` | 定位正则，第 1 个捕获组是文档断言的那个数 |
| `fact` | 被测事实的声明 |
| `label` | 显示名，缺省为 `id` |
| `impact` | `high` / `normal` / `low`，缺省 `normal`。由使用者标注，只用于页面上的标签与「按重要程度」排序，不进入 hiatus、生存曲线或闭合率的任何计算 |
| `compare` | `eq`（缺省）/ `gte` / `lte` / `approx`。数值型说法里，「文档写的数」与「事实」满足该关系为真，否则为假。`gte`：事实 ≥ 文档的数；`lte`：事实 ≤ 文档的数；`approx`：`abs(事实 − 文档的数) ≤ tolerance × abs(文档的数)`（文档写 0 时只认 0）。引用型事实只能是 `eq`。「还不存在」「测不出来」的判定与它无关，结局分类（reality-caught-up 等）也只看数值有没有变，不受它影响 |
| `tolerance` | 仅 `approx`，0 到 1 的相对误差，缺省 `0.05` |

- 事实由声明式的 `fact` 描述，不写进代码。类型见 `src/facts.ts`：

| `type` | 测到的数 |
|---|---|
| `count-files` | 匹配 glob 的文件数 |
| `json-length` | JSON 里数组的长度或对象的键数 |
| `json-number` | JSON 里的数值字段 |
| `regex-count` | 正则在文件中的匹配次数 |
| `line-count` | 文件行数 |
| `file-bytes` | 文件字节数 |
| `test-passes` | 命令退出码 0 为 1，非 0 为 0。文档断言恒为 1（应该通过）。声称变没变看说法所在文件（或 `source`）的正文 |
| `invariant-holds` | 同 `test-passes`，语义是不变量 |
| `output-unchanged` | 标准输出相对「locator 捕获文本第一次出现时」相同为 1，不同为 0。捕获文本变了，基线重置。不判断输出对不对 |

超时或进程起不来为「测不出来」。`watch` 里的文件内容没变则复用上一次的结果。这三种的 `compare` 只能是 `eq`。

- 层与层的对账（`layers-core.ts`，自动，不需要在 claims.json 里声明，只认 JS/TS/Python）：成立的结论分三档。假实现 = 结构上是空的（空文件、写着没实现、函数只返回空值或常量）；路由路径对上但处理函数是空的也算。认不出算错了。被盖住 = 纯转发、只有测试引用、`gte`/`lte`/`approx` 且相对差额至少 15% 同时绝对差额至少 2、别名解析不了、处理函数追出仓库、文档写成区间但只捕获了一个数。有实质代码 = 排除了前两档，不表示真的实现了说法里的事。**这三档之外还有两类，不参与分档**：孤立模块 = 没被引用、不是入口或测试、也没被任何说法或想法提到；契约 = 按种类配对，只有一侧存在时列出来并写明不算洞，两侧都在而某处引用了一个没人声明的名字才算对不上。Python 路由把 `APIRouter(prefix=)` 与 `include_router(..., prefix=)` 拼进路径，包括跨文件的一次挂载和嵌套挂载（最多 6 层）。注入线索只标位置，不裁决。
- 引用型事实：文档写的不是数，而是对仓库内某物的引用。`locator` 捕获的是引用文本，被测事实是它存不存在（1 或 0），文档断言为 1。「文档写的」一列记录的是引用文本的编号，因此引用被改成另一个目标会被看作文档动了：

| `type` | 为真的条件 |
|---|---|
| `path-exists` | 捕获的路径是仓库里的文件或目录（可选 `base` 作为相对目录） |
| `text-in-file` | 捕获的文本在 `file` 中出现过 |
| `json-has-key` | 捕获的名字是 `file` 里 `path` 处对象的键 |

  捕获不到文本、文件读不到、JSON 损坏、`path` 不存在，都是「测不出来」。已知限制：文档把引用改到新目标时，事实也随之变成「新目标存不存在」，收场通常记为「两边都变了」。一条说法只取第一个匹配
- 被测事实在每个 commit 上独立测量，与文档里的数比较，得到该 commit 上的真假。事实读不到时返回空值，该 commit 记为「测不出来」
- 说法定义读取时校验：`id` 不重复，`locator` 是合法正则且至少有一个捕获组，`fact` 的类型和参数合法。错误信息指出具体是哪一条的哪个字段
- 每个 commit 上，`claims.json` 里出现过的所有文件都会读取正文；某个文件在该 commit 上读不到，记为空串（即说法「还不存在」）
- 支持数字型说法、引用型说法，以及跑出来的说法（测试过不过、不变量成不成立、输出变没变）。没有对应命令的自然语言（如「这个函数的行为是……」）不支持

### 调用关系图、想法与边界

与说法共用同一条 commit 序列（`LOG_ARGS`），按下标对齐，只读 git 对象。

- **模块引用图**：每个 commit 上取代码文件（JS/TS/Python，排除 `node_modules`、`dist`、`vendor`、`.d.ts`、压缩文件）并解析 import，解析不到仓库内文件的引用丢弃。节点和边都存成「在哪些 commit 区间存在」的游程，代码文件集合与 `package.json` 都没变的相邻 commit 复用上一次结果。文件超过 350 个时，从目录深度往浅处找到第一个节点数不超限的合并粒度；同一组内部的引用不画。测试文件打标，界面默认隐藏。
- **想法与边界**：`.laminae/ideas.json` 里每条是 `target` + 引用型 `fact` + `expect`（`present`/`absent`）。逐 commit 求事实的存在性，与 `expect` 一致为「满足」（想法：已完成；边界：守住），不一致为「不满足」，读不到为「测不出来」。边界缺省 `expect: absent`。fact 也可以是 `import-edge`（`from`、`to` 两个路径，没有 `target`）：逐 commit 看 `from` 下有没有文件引用了 `to` 下的文件，有引用等同于「证据存在」。没找到引用时，如果 `from` 下有名字带着 `to` 的、解析不了的别名引用，或 `from` 下没有引用图支持的语言的代码，则记「测不出来」而不是「不存在」。「退回」指满足之后又变为不满足，中间的「测不出来」不算。
- **线索**：路线图里的 `- [ ]`/`- [x]` 清单与 TODO/FIXME 只作为未确认的线索展示并统计数量趋势，不参与任何判定。

---

## 二、数据模型

完整类型见 `src/types.ts`。每条说法生成一条时间线：

| 字段 | 含义 |
|---|---|
| `id` / `label` | 标识与显示名 |
| `file` / `line` | 说法所在文件，以及 HEAD 上的行号 |
| `verbatim` | HEAD 上的逐字原文 |
| `verbatimRuns` | 原文随 commit 的变化，行程编码，同一行措辞只存一次 |
| `states` | 每个 commit 一格的真假状态 |
| `claimed` / `actual` | 每个 commit 上「文档写的数」与「实际测到的数」 |
| `runs` | 假段列表 |
| `bornFalse` | 写下即假，从未真过 |
| `atHead` / `totalFalse` | HEAD 上的状态，累计为假的 commit 数 |

### 状态

| 值 | 含义 |
|---|---|
| 0 | 真 |
| 1 | 假 |
| 2 | 还不存在（文档里找不到这条说法；页面上显示为「尚未写入文档」） |
| 3 | 测不出来（说法在文档里，但测不到对应的事实） |

- 「还不存在」与「假」分开存储：一条说法在被写下之前不是假，只是还没有。
- 「测不出来」与「还不存在」分开存储：说法明明在文档里，只是事实读不到（例如被测文件在那个 commit 上缺失或损坏）。混在一起，说法会在图上凭空消失，「说法被删掉」的结局也无法与之区分。

判定规则在 `src/classify.ts` 的 `judgeState`。

### 假段

连续为假的 commit 区间为一个假段（`Run`），记录起止 commit、长度（commit 数与小时数）、是否到 HEAD 仍未结束（右删失）、假段期间现实有没有变化，以及结局。

「现实有没有变化」的窗口从假段的前一格开始算（`didRealityMove`）。说法常常正是因为现实在假段第一格上变了才变假的，只看假段内部会漏掉这次变化。

### 结局

| 结局 | 含义 |
|---|---|
| `hanging-reality-still` | 到 HEAD 仍为假，现实一直没动 |
| `hanging-reality-moved` | 到 HEAD 仍为假，现实已经动过 |
| `reality-caught-up` | 现实追上了说法 |
| `doc-caught-up` | 现实先动，文档后补 |
| `doc-corrected` | 现实没动，文档本来就写错，后来改正 |
| `doc-removed` | 假段之后说法在文档里消失（说法被删掉或改模糊） |
| `unmeasurable` | 假段之后事实测不出来，无法判定怎么收场 |
| `both-changed` | 说法与事实在同一个 commit 上一起变，无法判定 |
| `anomaly` | 无故翻转 |

结局由 `src/classify.ts` 的 `classify` 判定，判定顺序为：到 HEAD 仍为假 → 说法消失 → 事实测不出来 → 现实追上说法 → 两边同时变 → 文档追上现实 → 文档被改正。

右删失（`censored`）指假段到 HEAD 仍未结束，或之后事实测不出来、不知道何时结束。说法被删掉是一次明确的结束，不算删失。

### 汇总

`Summary` 包含：说法数、commit 数、时间跨度、曾为假数、HEAD 上仍为假数、写下即假数、假段数、右删失段数、hiatus 的生存估计（`survival`）、结局分布，以及收场方向汇总（`closure`）。

#### hiatus 的生存估计

到 HEAD 仍挂着的假段是右删失的：只知道它至少挂了这么久，真实长度还会继续变长。如果把它们当成「就结束在这里」去取中位数，结果会系统性偏小（例如两段分别挂了 5、6 个 commit 后结束，另有三段刚变假 1 个 commit，朴素中位数是 1，而这三段并没有结束）。所以中位 hiatus 用 Kaplan-Meier 估计（`src/survival.ts`）：

- 样本：先真后假的假段。写下即假的那一段不进样本，它量的是「文档一开始就写错了多久」，不是「真的说法漂移后挂了多久」。每段的 `Run.bornFalse` 标记它。
- 事件：假段真的结束了（`censored` 为 false，包括说法被删掉）。删失：到 HEAD 仍为假，或之后事实测不出来（`isCensored`，见 `classify.ts`）。
- 同一时刻既有结束又有删失时，删失的算在该时刻仍在风险中。
- 中位数是生存概率降到 0.5 以下的最早时刻。曲线始终高于 0.5 时为 `null`，表示删失太多、无法估计，不会用一个数硬凑。
- 同时给出以 commit 数和以小时数为单位的两个中位数。样本数 `n` 与删失数一起展示，样本很少时中位数很不稳。

校验用的是教科书上的 6-MP 例子（见 `test/survival.test.ts`）。

#### 收场方向

`closure` 把已收场的假段按方向拆开，基数是全部假段（含写下即假的那一段）：

| 字段 | 含义 | 对应结局 |
|---|---|---|
| `docUpdated` | 靠改文档消失，说法还在 | `doc-caught-up`、`doc-corrected` |
| `docRemoved` | 靠删掉说法消失 | `doc-removed` |
| `realityFixed` | 靠改现实消失 | `reality-caught-up` |
| `undetermined` | 收场了，但方向判不出 | `both-changed`、`unmeasurable`、`anomaly` |
| `pending` | 到 HEAD 仍挂着 | `hanging-*` |

`determinable` 是 `docUpdated + docRemoved + realityFixed`，页面上的百分比以它为分母。

hiatus 与结局都在构建期算好，前端只负责渲染。

---

## 三、界面

产物是单个 HTML 文件，内含一张状态历史图：横轴 commit，纵轴说法，每格是该 commit 上的真假。逐格不合并，每一格都可以点开查看该 commit 上的原文。

点击一格打开抽屉，内容见 `README.md`。

状态图下方是「每条说法的假段」列表（`web/app.ts` 的 `renderDetails`），把每个假段讲成两行：开始（commit、提交标题、变假时文档写的与实际的数）和结束（commit、提交标题、收场方式、持续时间）。到 HEAD 仍为假的假段没有结束 commit，改写为「到 HEAD 仍为假」，并说明期间现实有没有动过。列表跟随搜索与预设视图，没有出现过假段的说法只计数。`test/browser.test.ts` 用无头浏览器加载生成的页面检查这部分渲染（找不到 Chrome 或 Edge 时跳过）。

实现方式：

- 一格一个 `div`，用 CSS Grid 排版，不使用 SVG 和图表库
- 十字高亮与主题切换通过 CSS 变量和属性选择器实现
- 键盘可达：`role="gridcell"` 加 `tabindex="0"`
- 单文件，无外部请求；出图用无头 Chrome 渲染
- 浏览器端脚本预先编译为 `dist/app.js` 并入库，`render.ts` 把它与 `web/style.css`、数据一起内联。因此在目标项目里运行不需要 esbuild 或任何安装；改了 `web/` 后必须重新运行 `npm run build:web` 并提交 `dist/app.js`

---

## 四、已知限制

以下行为由 test/pipeline.test.ts 固定：

- 说法所在文件被改名或移动后，旧路径读不到，说法会被当作消失（状态变为「还不存在」；若此前正处于假段，结局为 doc-removed），不会跟踪改名。
- 事实文件缺失或损坏时，该 commit 上的状态是「测不出来」，不会被当作假。
