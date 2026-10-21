# 参与贡献

[中文](CONTRIBUTING.md) | [English](CONTRIBUTING.en.md)

项目名、包名、命令名统一为 `laminae`，小写。

## 分支

从 `main` 切出，改完合并回去并删除。按 `feat/` `fix/` `refactor/` `docs/` `chore/` 加小写连字符命名，一个分支只做一件事。发布在 `main` 上打 tag，格式 `v0.1.0`。

## 提交信息

一句话说清做了什么，以「新增 / 修复 / 重构 / 文档 / 杂项」开头。

```
修复：analyze 与 build-data 对假段数的口径不一致
```

## 提交前

```bash
npm install
npx tsc --noEmit    # 类型检查
npm test            # 单元测试
```

改了 `web/` 必须跑 `npm run build:web`，并把新的 `dist/app.js` 一起提交，否则页面还是旧的。

改了数据流程，在一个带 `.laminae/claims.json` 的仓库里跑一遍 `scripts/run.ts`，确认能出 HTML。

## 三条硬规矩

- **代码里不写任何具体项目的路径、文件名或数字。** 项目相关内容只能来自目标仓库和 `.laminae/claims.json`。
- **引入别人的代码先看许可。** MIT / Apache / BSD 可以并入，保留版权声明；**GPL / AGPL 不要并入**，会把整个项目变成 GPL。只借鉴思路或接口形状的，写明出处。
- **`docs/PATTERNS.md` 只收验证过的模式。** 至少在两三个仓库上试过，确认那个 `fact` 组合真能数出东西。不写「以后再做」的类型，否则 `SKILL.md` 里「禁止用表层检查冒充」那条就失效了。

出处怎么记见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)，模式怎么写见 [docs/PATTERNS.md](docs/PATTERNS.md)。

## 双语文档

`README`、`SKILL`、`CONTRIBUTING`、`SECURITY`、`THIRD-PARTY-NOTICES` 和 `docs/` 下的三份，各有一份英文版 `*.en.md`。两份是同一份内容的两个版本，**改了一份就得在同一次提交里改另一份**。

行数不必一致，中英文长度本来就不同。要保证的是内容对得上：同一组小节、同一组命令、同一组数字、同一组限制。改了一边忘了另一边，另一边的读者就会照着过时的说明做。

两份顶部各有一行 `[中文](…) | [English](…)`，别删。英文版里的内部链接指向 `*.en.md`，中文版指向中文文件，两边各自闭环。

工具真去匹配的字面量不翻译，比如 `未实现`、`找不到说法定义文件`、`约`/`至少`/`超过`。翻了文档就和代码对不上。

## 许可

[MIT](LICENSE)。提交即表示同意以同一许可发布。
