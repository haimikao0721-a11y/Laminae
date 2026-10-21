# Claim Patterns

[中文](PATTERNS.md) | [English](PATTERNS.en.md)

`SKILL.md` is about "how to find both sides in a repository and how to verify them". This document is about **not reinventing that every time**: claims in real documentation fall into just a few kinds, so how to recognise each kind, what facts can measure it, and when it cannot be measured are written down here to save you from starting from scratch.

Usage: when choosing claims in a target repository, first find the matching row in this table and configure the `fact` from it. **For anything not in the table, decide first whether it can be measured; do not force it into an existing type.**

---

## Three Degrees of Measurability

Telling these three apart matters more than remembering the specific types.

| | Meaning | Handling |
|---|---|---|
| **Directly measurable** | The fact is exactly the thing the documentation talks about; count it and compare | Write it into `claims.json` as usual |
| **Weakened check** | Only a weaker proposition can be measured, weaker than what the documentation says | You may write it, **but state in `label` or `source` where it is weaker**, otherwise readers will think everything was checked |
| **Not measurable** | The criterion is not in the repository, or the tool cannot reach it | **Do not write it**. Tell the user this claim cannot be verified, and say which files you read |

The line in `SKILL.md` that forbids "substituting a single `path-exists` or `text-in-file`" is talking about the second case: **a weakened check must disclose itself**.

The test in one sentence: **if this claim were false, what in the repository would be different?** If you cannot answer, it is not measurable.

---

## Master Table

| What a claim looks like | Example | Degree | `fact` | Notes |
|---|---|---|---|---|
| Exact count | 共 12 关 (12 levels in total) · 42 个图标 (42 icons) | Directly measurable | `count-files` / `json-length` / `regex-count` | Defaults to `eq` |
| Lower bound | 1600+ (1600 or more) · 至少 10 项 (at least 10 items) | Directly measurable | Same as above + `compare: "gte"` | A large gap gets flagged as "wording hides the gap"; see below |
| Upper bound | 最多 50 (at most 50) · 不超过 3 秒 (no more than 3 seconds) | Directly measurable | Same as above + `compare: "lte"` | Same as above |
| Approximate | 约 2000 (about 2000) · about 50 | Directly measurable | Same as above + `compare: "approx"` | Default tolerance is 5%; adjust `tolerance` when the number is small |
| Range | 1600–1800 个 (1600–1800 items) | Directly measurable (split into two) | One claim for each end, lower bound `gte`, upper bound `lte` | **One claim can capture only one number** |
| Script / command name | `pnpm run build` | Weakened check | `json-has-key` (`scripts` in package.json) | Only proves the script is registered, not that it runs |
| File / directory path | `src/host.ts` · `packages/core` | Directly measurable | `path-exists` | No rename tracking; a changed path is treated as disappearing |
| Mentioned identifier | 用的是 `APIRouter` (uses `APIRouter`) | Weakened check | `text-in-file` | Only proves the string is in the file, not that it is in use |
| Config entry | `engines.node` 有最低版本 (has a minimum version) | Directly measurable | `json-has-key` / `json-number` | The version number is a string, so `json-number` cannot read it |
| Line count / size | 单文件 200 行以内 (within 200 lines per file) | Directly measurable | `line-count` / `file-bytes` | Threshold-style claims need `lte` |
| Tests pass | 42 个测试全过 (all 42 tests pass) | Directly measurable | `test-passes` | See the next section; the most expensive and most valuable kind |
| Behaviour unchanged | 重构不改变输出 (refactoring does not change the output) | Directly measurable | `output-unchanged` | Compares stdout only; what is written to files does not count |
| Business invariant | 分项加总等于总额 (the line items add up to the total) | Directly measurable | `invariant-holds` | You write the criterion yourself |

---

## How to Handle Each Kind

### Counts

First ask "can it be counted?", then ask "count which one?".

- File count → `count-files`; in `glob`, `*` does not cross directories and `**` does
- Array length or object key count in JSON → `json-length`
- How many times a pattern occurs in a file → `regex-count`
- Line count of a file → `line-count`

**Common pitfall**: the documentation says 「17 个图标」 (17 icons), while `assets/art` contains png, ico and gif files at the same time. **First work out exactly which kinds the documentation means** and write the `glob` as `assets/art/*.png`, not `assets/art/*`. A wrong count is worse than no count, because it produces a wrong green cell.

### Lower Bounds and Approximations

`gte` only judges direction; it **does not judge whether the lower bound written in the documentation is too conservative**. If the README says 「1000+」 (1000 or more) while the actual value is 1539, it is still true under `gte`. To get an alert when the wording is "out of date", use `approx` or write an exact value.

In the terminal and on the page, the tool lists claims whose wording looks like a lower bound but which are compared by strict equality, but **it never changes the verdict automatically** — only a person knows whether the documentation means a lower bound or an exact value.

Lower bounds have one more side effect: when the relative gap is ≥15% and the absolute difference is ≥2, it is recorded as "wording hides the gap". Both numbers are chosen by hand; see [REFERENCE.md](REFERENCE.en.md).

### Ranges

「1600–1800 个」 cannot capture two numbers. Split it into two:

```json
{ "id": "size-min", "locator": "(\\d+)\\s*[–-]\\s*\\d+ 个", "compare": "gte", ... }
{ "id": "size-max", "locator": "\\d+\\s*[–-]\\s*(\\d+) 个", "compare": "lte", ... }
```

The two are judged independently and can come out one true and one false, which is closer to the facts than merging them into one.

### Commands and Scripts

`json-has-key` pointed at `scripts` in `package.json` only proves that it is **registered**. Whether the command can run, and whether it behaves correctly when it runs, is outside the scope of this type.

To really prove that it runs, use `test-passes` to run it — but that executes a command; see the next section.

### Tests, Invariants, Output Diffs

These three **execute commands** and are the only way to reach numbers computed inside function bodies. The cost and risk are higher than for the kinds above.

| Type | Holds when | Which claims it fits |
|---|---|---|
| `test-passes` | Exit code 0 | 「这个功能在」「这个接口这么用」 ("this feature is there", "this API is used like this") — the repository has corresponding tests |
| `invariant-holds` | Exit code 0 | 「分项加总等于总额」「酬金不为负」 ("the fee is never negative") — you write the property as a checking script |
| `output-unchanged` | stdout matches the baseline | 「重构不改变行为」 ("refactoring does not change behaviour") — the documentation says it should not change; see whether it changed |

A few must-reads:

- **Always write `watch`.** Without it, the check runs on every commit, and a repository with hundreds of commits will take a long time. `watch` takes the files the command actually reads (glob), and if their contents have not changed the previous result is reused.
- **A timeout or a start failure is recorded as "unmeasurable", never as a failure.** This is deliberate: something you cannot see must not be called fine, and must not be called a problem either.
- **Commands run in a temporary worktree, with the same permissions as the person running laminae.** Do not write commands that modify the system or delete data.
- **When several repositories run in parallel, they are automatically switched to serial.** Tests compete for ports and test databases, and running them at the same time makes them fight; failures then get recorded as "unmeasurable" — it looks like the tool is broken.

### Common Kinds That Cannot Be Measured

These are very common in real documentation, but **they cannot be measured today**, so do not put together a weakened version just to fill the gap:

| Claim | Why it cannot be measured |
|---|---|
| 「性能提升 3 倍」 ("3× performance improvement") | Needs a reproducible benchmark and hardware environment |
| 「支持 macOS / Linux」 ("supports macOS / Linux") | Unless the CI configuration lists it explicitly, it is only a string |
| 「用起来很简单」 ("simple to use") | The criterion is a person's feeling |
| The **number** in 「42 个测试全部通过」 ("all 42 tests pass") | You can measure whether a particular test passes, but cannot count how many pass in total — that needs a full run and parsing the output |
| 「生产环境跑了 6 个月」 ("ran in production for 6 months") | The repository has no run records |
| 「改进了错误处理」 ("improved error handling") | The criterion is a comparison of behaviour, not the shape of files |

When you meet these, **stop and tell the user "this claim cannot be verified", and say which files you read**. Do not fall back to `text-in-file` — that would make readers think it was verified.

---

## Rules for Adding to the Table

This table is meant to grow, but only **verified** entries may be added to it.

1. **Run it on real repositories first.** When you find a new pattern, try it on at least two or three different repositories and confirm that this combination of `fact`s really counts something.
2. **Write clearly where it is weaker.** The "weakened check" rows must have a sentence saying how much weaker it is than the original claim.
3. **Record known false positives.** For example, 「1600+ 而实际 1899 会被标成措辞盖住，但读者可能认为没问题」 ("1600+ while the actual value is 1899 would be flagged as wording hiding the gap, but readers might consider it fine"). False-positive rates are still recorded by type, not merged into a single number.
4. **Do not list "do it later" types.** The table holds only what can run now; otherwise the line in `SKILL.md` that forbids "passing off surface checks as verification" would be meaningless.

---

## Relationship to `suggest.ts`

`suggest.ts` pulls candidates out of Markdown by literal matching (lower bounds, approximations, commands, exact counts), and what it produces is a **draft** — the `fact` is mostly a placeholder and needs a person to edit it before use. This table is what you consult while editing.

The flow is:

```
node src/suggest.ts          # 捞草稿，打印 JSON，不写文件
node src/lookup.ts 草稿.json  # 在 HEAD 上查：捕获到什么文本、事实现在测到多少
# 对不上就改 locator 或 fact，再 lookup 一遍
# 都对上了，再放进 .laminae/claims.json
```

**Skipping `lookup` and writing straight into `claims.json` is wrong**: `suggest` only guesses from the literal text and does not check whether the thing actually exists in the repository. If the first run comes out all red, that step was most likely skipped.
