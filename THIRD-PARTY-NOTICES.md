# 第三方声明

[中文](THIRD-PARTY-NOTICES.md) | [English](THIRD-PARTY-NOTICES.en.md)

## 结论

**发布产物里没有第三方代码。**

`laminae.html` 里的样式、脚本、数据全部来自本仓库：`web/*.ts` 编译出的 `dist/app.js`、`web/style.css`、以及运行时测出来的数据。没有引入图表库、UI 框架或任何运行时依赖。

`package.json` 里没有 `dependencies`。

---

## 开发依赖（不进产物）

只在本仓库开发时用到，不随产物分发，使用者在目标项目里运行不需要安装它们。

| 包 | 版本 | 许可 | 用途 |
|---|---|---|---|
| [typescript](https://www.typescriptlang.org/) | 5.9.3 | Apache-2.0 | 类型检查（`npm run typecheck`），不参与构建产物 |
| [esbuild](https://esbuild.github.io/) | 0.25.12 | MIT | 把 `web/*.ts` 编译成 `dist/app.js`，产物是编译结果，不含 esbuild 代码 |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | 24.19.2 | MIT | Node 内置模块的类型声明，只在编译期用 |

三个都是宽松许可，与 [MIT](LICENSE) 兼容。

---

## 设计上参考过的东西（不是代码）

### [archify](https://github.com/tt-a1i/archify)

参考的是它公开的**交互能力清单**，没有复制代码。

`web/app.ts` 顶部注释里写的「交互语言参考 archify」指的就是这个：来源可点开去核对、搜索、预设视图、图例可点、时间推进播放、深链。也明确没有采用它的 Semantic Radar（小地图）、Reading Depth（按缩放分级）、Route Probe（两点路径）——这个图用不上。

因为只是受了清单的启发、实现全部是本仓库写的，所以不涉及它的许可条款。写在这里是为了让读者知道这个界面的清单从哪来。

### 调研阶段读过的项目

下面是定位调研时看过的公开说明。**没有导入其中任何代码**，也没有逐字搬它的文档。列出来是因为几处设计判断与它们有关，读者要溯源的话有地方去。

| 项目 | 与这里的关联 |
|---|---|
| [docclaims](https://github.com/jhaney0214-sys/docclaims) | 说法台账的形状；「没核对过」不能当成「通过」这条原则 |
| [docrot](https://github.com/dager23/docrot) | 引用解析与 git 溯源的做法；「判定不了」不能变成一条结论 |
| [staledocs](https://pypi.org/project/staledocs/) | 两步确认；「把检查放松」本身也要被检查 |
| DOCER（Empirical Software Engineering, 2023） | 逐 commit 核验引用存在性的做法；三种收场路径的分类 |
| DocPrism | 「改代码还是改文档，无法判断」这个问题的表述 |

「测不出来」与「假」分开存、结局里单列 `unmeasurable`、不把解析失败算成问题——这些是通用原则，不是从某一家的实现里抄来的。但它们确实是在读过上面这些之后才定下来的，所以列在这里。

### 试跑用过的仓库

[Lucide](https://github.com/lucide-icons/lucide) 与 google-analytics 只作为手工试跑的**对象**，不是依赖，源码没有被使用或分发。README 与 [REFERENCE.md](docs/REFERENCE.md) 引用它们的提交数是为了说明「主线提交数小于全部提交数」这个现象。

---

## 如果要往这里加东西

分三种情况，处理方式不一样：

| 加什么 | 要不要写在这里 | 怎么做 |
|---|---|---|
| **思路、原则、问题表述** | 要，写进上一节 | 思路本身不受版权保护，但出处要写清楚，方便读者溯源 |
| **接口形状、字段命名、交互清单** | 要 | 具体表达受版权保护。参考可以，不要逐字抄注释和文档 |
| **代码** | 要，而且要保留对方的许可全文 | 先看对方许可：MIT / Apache-2.0 / BSD 可以并入，保留版权声明；**GPL / AGPL 不能并入**——它们要求衍生作品整体按 GPL 分发，并进来等于把本项目也改成 GPL |

判定标准很简单：**你复制了对方的源码，就是第三种。**

提交时在信息里带上出处，例如：

```
从 <项目名> 移植了 XXX 的判定逻辑（<URL>，<许可>）
```

---

## 反过来

本项目采用 [MIT](LICENSE)。别人可以拿去用在商业产品里、可以再许可、也可以放进 GPL 项目——MIT 对 GPL 是单向兼容的。

唯一的义务是保留版权声明和许可全文。

如果哪天要收紧，改的是 [LICENSE](LICENSE)，不是这份声明。
