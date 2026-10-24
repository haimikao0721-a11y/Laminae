# laminae 参考

[中文](REFERENCE.md) | [English](REFERENCE.en.md)

`SKILL.md` 里没有展开的细节。数据模型与判定规则见 [SPEC.md](SPEC.md)，挑说法时查 [PATTERNS.md](PATTERNS.md)，第三方与出处见 [../THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)。

## 环境变量

均为选填。

| 变量 | 作用 |
|---|---|
| `LAMINAE_REPO` | 目标仓库路径，默认取当前目录所在仓库的根。父目录不是仓库时，会把下面的子仓库列出来 |
| `LAMINAE_REPO_URL` | 网页地址，用于「去核对」链接，默认取 `origin` 远程 |
| `LAMINAE_CLAIMS` | 说法定义文件路径，默认 `<仓库>/.laminae/claims.json` |
| `LAMINAE_IDEAS` | 想法与边界定义文件路径，默认 `<仓库>/.laminae/ideas.json`，文件不存在就跳过 |
| `LAMINAE_DATA` | 中间数据目录，默认 `<仓库>/.laminae/data` |
| `LAMINAE_HTML` | 报告路径，默认 `<仓库>/.laminae/runs/<id>/laminae.html` |
| `LAMINAE_RUN` | 运行 id。给具体名字就用它；设成 `new` 表示新开一次；不设则接着 `.laminae/latest` 指向的那次 |
| `LAMINAE_REPOS` | 逗号分隔的仓库清单，等同于 `--repos` |
| `LAMINAE_JOBS` | 并发度，等同于 `--jobs` |
| `LAMINAE_VERBOSE` | 设为 `1` 等同于 `--verbose` |
| `LAMINAE_NO_EXCLUDE` | 设为 `1` 则不往 `.git/info/exclude` 写入生成物 |

## 命令行参数

这些由 `scripts/run.ts` 消费，不会再传给各步骤。

| 参数 | 作用 |
|---|---|
| `--repo <路径>` | 指定一个仓库 |
| `--repos a,b,c` | 指定多个仓库 |
| `--all` | 当前目录不是仓库时，跑它下面找到的所有仓库 |
| `--run <id>` | 本次运行的 id。可读的名字比时间戳好认 |
| `--new-run` | 分步手跑时另开一次，不接着 `latest` |
| `--jobs <N>` | 并发度。默认取 CPU 数与仓库数里小的那个；有需要执行命令的说法时强制为 1 |
| `--allow-parallel-commands` | 即使有 `test-passes` 之类的命令也强制并行 |
| `--from <步号或名字>` | 从第几步开始跑。改了解析或规则时用它跳过最贵的测量 |
| `--to <步号或名字>` | 跑到第几步为止 |
| `--no-commands` | 不跑命令类事实，一律记成「测不出来」 |
| `--trust-commands` | 放行出处不在本机名下的 claims 里的命令 |
| `data` | 只跑到第 5 步，不渲染 HTML |
| `--verbose` | 打印完整的逐 commit 时间线 |

## 输出

| 位置 | 内容 |
|---|---|
| `.laminae/runs/<id>/laminae.html` | 报告，单文件，数据、样式、脚本全部内联，无外部请求 |
| `.laminae/runs/<id>/payload.json` | 完整数据。够重渲染；两份之间的差异用 `scripts/diff.ts` 看 |
| `.laminae/latest` | 最近一次运行的 id |
| `.laminae/data/` | 中间数据，共享一份，每次覆盖，可删 |
| `.laminae/data/graph.json` | 模块引用图：节点与边在哪些 commit 区间存在。文件超过 350 个时按目录合并成节点，测试文件打标并默认隐藏 |
| `.laminae/data/ideas-timeline.json` | 每条想法/边界逐 commit 的状态、首次满足、退回次数；`import-edge` 另带 HEAD 上命中的引用（最多 30 条，`hits`/`hitsTotal`）与判不了的原因（`unsure`） |
| `.laminae/data/candidates.json` | 路线图清单与 TODO 线索，以及约 40 个采样点的数量趋势 |

### 多仓库时的产物

父目录（不是仓库、下面有仓库的那一层）会多出：

| 位置 | 内容 |
|---|---|
| `<父目录>/.laminae/runs/<id>/index.html` | 汇总页：每个仓库一行，以及所有仓库里挂得最久的假段 |
| `<父目录>/.laminae/repos.json` | 选填。仓库清单，写在这里就不用每次给 `--repos` |

### 运行 id 与留档

- 默认 id 是本地时间戳 `20261020T031422`，同一秒撞了加序号，不覆盖已有目录。
- id 只能含字母、数字、点、下划线、连字符，不能含路径分隔符或 `..`。它来自 `claims.json` 和命令行，不挡住就能把产物写到仓库外面。
- 同一个 `--run` 名字跑第二次会覆盖那一次，并提前打印提示。想两个人各留一份就换个名字。
- 分步手跑且没给 `LAMINAE_RUN` 时，会接着 `.laminae/latest` 指向的那次，六步才落在同一个目录里。要另开一次用 `--new-run`。
- 只留档 `payload.json` 与 `laminae.html`，中间数据共享一份。几百个 commit 的仓库逐次复制 `docs-by-commit.json` 会把磁盘吃光。
- `facts.json`、`timeline.json` 这些草稿每次运行都被覆盖。但六步是分开的，换判定规则不用整次重跑，见下面的分步重跑。
- 「留了两份报告」本身不产生结论。要比两次调用的差异，用 `node scripts/diff.ts <旧> <新>`。

### 分步重跑

六步是分开的，可以只跑其中几步。改判定规则、改构建期加工、改渲染，都不必重跑最贵的逐 commit 测量。

```bash
node scripts/run.ts --from 2                # 从第 2 步起
node scripts/run.ts --from analyze --to 5   # 名字里的一段也认
node scripts/run.ts --from 5                # 只重算构建期加工和渲染
```

vue（6513 个 commit）上实测：完整跑 426 秒，只重跑判定 1 秒、加工加渲染 2 秒，产物完全一致。

跳过的步骤依赖的中间数据不在时，会停下来告诉你先跑哪一步——不会让后面几步读到空文件、产出一份看起来正常的空报告。没跑到最后一步时不跑 `verify`：硬跑会去校上一份旧产物。

### 比较两次运行

```bash
node scripts/diff.ts <旧运行> <新运行>     # 运行 id 或 payload 路径都行
node scripts/diff.ts <旧> <新> --json      # 机器可读
```

比四类：说法的状态序列（第一个不同的 commit、影响多少格、分成几段）、层那几档的增减（列到具体文件）、图的节点与边、汇总口径。

提交序列不一样时（历史被改写、两次之间多了新提交）按 sha 对齐，并明确报出只在一侧出现的提交数——静默按下标比会把整条时间线错开一位。

### 目录

```
src/core/     配置、git 调用、路径、运行 id、仓库发现
src/measure/  事实声明与求值、逐 commit 测量、说法体检
src/judge/    分段、结局判定、生存估计
src/layers/   语法模块、引用图、层与层的对账
src/ideas/    想法、边界、线索
src/output/   构建期加工、渲染、多仓库汇总页
scripts/      run / init / diff / derive / trace / branches / merges / verify
web/          浏览器侧（编译到 dist/app.js 后内联进报告）
docs/         规格、参考、说法模式、语言、踩过的坑、现状
```

### 数值说法的限制

- 一条说法只捕获文档里的一个数。区间要拆成两条（下限 `gte`、上限 `lte`）。
- `compare` 只比较方向。`gte` 不会指出「文档写的下限已经太保守」（README 写「1000+」、实际 1539 仍为真）；这类陈旧要靠精确值或 `approx` 才能暴露。
- 「措辞像下限 / 近似」的提醒是按字面规则猜的（`N+`、约、至少、超过、at least、more than 等），可能漏报也可能多报，只提醒、不改判定。
- 提交序列只沿 `--first-parent` 主线：有大量合并提交的仓库，序列长度会小于 `git rev-list --count`（例如 lucide 主线 2562 个，全部提交约 3000）。
- 仓库是 blobless / partial clone 时也能跑，但每个没见过的文件版本要联网取一次，历史长的仓库测量会慢很多（lucide 2562 个 commit 约 6 分钟）；引用图那一步会读全部代码文件，更慢，建议完整克隆。

### 跑出来的事实

- `test-passes`、`invariant-holds`、`output-unchanged` 的命令在临时 worktree 里按 shell 执行，权限与运行 laminae 的人相同，不改主工作区。
- 不写 `watch` 时每个 commit 都跑。历史长时必须写上命令真正读的文件，内容没变就复用上一次的结果。
- 结局只比较假段结束的下一格和假段最后一格。测试文件在假段中间改过、结束那一格又没再改，不会单独记成「改了断言」。
- 层与层那一节仍然不执行代码。`return b * r * 1.2` 这种写满了的函数，在那里仍是「有实质代码」。

### 层与层对账的限制

- 假实现只认：去掉注释后没有代码；整份文件没有别的实现、只写着 `not implemented`、`NotImplementedError`、`未实现`、`unimplemented!()`、`todo!()`；函数体是空的，或只 `return` 空值、布尔值、数字（含 `return 1`）。文件里已经有别的实现时，单独一个 `NotImplementedError` 不会把整个文件判成假实现。类里面的空方法、读不懂的语法，仍算「有实质代码」。这仍然不是在核对「这段代码是不是在做说法里的那件事」。
- 有实质代码不是「真的实现了」。这一节不执行代码，不知道公式算得对不对。算出来的数要靠 `test-passes`、`invariant-holds` 或 `output-unchanged`。
- 纯转发只认整文件都是 `export … from` 或 Python 的相对 import。转发只再追两跳。
- 「往下看一层」只报**当前还成立**的。每条带一个 `atHead`，按 `alive` 区间是不是盖住最后一个提交算出来。历史条目仍然保留（可以展开查），但默认折起来——它们没有一个是现在的问题。这一条是在 click 上补的：100 条里 53 条只存在于 2014 年单文件时代的 `click.py`，混排之后截前 40 条，看到的全是历史噪声。
- 测试文件和 `examples/`、`docs/` 一类的目录不进「往下看一层」。测试里的桩函数、示例里的空 CLI 是写法本身，不是缺陷。同样是 click 给的教训：剩下的 47 条「当前成立」里 45 条在 `tests/`、2 条在 `examples/`，`src/` 里一条都没有。改完之后 click 当前成立 0 条、历史 48 条，这才是对的。
- 措辞盖住差额：`compare` 为 `gte` 或 `lte` 且成立，相对差额至少 15%，并且绝对差额至少 2，才记。「共 5、实际 6」只差 1，不记；「1600、实际 1899」两个都够，记。这两个数是人为定的，不是从误报样本估出来的。
- 孤立模块把 `index`、`main`、`cli`、`app`、`server`、`mod`、`__init__`、`__main__` 和 `bin/`、`cmd/` 下的文件当入口，不算孤立。被测试引用的文件也不算。
- 没有 import 边、但**文件名在别的文件正文里作为字面量出现过**的，记为「按约定加载」，不算孤立。依据是这三类东西在静态图上一条边都没有：`package.json` 的 `scripts` 按路径调用的脚本、页面里 `<script src>` 引用的资产、模板串拼出来的路径（``` `renderers/${type}/render-${type}.mjs` ```）。名字短于 5 个字符的不算，否则 `index.js` 一类的名字会把真的孤立盖住。只在测试文件里被提到也算数。
- 孤立模块只报**现在**还成立的。`unreferenced` 是按 commit 记的，一个文件早期没人引用、后来被引用了，照样会留下来。vue 上这条让 170 条孤立里有 119 条是历史路径 —— 那些文件在 HEAD 上根本不存在了。和「往下看一层」是同一个毛病。
- 被工具按文件名加载的不算孤立：`*.config.{js,ts}`（vitest、eslint、vite 按约定找）、`*.bench.*` 与 `__benchmarks__/`（测试工具按后缀收集）、`*.test-d.ts` 与 `*.d.ts`（由 tsc 直接类型检查）。判据是后缀和目录名，不是猜 —— 工具确实就是这么找它们的。
- 这一档的代价要说清楚：**它只能证明「有人按名字引用过」，不能证明「真的跑得到」**。名字写错、引用了已删除的文件，都会看起来像在用。
- **有入口证据的不算孤立，理由跟着一起输出。** 这一条是在真实仓库上补的：click 报出 15 条孤立，15 条全错——12 条在 `examples/` 下（给人执行的示例），2 条在 `docs/` 下（给 Sphinx 加载的配置），1 条是 `src/click/testing.py`（库的公开模块，给使用者 import 的）。认的证据只有四种，都是仓库里明写的：目录角色（`examples/`、`docs/`、`scripts/`、`bin/`、`tools/` 等）、Python 包归属（同级有 `__init__.py`）、清单声明（`package.json` 的 `bin`/`main`、`pyproject.toml` 的入口点、`Cargo.toml` 的 `path`）、文件开头是 `#!`。这四种里没有一条依赖「文件名看起来像什么」。
- 为什么这条重要：**在库项目里，「一个模块没有内部引用」常常意味着它是出口，不是入口。** 把结构事实当成缺陷，是这一档最容易犯的错。改完之后 click 从 15 条降到 0，archify 从 4 条降到 3 条（少的那条开头是 `#!`，是脚本），剩下 3 条是真的没人用。
- 契约目前只有 HTTP 路径一种。路由声明认 `app` / `router` 一类的 `.get("/x")` 和 Python 的 `@router.get("/x")`、`@app.route("/x")`，引用认 `fetch("/x")` 和 `axios.get("/x")`。`APIRouter(prefix="/users")` 与 `include_router(router, prefix="/api/v1")` 会拼成 `/api/v1/users/...`，`from users import router` 这种跨文件挂载也拼。带变量的路径（`` `/api/${id}` ``）对不上，直接跳过。
- 仓库里没有任何路由声明时，`fetch` 调用不判为洞：分不清是在调外部服务，还是本仓库没实现。反过来，只有声明没有调用也不判，调用方可以在仓库外。
- 注入线索认 `eval(`、`new Function(`、`child_process`、`.innerHTML`、`dangerouslySetInnerHTML`、`os.system(`、`subprocess`、`document.write(`。出现不等于能被利用，页面上标的是线索。
- 函数调用：**同一个文件内**的调用也算（用 `local` 标出，不需要查 import），任意位置的调用点都算，不再要求「只有一句调用」（原来多一个 `if` 或 `await` 整条链就断了）。被调的名字必须来自相对 import（`./`、`../`、Python 的 `.`）。从已经有问题的函数往外，最多追 4 跳；每一跳记一个 `hops`，报告按它标置信度 —— **1 跳是直接看到的，4 跳是推出来的**。第三方包不追。行号是定义行。

### 调用关系图的限制

- 只做模块级 import，JS/TS（`import`、`require`、动态 `import()`、`export … from`）与 Python（`import`、`from … import`）。Java、Go、C# 以及其他语言都不认（扩展方式见 [LANGUAGES.md](LANGUAGES.md)）。Rust 从 0.2 起有语法模块：扩展名不在 `.js` / `.ts` / `.jsx` / `.tsx` / `.mjs` / `.cjs` / `.py` 里的文件，不会被当成代码。
- 没有函数级调用图。
- Python 多行的 `from x import (\n a,\n b)` 只读到第一行的名字。
- 注释或字符串里长得像 import 的文本可能产生多余的边。
- 别名路径（tsconfig paths、webpack alias）不解析，这类引用不画。monorepo 里的内部包（`@acme/x`，由非根 `package.json` 的 `name` 识别）会解析并画出。
- 解析不了的别名引用不进图，但 `import-edge` 边界会用它们判断「测不出来」。Python 的绝对引用解析不了时不做这一步，只认能解析到仓库内文件的。
- `import-edge` 只认代码文件之间的引用，模块级；`from` / `to` 按路径整段匹配。
- 想法的方向和证据由人声明；路线图清单的勾选状态只是线索。

## 出错时

| 报错 | 处理 |
|---|---|
| 不在 git 仓库里 | 进入项目目录再运行，或设置 `LAMINAE_REPO`。父目录下有几个仓库时，提示里会列出来并给出命令 |
| 是 laminae 自己的仓库 | 到要核验的项目目录里运行。工具不核验自己 |
| 路径写出了仓库 | `file`、`base`、`source`、引用边界的 `from` / `to` 改成仓库内的相对路径 |
| `--run` 的名字不合法 | 换成字母、数字、点、下划线、连字符组成的名字，不能含路径分隔符 |
| `找不到说法定义文件` | 先写 `.laminae/claims.json`。多仓库时每个仓库都要有自己的 |
| `claims[N]` 的某字段不合法 | 报错信息指出了是哪一条的哪个字段，按提示改 |
| 测量数据与 claims.json 不同步 | 改过 `claims.json` 后重新运行 `run.ts` |
| 多仓库时某个仓库失败 | 其余仓库照常跑完，整体退出码非 0。用 `--repo` 单独重跑那一个 |

## 规则写错了怎么办

两条提示，都不改判定，只把可疑的地方指出来：

- **规则没匹配到**：一条说法的 `locator` 在整段历史里一次都没匹配到。这时状态是「尚未写入文档」，但原因可能是文档确实没写过，也可能是正则写错了。工具分不清，所以单独打一个标，并提示去跑 `lookup` 看它到底捕获了什么。
- **捕获可疑**：引用型说法判假，但把捕获到的文本去掉首尾标点（反引号、引号、括号、逗号、句号、冒号）之后，同名文件在 HEAD 上确实存在。这几乎总是 `locator` 的捕获组多带了字符 —— 比如把反引号写进了括号里，捕获到的是 `docs/help.md` 后面多一个反引号。

**这两种情况都会让工具诬告。** 一个会诬告的检查比不检查更糟：用户会开始不相信红色。所以它们各自有独立标签，不并进「假」。

- **说法体检**：跑之前先检查每条说法写得对不对，结果在控制台和报告最上面。查三类：数字类事实的 `locator` 捕获到的必须是数（`8.6.0` 这种版本号读不成数，会把每条 commit 判成「尚未写入文档」）；`locator` 在基准提交的文档里一处都匹配不到；`fact` 里写了该类型不认的字段（`parseFact` 会把它们静默丢掉，写了等于没写）。

## 结果怎么看

五个命令各管什么、src 该怎么分组，见 [LAYOUT.md](LAYOUT.md)。


每个 commit 上，每条说法有四种状态：真、假、尚未写入文档（灰色）、测不出来。连续为假的区间是一个假段，长度即 hiatus，并按收场方式归类。各结局的含义见 [SPEC.md](SPEC.md)。

## 报告是不是编出来的

报告可以被伪造，而且两种伪造看起来都很像真的：直接改 HTML 里的字，或者不跑流水线、手写一份 payload。

`scripts/verify.ts` 用同一件事识破两条：**一切必须能从源头重算。**

  一、拿 payload 重渲一遍 HTML，逐字节比。手改过的对不上，而且会指到第几个字符、上下文是什么。
  二、从 git 重算每条说法在 HEAD 的状态、提交数、HEAD 号。编造的 payload 对不上。
  三、汇总数与逐条数对得上。伪造的人常只改显眼的汇总数，忘了让明细跟着变。

这一步已经接在 `run` 的最后：每次生成报告都自动验，不通过退出码非 0。要单独查一份旧报告，用 `--run <id>`。

一条要注意的：报告里记着自己是哪个版本的渲染器产出的（HTML 头部的 `laminae-renderer`）。
版本对不上时只警告、跳过逐字节比对 —— 那说明报告比渲染器旧，不代表有人改过。
**每次都喊狼来了，这个检查很快就没人看了。**
