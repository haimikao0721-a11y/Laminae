# 多语言支持

[中文](LANGUAGES.md) | [English](LANGUAGES.en.md)

现在只认 JS/TS 和 Python。这份文档说明三件事：为什么不该整体换语言、怎么把语言支持从「写代码」变成「填数据」、以及哪些环节适合用 shell 加速。

## 现状

`src/lang.ts` 按扩展名分三类：

| 类别 | 扩展名 | 会做什么 |
|---|---|---|
| 支持的语法模块 | `.js .ts .jsx .tsx .mjs .cjs .mts .cts`、`.py`、`.rs` | 解析引用、建图、判假实现、判路由（Rust 暂无路由） |
| 认得出但没语法模块 | `.java .go .cs .c .cc .cpp .h .hpp .kt .kts .swift .rb .php .scala .m .mm` | 列在「语法还没有模块」里，不进引用图，不判假实现 |
| 不当成代码 | 其余 | 完全忽略 |

**这个区分是有意的。** 认得出扩展名却硬猜结构，会产生假的引用边和假的「假实现」判定——比不判更糟。

文档说法（个数、路径、文本在不在、JSON 键在不在）不看语法，任何语言的仓库都能测。**受语言限制的只有引用图和层与层对账这两块。**

## 要不要换成 Python

结论：**只有一处值得，其余不换。**

### 值得的一处

`src/imports.ts` 的 `parsePython` 是逐行正则：

```ts
function parsePython(line: string): RawImport[] | null {
  const t = line.replace(/#.*$/, "").trim();
  let m = t.match(/^from\s+(\.*[A-Za-z_][\w.]*|\.+)\s+import\s+(.+)$/);
```

**它按行调用，所以跨行的 import 结构上就不可能解析对**，这正是 `REFERENCE.md` 写的「Python 多行的 `from x import (\n a,\n b)` 只读到第一行的名字」。

换成 Python 的 `ast` 模块能顺带解决一批：

| 现在解析不了 | `ast` 为什么能 |
|---|---|
| 跨行 import | 它看语法树，不看行 |
| `__init__.py` 的再导出 | 能看到实际绑定与 `__all__` |
| 相对 import 的层级 | `level` 字段是现成的 |
| 条件导入 | 有节点类型可判 |
| 装饰器路由 | decorator 列表直接给出 |
| `def f(): pass` 与 `def f(): return None` 的区别 | 不再靠字符串匹配 |

这一共大约 100 到 150 行，但是承重墙。

### 不值得的部分

| 部分 | 行数 | 为什么不动 |
|---|---|---|
| `web/`（浏览器端与样式） | 3299 | 必须编译成 JS 内联进 HTML，一行都动不了 |
| `render` / `build-data` / `indexhtml` | 917 | 模板拼接，换语言零收益 |
| `facts` / `claims` / `classify` / `survival` / `compare` / `accuracy` | 1042 | 纯逻辑 |
| `gitutil` / `paths` / `config` / `repos` / `runid` / `exclude` | 705 | 两边等价 |
| `observe` | 181 | 起进程、读退出码，两边都行 |
| JS/TS 那段解析 | 约 400 | Python 没有成熟的 TS 解析器，换过去只会更差 |

整体换语言还会多一个运行时。现在是「有 Node 就能跑，目标项目不装任何依赖」，这个属性是它作为 skill 能被随手用的前提。

**所以：不重写。要动就加一个可选的 Python sidecar。**

## 多语言怎么扩：语法模块从代码变成数据

现在加一门语言要写 TypeScript：一个 `parseX`、一个 `resolveX`、再加上层与层对账里的分支。这是**为什么只有两门语言**。

**第一层已经做了：判断收成了一处。** 原来判断散在三个调用点的三元表达式里（`findPythonFunctions(text).length > 0 && !/(?:function\s*\(|=>)/`），现在只有 `pickModule` 一处判断语言，别的地方一律问模块。

| 文件 | 放什么 |
|---|---|
| `src/syntax.ts` | 接口与共用零件（括号配对、跳过字符串、函数体判空、处理函数归类） |
| `src/syntax-js.ts` | JS/TS：花括号函数体、`import … from`、`app.get("/x")`、NestJS 的 `@Get("/x")` |
| `src/syntax-py.ts` | Python：按缩进判函数体、`from … import`、`@router.get("/x")`、`APIRouter(prefix=)`、`include_router` |
| `src/syntax-registry.ts` | 查表。`pickModule` 是唯一判断「这段文本是哪门语言」的地方 |

分法有个不对称，是有意的：

- **函数查找只问认出来的那个模块**
- **路由与 import 解析把所有模块问一遍再拼起来**

后者不是偷懒。一个只写了 `app = FastAPI()` 和 `include_router` 的文件里没有 `def`，认不出是 Python，但它确实在做挂载；只问认出来的模块，前缀就拼丢了。

**第二层还没做**：模块的内容仍然写在 TypeScript 里。往下是把这些正则挪进 JSON，让引擎通用。

改成声明式之后，加一门语言是往 JSON 里填几个正则：

```json
{
  "id": "java",
  "label": "Java",
  "ext": [".java"],
  "skip": ["/test/", "/build/"],
  "imports": [
    { "re": "^\\s*import\\s+(?:static\\s+)?([\\w.]+?)(?:\\.\\*)?\\s*;", "spec": 1 }
  ],
  "definitions": [
    { "re": "^\\s*(?:(?:public|private|protected|static|final|abstract|synchronized)\\s+)*[\\w<>\\[\\],.]+?\\s+(\\w{2,})\\s*\\(", "name": 1 }
  ],
  "hollow": [
    { "re": "throw\\s+new\\s+UnsupportedOperationException\\s*\\(", "reason": "unimplemented" },
    { "re": "^\\s*\\{\\s*\\}\\s*$", "reason": "empty-body" }
  ],
  "routes": [
    { "re": "@(Get|Post|Put|Delete|Patch)Mapping\\s*\\(\\s*\"([^\"]+)\"", "style": "annotation" }
  ]
}
```

引擎是通用的：读目标仓库的文件、按扩展名选模块、用模块里的正则提取、把结果交给现有的图与层逻辑。**一门语言一个 JSON，不写代码。**

这样做还有两个副作用：

- **模式可以量化验证**。一个正则写得对不对，不用跑完整个历史才知道，`git grep` 一下就有数（见下节）。
- **模式可以被审查**。正则摆在 JSON 里，人能读；散在 TypeScript 分支里就只能靠读代码。

## 哪些能用 shell 加速

### 能：定位、计数、验证模式

`git grep` 直接在 git 对象上搜，不用检出，比「读出全文再用 JS 正则」快得多，而且天然跳过二进制。

**验证一个新写的模式**，三步就够了：

```bash
# 1. 命中了多少文件
git grep -l -E '^\s*import\s+[\w.]+;' HEAD -- '*.java' | wc -l

# 2. 抽几行看有没有匹配错
git grep -n -E '^\s*import\s+[\w.]+;' HEAD -- '*.java' | head -20

# 3. 反向检查：命中里有没有不该命中的
git grep -n -E '^\s*import\s+[\w.]+;' HEAD -- '*.java' \
  | grep -vE ':[0-9]+:import ' | head
```

**同一个模式在不同 commit 上的命中数**，可以用来看它稳不稳：

```bash
for sha in $(git rev-list --first-parent --reverse HEAD | head -20); do
  n=$(git grep -c -E '<pattern>' "$sha" -- '*.java' 2>/dev/null | wc -l)
  echo "$sha $n"
done
```

### 能：找变化点

`git log -S'<pattern>'` 直接给出某段文本是什么时候出现或消失的。**这比自己逐 commit 扫一遍快一个数量级**，适合用来先粗定位「哪几个 commit 值得细看」，再让完整流程跑那几个区间。

### 能：取候选文本给模型读

`git grep -n -C2` 带上下文，输出很小，适合直接交给模型判断「这个模式认的是不是我要的结构」。这是模型参与的正确位置——**改规则，不是判真假**。

### 不能：判定

**判定必须由工具做，不能交给模型。** 这是这个项目的立身之本：如果最后由模型说「这里没问题」，那就是又加了一层不可核对的判断，和它要解决的问题是同一件事。

模型可以做的是：挑说法、写模式、看误报例子后改模式。**做完之后，结论仍然由工具按规则算出来，逐 commit 落成序列，可复核。**

### 不能：跨行结构

shell 按行工作。跨行的 import、嵌套的函数体、多行的注解参数，`git grep` 拿到的只是一行，判断不了。**这类必须读出整段文本处理。**

现在的 `scan.ts` 已经为此做了优化：常驻的 `git cat-file --batch` 按 blob 号批量读，同一个 blob 只读一次、只解析一次；代码文件和 `package.json` 都没变的 commit 直接沿用上一个结果。相邻 commit 大多数文件没变，所以每个 commit 只多读几个新文件。

**所以真正的分工是：`git grep` 找候选（快、粗），`cat-file` 取全文（准、只取需要的那部分）。**

## 加一门语言的步骤

1. 在 `src/lang/` 下加一个 JSON，填 imports / definitions / hollow / routes 四组模式。
2. 用上一节的 `git grep` 三步，在至少两个真实仓库上验证命中率和误命中。
3. 把 `lang.ts` 里的扩展名从 `unsupported` 挪到支持列表。
4. 在 `docs/PATTERNS.md` 之外另记一笔：这门语言的模式在这两个仓库上的已知误判。
5. 中英文档同步更新支持范围。

**没验证过的模式不要加。** 一个正则匹配错了，会同时污染引用图、边界判定和假实现三处，而且不会报错——只会给出错的红格子。

## 现在做不到的

这些是设计边界，不是待办：

- **语义**。声明式模式认的是形状，认不出「这段代码在算对的事」。泛型、类型推断、宏、模板，正则一概看不懂。
- **跨行结构**，如上。真正的解法是每门语言一个真正的解析器（Python 用 `ast`，JS/TS 用 TypeScript 编译器 API，Java 用 javac，等等），那是另一件事。
- **构建配置**。别名路径（tsconfig paths、webpack alias、Java 的 sourceSets）不解析。现在只有 monorepo 里的内部包能靠非根 `package.json` 的 `name` 认出来。
- **运行时行为**。只有 `test-passes` / `invariant-holds` / `output-unchanged` 三种事实能碰到函数体里算出来的数，它们靠执行命令，不靠读代码。

**把「形状」和「语义」分开，是这个工具现在唯一站得住的边界。** 换成什么语言写，都不会改变这条。
