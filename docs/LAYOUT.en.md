
[中文](LAYOUT.md) | [English](LAYOUT.en.md)
﻿# Layout and command map

Two things: what each of the five commands answers, and how `src/` should be grouped by responsibility.

## Command map

Five entry points, all run inside the target repository.

| Command | Question it answers | Does it write |
|---|---|---|
| `scripts/run.ts` | How long has this been wrong on main, and what state is it in now | Only `.laminae/` |
| `scripts/derive.ts` | What is each function supposed to do (the agent reads code, not documents) | Only appends to `ideas.json` on `--accept` |
| `scripts/trace.ts` | What is the call path from an entry point down to a stub | No |
| `scripts/branches.ts` | Is there a branch where this is already fixed but unmerged | No |
| `scripts/merges.ts` | Did a merge lose a fix | No |
| `scripts/verify.ts` | **Is this report fabricated** | No |

`verify` is already wired in as the last step of the `run` pipeline: every report is checked as it is produced, and a failure makes the exit code non-zero. **Nothing depends on someone remembering to run it.**

**The last four are read-only**, and all read git objects directly without touching the working tree (except command facts such as `test-passes`, which need a temporary worktree).

## How they relate

```
run       verdict: true/false, false runs, hiatus, layer reconciliation
derive    extra source: infer from code, not only from documents
trace     explain the verdict: which path led here
branches  edges: what other states exist outside main
merges    edges: did history lose something
```

## The current state of src/

37 modules, about 7,000 lines, **flat in one directory**. The names do not show grouping: `types.ts` sits beside `survival.ts`, but one is global types and the other is survival analysis.

## Proposed grouping

| Directory | What goes there | Current files |
|---|---|---|
| `core/` | Global config and infrastructure | `config` `gitutil` `types` `paths` `runid` `exclude` `repos` |
| `measure/` | Per-commit evaluation | `claims` `facts` `observe` `compare` `lookup` `measure` |
| `judge/` | From value to verdict | `classify` `survival` `analyze` `accuracy` |
| `layers/` | Import graph and layer reconciliation | `layers-core` `imports` `scan` `lang` `syntax*` `graph-core` `graph-util` `graph` |
| `ideas/` | Ideas, boundaries, inference | `ideas-core` `ideas` `candidates` `derive` |
| `output/` | Artifacts | `build-data` `render` `indexhtml` `suggest` |

### One dependency-direction constraint

For the grouping to hold, **arrows may only point downward**:

```
scripts/  →  ideas/ layers/ judge/ measure/ output/ core/
web/      →  core/ measure/ (only types, compare, graph-util)
```

**`core/` must never depend back on another group**, or the cycle returns. `types.ts` is imported by every group today, which is exactly why it belongs in `core/`.

## Moving touches four places

This is not a plain `git mv`:

| Place | Why it changes |
|---|---|
| Inside `src/` | Relative `./x.ts` becomes `../group/x.ts` |
| `web/` | Imports `types`, `compare`, `graph-util` |
| `scripts/` | Imports 15 modules |
| `test/` | 21 distinct paths |
| **Script paths in `run.ts`** | Hard-coded strings like `"src/measure.ts"` must move too |
| **Script paths in `test/`** | Same; tests hard-code them as well |

The last two are the easy ones to miss — they are not imports but **strings**. `tsc` cannot see them; only running the tests exposes them.

## The order to move in

1. Create the directories, `git mv` every file
2. Fix imports inside `src/`
3. Fix imports in `web/`, `scripts/`, `test/`
4. **Grep the whole tree for strings like `"src/xxx.ts"` and update them** (in `run.ts` and `test/*.ts`)
5. `tsc --noEmit`
6. `npm test` (224 tests)
7. Then `npm run build:web` and confirm the bundle still builds

**Step 5 going green does not mean it is correct**; steps 6 and 7 are the real check. A wrong string path only shows up at runtime.

## When to do it

**Do it with a full budget, never half-way through something else.**

It is a pure move with no behaviour change, but if it stops midway the repository is left with imports pointing at files that do not exist — worse than not starting.
