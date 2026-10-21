---
name: laminae
license: MIT
description: Checks whether two sides of a repository agree (a doc claim and a measurable fact, or two artifacts the user names), commit by commit when git history exists, and writes a self-contained HTML report. Do not replace the user's real question with a file-exists check. If the question cannot be measured, say so. Module graph and hollow-function checks only understand JS/TS and Python.
disable-model-invocation: true
---

# laminae

[中文](SKILL.md) | [English](SKILL.en.md)

在当前项目里运行：先听用户要查什么，再在仓库里找两边应该一致的东西，核对它们是否一致，在 `.laminae/runs/<id>/laminae.html` 生成报告（`.laminae/latest` 里写着最近一次的 id）。没有 Markdown 就用代码、规则、测试里已经写明的契约。没有 git 历史就只对当前代码做一次对照。

引用图、引用边界、假实现和「被盖住」只认 JS/TS 和 Python。Java、Go、Rust、C# 只能核验不看语法的说法（文件个数、路径、文本、JSON 键）。不要向用户承诺这些语言的模块关系或实现深浅。

一次运行只绑一个仓库：当前目录的 git 根，或 `LAMINAE_REPO`。这个根不能是 laminae 自己，否则直接停，不写文件。范围只有这份仓库的主线（`git log --first-parent`）。说法和想法在它的 `.laminae/`，报告在它的根。事实只读这份 git 对象；要跑的命令只在它的临时工作区里执行。说法里的路径必须是仓库内的相对路径，`..` 和绝对路径不接受。

不在这次绑定里的：别的分支、别的仓库、工具自己的目录、仓库外面的文件。公式算得对不对也不在「数仓库」的范围内，除非写成测试、不变量或输出差分。skill 自己不含任何具体项目的路径、数字或文件名。

## 流程

1. 先写下一句用户真正要查的事。酬金算得对不对、接口接上没有、某段逻辑是不是空的，都算。不要改写成「某个文件在不在」。
2. 在仓库里找出两边。一边是声称，一边是能测量的事实。**先查 [docs/PATTERNS.md](docs/PATTERNS.md)**：真实文档里的说法就那么几类，每类能用什么事实测、什么时候测不了，写在那里，不要每次从头想。核的事情必须是错了会让人做错事的。公式、口径、加总，判据不在文件形状里：用 `test-passes`（这条测试过不过）、`invariant-holds`（这条性质成不成立）或 `output-unchanged`（文档说不该变、输出变没变）。数文件、对路径、对 JSON 键只回答「在不在」，不许拿来代替上面那些问题。没有文档就用代码和测试。找不到能跑的判据，就停下来告诉用户「这个问题核不准」，并列出读过的文件。禁止用一条 `path-exists` 或 `text-in-file` 代替。
3. 只有用户确认之后，才把能测的那几条写进 `.laminae/claims.json`。写之前用命令把内容查出来，不要把文件或 JSON 读进上下文。写的时候注明这次没覆盖什么。
4. 在要核验的目录运行（必须是 git 仓库；没有提交历史就先说明只能看当前文件，不要编造时间线）：

   ```bash
   node <skill 目录>/scripts/run.ts
   ```

5. 报告在 `.laminae/runs/<id>/laminae.html`，先读 `.laminae/latest` 拿到 id。向用户说明三件事，不要混在一起：
   - **已确认不一致**：声明和测到的事实对不上，报告里有两边的值和位置。
   - **无法验证**：工具没追上（路由装饰器接不上、语言不认识、别名解析不了）。这不是缺陷清单。
   - **需要人工复核**：空函数、纯转发、只有测试在引用。只是迹象，不能当成已经抓到的业务错误。

需要 git，以及能直接运行 `.ts` 文件的 Node。目标项目不需要安装依赖。报「找不到 node / 不能运行 .ts」时，先检查环境：

```bash
powershell -File <skill 目录>/scripts/setup.ps1   # Windows
bash <skill 目录>/scripts/setup.sh                # macOS / Linux
```

默认只检查并打印缺项的安装命令，不改系统。只有用户同意后才加 `-Install`（`setup.sh` 为 `--install`），不要擅自安装。

## 挑选说法

只选对读者有实际意义、数错了会误导人的说法，一般一二十条以内。每多一条无关紧要的，报告里就多一行没有信息的绿格。

- 先在 HEAD 上查，不要凭记忆填 JSON。文档里那句在不在，用 `git grep -n -E '措辞' -- '文件'`。草稿先跑 `node <skill 目录>/src/lookup.ts 草稿.json`：它打印每条说法捕获到的文本，以及事实现在测到的数（JSON 的长度、键、数值也由它查）。对不上就改 `locator` 或 `fact`，不要直接放进去。
- `locator` 只匹配文档里实际存在的措辞。措辞变过的话，用能同时覆盖新旧写法的正则。
- 只选能用下面的事实类型测出来的说法，测不出来的不要硬写。

可以先在目标仓库里运行 `node <skill 目录>/src/suggest.ts`。它用 `git grep` 捞 Markdown 里「1600+」「大约 2000」「pnpm run …」「共 12」这几类句子，打印 JSON，不写文件，也不把整篇文档读进来。`fact` 多半是占位，改成这个仓库里真正该数的东西，再用 lookup 对一下，再放进 `claims.json`。

## claims.json

数组，每个元素：

| 字段 | 必填 | 含义 |
|---|---|---|
| `id` | 是 | 唯一标识 |
| `file` | 是 | 说法所在文件，相对仓库根 |
| `locator` | 是 | 定位正则，第 1 个捕获组是文档写的那个数字（引用型则是引用的文本） |
| `fact` | 是 | 被测事实，见下 |
| `label` | 否 | 界面显示名，缺省用 `id` |
| `impact` | 否 | `"high"`、`"normal"`（缺省）、`"low"`。读错了会让人做错事的说法标 `high`（如安装命令、关键路径）。只用于排序与标签，不参与任何统计 |
| `compare` | 否 | 文档写的数和事实怎么比：`"eq"`（缺省，严格相等）、`"gte"`（事实 ≥ 文档的数，文档写「1600+」「至少 10 项」）、`"lte"`（事实 ≤ 文档的数，「最多 50」）、`"approx"`（相差不超过 `tolerance`，「约 2000」）。只用于数值型事实 |
| `tolerance` | 否 | 仅 `approx`：相对误差，0 到 1 之间，缺省 `0.05`（相差不超过 5%） |

```json
[
  {
    "id": "levels",
    "label": "README：关卡数",
    "file": "README.md",
    "locator": "共 (\\d+) 关",
    "fact": { "type": "json-length", "file": "data/levels.json", "path": "levels" }
  }
]
```

文档里的数不一定是精确值。看到「1600+」「至少」「超过」「约」「最多」这类措辞，别用默认的严格相等，否则文档没错也会被判成假：

```json
{
  "id": "icon-count",
  "file": "README.md",
  "locator": "provides (\\d+)\\+ vector",
  "fact": { "type": "count-files", "glob": "icons/*.svg" },
  "compare": "gte"
}
```

忘了写也有兜底：措辞像下限 / 近似、却在按严格相等比较的说法，终端汇总里会列出来，页面抽屉里也有提示，但判定不会自动改，由你确认。

`compare` 只比方向，不看文档写得保不保守：README 写「1000+」而实际 1539，`gte` 下仍是真。「写得太旧」要用精确值或 `approx` 才暴露。一个区间（「1600–1800 个」）捕获不了两个数，拆成两条说法，各取一端，下限用 `gte`，上限用 `lte`。

## 事实类型

| `type` | 参数 | 测到的数 |
|---|---|---|
| `count-files` | `glob` | 匹配 glob 的文件数。`*` 不跨目录，`**` 跨目录，`?` 匹配单个字符 |
| `json-length` | `file`，`path`（选填） | JSON 里数组的长度，或对象的键数。`path` 用点分隔，根节点是数组时可省略 |
| `json-number` | `file`，`path` | JSON 里某个数值字段 |
| `regex-count` | `file`，`pattern`，`flags`（选填） | 正则在文件中的匹配次数 |
| `line-count` | `file` | 文件行数 |
| `file-bytes` | `file` | 文件字节数 |

这些事实在每个 commit 上独立测量，只读 git 对象。读不到（文件缺失、JSON 损坏、路径不存在）时，该 commit 记为「测不出来」，不会被当作假。它们回答「在不在」，回答不了「算得对不对」。

### 跑出来才知道

判据由测试、不变量或一份输出带进仓库。laminae 不理解公式，只把每个 commit 的结果记成序列，算出从哪一格开始不对、挂了多久、最后是改了代码还是改了声称。

命令在临时 worktree 里用 shell 执行，不改主工作区。不要写会改系统或会删数据的命令。`watch` 列出命令真正读的文件（glob）；这些文件没变就不再跑。不写 `watch` 则每个 commit 都跑。`timeout` 是秒，缺省 60。

| `type` | 参数 | 为真的条件 | 结局怎么读 |
|---|---|---|---|
| `test-passes` | `command`，`watch`（选填），`timeout`（选填），`source`（选填） | 退出码 0。说法的 `file` 应指向测试文件，`locator` 捕获测试名或断言里的期望 | 测试文件正文没变、结果从失败变通过：改了被测代码（现实追上了说法）。正文和结果在同一格一起变：改了断言，或两边一起改（两边都变了） |
| `invariant-holds` | 同 `test-passes` | 退出码 0，表示这条性质成立 | 同测试。`source` 缺省就是说法所在文件 |
| `output-unchanged` | `command`，`watch`（选填），`timeout`（选填） | 标准输出与「这句捕获文本第一次出现时」相同。捕获文本变了（例如口径从 v1 改成 v2），基线跟着重置 | 输出变了又变回去、句子没改：现实追上了说法。句子和输出在同一格一起变：两边都变了。不判断输出对不对，只判断变没变 |

```json
{
  "id": "fee",
  "label": "酬金计算",
  "file": "tests/test_fee.py",
  "locator": "def (test_fee_calc)\\b",
  "fact": {
    "type": "test-passes",
    "command": "python -m pytest tests/test_fee.py::test_fee_calc -q",
    "watch": ["tests/test_fee.py", "fee.py"]
  }
}
```

起不来或超时记「测不出来」，不记成失败。非 0 退出码记失败。`output-unchanged` 在非 0 退出时把这次输出当成「变了」，而不是测不出来。

### 引用型：文档写的不是数，而是对仓库里某物的引用

`locator` 的第 1 个捕获组是引用的文本（路径、命令名……），事实是它存不存在。适合核验失效的路径、命令、配置项。

| `type` | 参数 | 为真的条件 |
|---|---|---|
| `path-exists` | `base`（选填） | 捕获到的路径是仓库里的文件或目录；给了 `base` 就相对该目录 |
| `text-in-file` | `file` | 捕获到的文本在该文件里出现过 |
| `json-has-key` | `file`，`path`（选填） | 捕获到的名字是该 JSON 里某个对象的键，例如 `package.json` 的 `scripts` 里有没有 `npm run xxx` 的 `xxx` |

```json
{
  "id": "build-cmd",
  "file": "README.md",
  "locator": "npm run (\\w+)",
  "fact": { "type": "json-has-key", "file": "package.json", "path": "scripts" }
}
```

注意：
- 一条说法只取第一个匹配。文档里引用了多个路径，就为每个写一条，用更具体的 `locator` 区分。
- 文档把引用改成另一个目标时，事实也随之变成「新目标存不存在」，该假段的收场会被记为「两边都变了」，分不清是谁先动。

## 调用关系图（自动，无需配置）

运行时会顺带为每个 commit 提取模块之间的 import 引用（JS/TS 和 Python），页面上可以拖时间条看某一刻的结构，也可以选两个时间点对比新增和消失的模块与引用。点节点能看它引用谁、被谁引用，以及与哪些说法、想法有关。只做模块级，不做函数调用；没有可识别的代码文件时不生成这一节。

## 层与层对不上的地方（自动，无需配置）

各层单独看都可能是成立的，叠在一起才看得到洞。这一节自动做下面这些事，不需要在 claims.json 里写：

- **假实现**：说法为真、或想法已完成，但它指着的文件结构上是空的：空文件、写着 `not implemented` / `未实现`，或者函数体是空的、只 `return null` / `[]` / `{}` / 一个常量。认不出算错了。路由路径对上了也会看处理函数，空的照样算假实现，并顺着相对 import 再追一层。`APIRouter(prefix=)` 和 `include_router(..., prefix=)` 会拼到装饰器路径上。
- **被盖住**：文件只是 `export { x } from "./别的文件"`；模块只有测试在引用；文档用「至少」「不超过」这种比较才成立，而且实际值和写的数差了一截；别名解析不了，看不出有没有绕过。
- **有实质代码**：排除了上面两类。这不是「真的实现了」，工具看不到这段代码是不是在做说法里的那件事。
- **孤立模块**：代码文件没被任何代码引用，不是入口（`index`、`main`、`bin`、`cmd`），也没有任何说法或想法提到它。
- **契约**：把仓库里「声明的东西」和「引用的东西」按种类配对。目前只认 HTTP 路径（`app.get("/x")`、`@app.route("/x")`、`@router.get("/x")` 对 `fetch("/x")`、`axios.get("/x")`）。Python 路由会拼上 `APIRouter` 和 `include_router` 的前缀。

不预设项目有前端或后端。缺任何一侧都是正常的项目形态（纯库、纯前端、纯后端），只记录「这一侧不存在」，不算洞；只有两侧都存在、而某处引用了一个没人声明的名字，才算对不上。纯库没有路由，靠入口和孤立模块覆盖。

另外标出注入线索（`eval`、`new Function`、`child_process`、`innerHTML`、`dangerouslySetInnerHTML`）的位置。这只是线索，不判断能不能被利用。

## ideas.json（选填）：想法与边界

想做的事、不准越过的线，由使用者声明，用的仍是引用型事实，只是「引用的文本」直接写在 `target` 里。文件放在 `.laminae/ideas.json`（路径可用 `LAMINAE_IDEAS` 覆盖），不存在就跳过。

| 字段 | 必填 | 含义 |
|---|---|---|
| `id`、`text` | 是 | 唯一标识、界面显示的描述 |
| `target` | 是（`import-edge` 不用） | 被检查的路径、命令名或文本 |
| `fact` | 是 | 引用型事实（`path-exists`、`text-in-file`、`json-has-key`），或模块引用 `import-edge`（见下） |
| `expect` | 否 | `"present"` 或 `"absent"`。想法缺省 `present`，边界缺省 `absent` |
| `boundary` | 否 | `true` 表示边界：满足就是「守住」，不满足是「越界」 |
| `source` | 否 | 这条想法的出处，如「ROADMAP.md 第 12 行」 |

状态：想法为「已完成 / 未完成」，边界为「守住 / 越界」；证据读不到记为「测不出来」，不当作退回。方向和证据必须由人决定，工具不会替你猜。

四种写法各一条：

```json
[
  {
    "id": "export-pdf",
    "text": "支持导出 PDF",
    "target": "src/export-pdf.ts",
    "fact": { "type": "path-exists" },
    "source": "ROADMAP.md 第 12 行"
  },
  {
    "id": "no-network",
    "text": "边界：运行时不联网，不引入 http 客户端",
    "target": "node-fetch",
    "fact": { "type": "json-has-key", "file": "package.json", "path": "dependencies" },
    "boundary": true
  },
  {
    "id": "old-parser-removed",
    "text": "旧解析器要删掉",
    "target": "src/old-parser.ts",
    "fact": { "type": "path-exists" },
    "expect": "absent"
  }
]
```

### 引用边界：`import-edge`

「前端不许引用后端」这类边界，写成 `from` 下的文件有没有 import `to` 下的文件，不需要 `target`：

```json
{
  "id": "ui-not-server",
  "text": "边界：前端不许引用后端",
  "fact": { "type": "import-edge", "from": "src/ui", "to": "src/server" },
  "boundary": true
}
```

`from`、`to` 是目录或单个文件，按路径整段匹配（`src/ui` 不含 `src/ui2`）。边界缺省 `expect: "absent"`：没有这样的引用是「守住」，有就是「越界」，页面上会列出越界的那几条引用，并能在引用图上把它们标红。写成想法（`expect: "present"`，如「A 要接到 B 上」）则相反。

测不出来，不会假装守住：

- `from` 下有解析不了的别名引用（如 `@/server/db`、`~/server`、`src/server/db`），而且写法里带着 `to` 的名字，那么结论是「测不出来」并写出是哪个文件的哪个引用。
- `from` 下一个 JS/TS/Python 文件都没有（比如全是 Go），引用图不支持，同样「测不出来」。
- 找到了确凿的越界引用，结论就是确定的，不受上面影响。

能解析的引用：相对路径，以及 monorepo 里的内部包（`@acme/server` 指向 `packages/server`）。tsconfig/webpack 的别名配置不读。

路线图里的 `- [ ]` 清单和代码里的 TODO/FIXME 会作为「线索」单独列出并画数量趋势，但它们只是线索，勾没勾不代表真做没做，不会自动变成想法。

## 分批推测：让 agent 读代码而不是读文档

说法现在只能从文档里来，文档写错整条链就跟着错。这一层让 agent 直接看代码，逐个函数问「它该做什么」。

在目标项目目录下：

```bash
node <skill dir>/scripts/derive.ts --plan             # 取下一批要看的函数
node <skill dir>/scripts/derive.ts --accept out.json  # 交结果
node <skill dir>/scripts/derive.ts --status           # 看进度
```

`--plan` 写出 `.laminae/derive/batch-<n>.json`，每项带 `file`、`function`、`line`、`why`，以及 **`context`（取证要跑的命令）**。工具的活到这儿为止：挑函数、给命令。

**agent 的活**：对每项跑 `context` 和 `hints` 里的命令，看懂这个函数在做什么，然后交一个结果文件：

```json
{
  "batch": 0,
  "results": [
    {
      "id": "<batch 里给的 id>",
      "text": "这个函数在做什么，一句话",
      "target": "被检查的路径或文本",
      "fact": { "type": "path-exists" },
      "evidence": ["你实际跑过的命令"]
    }
  ],
  "notes": [{ "id": "<id>", "why": "为什么这条写不成可测量的事实" }]
}
```

三条硬规矩：

1. **必须带 `evidence`**，写清是跑哪条命令看出来的。没有证据的一律退回。
2. **`fact` 必须是 12 种事实之一**，和 `ideas.json` 同一套。**表达不成一条能测的事实的，写进 `notes`，不要硬凑。**
3. 收下的进 `.laminae/ideas.json`，`source` 记成 `inferred:<文件>#<函数>`，和人工写的分开。

**为什么不让你直接下结论**：如果 agent 说「这里没问题」就采信，等于又加了一层不可核对的判断，和这个项目要解决的问题是同一件事。推断可以是模糊的，判定不行。

计划的排序：名字像在算东西（`calc` / `total` / `rate` / `format` …）、被多个文件提到、函数体够长。测试文件里的函数、已经知道是空实现的、名字太通用的（出现在超过 10% 的代码文件里）都不进计划。

## 对目标项目的影响

- 数仓库的事实只读 git 对象，不检出，不修改任何已跟踪的文件，不改项目自己的 `.gitignore`。`test-passes`、`invariant-holds`、`output-unchanged` 在临时 worktree 里执行你写的命令，不改主工作区。
- 生成物落在 `.laminae/data/`、`.laminae/runs/<id>/` 和 `.laminae/latest`，运行时会自动登记到 `.git/info/exclude`，不会出现在 `git status` 里。`.laminae/claims.json` 是使用者的输入，不忽略。
- 终端默认只打印紧凑摘要，行数不随 commit 数增长。需要完整的逐 commit 时间线时加 `--verbose`，或读 `.laminae/data/timeline.json`。

环境变量、报错处理与结果各字段的含义见 [docs/REFERENCE.md](docs/REFERENCE.md)，需要时再读。
