# Contributing

[中文](CONTRIBUTING.md) | [English](CONTRIBUTING.en.md)

The project name, package name and command name are all `laminae`, lowercase.

## Branches

Branch off `main`, merge back when done, delete afterwards. Name them `feat/` `fix/` `refactor/` `docs/` `chore/` plus lowercase hyphenated words; one branch does one thing. Tag releases on `main` as `v0.1.0`.

## Commit messages

One sentence saying what changed, starting with 新增 / 修复 / 重构 / 文档 / 杂项 (add / fix / refactor / docs / chore).

```
修复：analyze 与 build-data 对假段数的口径不一致
```

## Before committing

```bash
npm install
npx tsc --noEmit    # type check
npm test            # unit tests
```

If you touched `web/`, you must run `npm run build:web` and commit the regenerated `dist/app.js`, otherwise the page stays stale.

If you changed the data flow, run `scripts/run.ts` inside a git repository that has `.laminae/claims.json` and confirm it produces HTML.

## Three hard rules

- **Never write any specific project's paths, file names or numbers into the code.** Project-specific content may only come from the target repository and `.laminae/claims.json`.
- **Check the licence before bringing in someone else's code.** MIT / Apache / BSD can be merged in, keeping the copyright notice; **GPL / AGPL must not be merged in** — it would turn the whole project into GPL. If you only borrow an idea or an interface shape, state where it came from.
- **`docs/PATTERNS.md` only accepts verified patterns.** Tried on at least two or three different repositories, confirming that the `fact` combination really measures something. Do not add types "to be done later", otherwise the rule "no pretending a surface check is a real check" in `SKILL.md` stops meaning anything.

See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.en.md) for how to record sources, and [docs/PATTERNS.md](docs/PATTERNS.en.md) for how to write a pattern.

## Bilingual documentation

`README`, `SKILL`, `CONTRIBUTING`, `SECURITY`, `THIRD-PARTY-NOTICES` and the three documents under `docs/` each have an English version, `*.en.md`. The two files are two versions of the same content: **if you change one, change the other in the same commit**.

The line counts do not have to match; Chinese and English differ in length. What has to match is the content: the same sections, the same commands, the same numbers, the same limits. Change one side and forget the other, and readers of the other side will follow instructions that are out of date.

Each file starts with a `[中文](…) | [English](…)` line; do not delete it. Internal links in the English version point at `*.en.md`, and in the Chinese version at the Chinese files, so each language closes on itself.

Literals that the tool actually matches are not translated — `未实现`, `找不到说法定义文件`, `约` / `至少` / `超过`. Translate those and the documentation stops matching the code.

## Licence

[MIT](LICENSE). Submitting a contribution means you agree to release it under the same licence.
