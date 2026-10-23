# Status and known issues

[中文](STATUS.md) | [English](STATUS.en.md)

As of `9d1e8bd`. This document answers three things: **what it can do now**, **what it has been validated on**, and **how far the tool can express itself**.

---

## 1. Six commands

| Command | Question it answers | Does it write |
|---|---|---|
| `scripts/run.ts` | How long has this been wrong on main, and what state is it in now | Only `.laminae/` |
| `scripts/derive.ts` | What is each function supposed to do (the agent reads code, not documents) | Only appends to `ideas.json` on `--accept` |
| `scripts/trace.ts` | What is the call path from an entry point down to a stub, splittable into subtasks | No |
| `scripts/branches.ts` | Is there a branch where this is already fixed but unmerged | No |
| `scripts/merges.ts` | Did a merge lose a fix | No |
| `scripts/verify.ts` | **Is this report fabricated** | No |

`verify` is already wired in as the last step of `run`: every report is checked as it is produced, and a failure makes the exit code non-zero.

---

## 2. Repositories tested

All real repositories, none constructed.

| Repository | Size | Languages | Result |
|---|---|---|---|
| **archify** | 889 files / 1 commit | JS, MJS, Astro | orphans 64 → 0; one layer down 0 current |
| **ElyOffice** | 1971 files / 1 commit | Rust, TS, Python | unsupported 703 → 0; graph 160 → 185 edges; orphans 9 → 6 (all six under `site/video/`, the recording scripts, which nothing imports) |
| **pallets/click** | 178 files / 3379 commits (1384 on the mainline) / 1207 merges | Python | 3 of 3 claims judged correctly; orphans 15 → 0; one layer down 100 → 0 current |
| **vuejs/core** | 703 files / 7234 commits (6513 on the mainline) / 35 merges | TS, Vue SFC | orphans 170 → 0; one layer down 12 → 0; all 4 claims true at HEAD; `verify` passes |

There are also 6 fixtures built for specific behaviours (call chains, branches, merges, entry points, claim lint, one layer down).

**250 tests**, of which more than 30 are end-to-end (they really spawn subprocesses and run the whole pipeline).

### Why these

- **click**: Python, real historical baggage (single file → multi-file refactor), textbook abstract methods, 1207 merges. It is the first repository that showed the tool could be wrong by whole categories at once.
- **vue**: clearly larger (4.7× click's mainline commit count), a TS monorepo, used to stress performance.
- **archify**: an Astro site plus a lot of `.mjs`, used to validate single-file components and references inside templates.
- **django was not chosen**: 34072 mainline commits × 7089 files, estimated at tens of hours.

---

## 3. Validated

| Capability | How it was validated |
|---|---|
| Claim verdicts | 3 claims on click, 4 on vue, each cross-checked by hand; `verify` recomputes them from git |
| Call-chain tracing | A four-level cross-file chain, intra-file nesting, and a call wrapped in an `if` all reach the bottom |
| Branch "fixed but unmerged" | A fixture with an unmerged branch reports correctly |
| Command facts on a branch | A constructed repository where the command fails on main and passes on the branch reports `main=false branch=true` |
| Merge "the fix was lost" | A fixture whose merge dropped a file reports correctly |
| Reproducible artifacts | The same payload rendered twice is byte-identical; a single edited character is caught |
| Multiple languages | JS/TS (including JSX and SFC), Python and Rust each have a syntax module; Rust was validated on 703 files in ElyOffice |

---

## 4. Pitfalls that were fixed (each with before and after numbers)

### 1. References inside single-file components were invisible

**Before** vue had 170 orphan modules. Earlier rounds brought it to 4, and all four had the same cause: they were imported by `.vue` files, and `.vue` was not in the code file set, so the edge did not exist at all.

**Now** `.vue` / `.svelte` / `.astro` all count as code files, and only the `<script>` block or the `---` fence is parsed — the template is HTML, and parsing it as JS treats things written in attributes as code.

**vue 170 → 0, archify 64 → 0.**

One correction along the way: I had written that the two archify files "really are unused". They are imported by `.astro` files. **"The tool found no evidence" and "there is no evidence" are not the same statement.**

---

### 2. A whole class of false positives in "one layer down"

**Before** vue reported 12 "currently holding" findings, and sampling showed almost all were false. After fixing four classes it is 0:

| Class | Example | Why it is not a defect |
|---|---|---|
| Code samples in comments | `// no: function NODE() {}` | a comment is not code |
| Code samples in strings | `"const xxx = () => {}"` | a string is not code |
| Type declarations | `declare function foo(...)` | a `.d.ts` cannot contain an implementation |
| Arrow functions | `export const NO = () => false` | an arrow is an expression; emptiness says nothing about whether the feature exists |

**vue 12 → 0.**

The boundary of the last one matters: file-level judgement **still** uses that signal — a file whose only content is a constant arrow is still classified `placeholder` by `classifyDepth`. That says "this file contains little", which is not the same question as "does a human need to look at this function".

---

### 3. The graph stage: 79% of the whole pipeline

**Before** the pipeline took 1397 seconds end to end, with the graph step alone at 1102.

| Metric | Before | After |
|---|---|---|
| Per commit | 212.5 ms | **63.8 ms** (3.3×) |
| End to end | 1397 s | **465 s** |
| Graph step | 1102 s | **269 s** (4.1×) |

Four rounds: dropping a backtracking regex (1.04×), **processing only the files that changed (2.05×)**, **replacing 6513 git calls with 2 (3.10×)**, and rewriting masking with slices (3.33×).

**The most important lesson: a percentage in a profile is not recoverable wall-clock time.** I chased a 26.2% line for three rounds and gained 4%. What actually worked was turning "rescan 5.6 MB per commit" into "scan only what changed".

---

### 4. Hop counts on a forked tree

**Before** the reported value was "the path computed last", not the shortest one. Two mistakes stacked: an unconditional overwrite, and each call edge being processed only once (so a shorter route discovered later was never recomputed).

**Now** the shortest path is reported. On a forked tree `entry→near→base` is 2 hops, no longer 3.

---

### 5. Command facts: measurable on a branch too

**Before** the branch scan recorded `test-passes` and friends as "cannot be measured", with a comment saying "this is not 'cannot be measured', this version deliberately skips them". **But what the user sees is "cannot be measured"**, and a comment cannot tell those two sentences apart.

**Now** the commit is checked out into a temporary worktree and the command really runs; when the watched files are unchanged it is not rerun; the worktree is removed afterwards and the main working directory is never touched.

Measured on a constructed repository (command fails on main, passes on the branch):

```
功能可用  main=假  分支=真  ← 分支上修好了，没合进来
```

---

## 5. How far the tool can express itself

This section is not a to-do list. The five items above are all fixed; what follows is **not defects but limits of the frame of reference**.

### 1. A file genuinely in use, with no textual evidence anywhere

ElyOffice has 6 orphan modules, all under `site/video/` — the promo video recording scripts, run by hand, which nothing imports.

**This is a true finding, not a false positive.** A human reading the report sees "6 orphan modules, all in `site/video/`" and decides in ten seconds. What the tool can do is **narrow the scope this far**, not eliminate it.

### 2. It can see "nothing uses it now", not what the author intended

A file that was never referenced since the day it was written looks identical, on the reference graph, to one that was used and then abandoned. The tool reports the first fact, not "this should be deleted".

### 3. A dynamically composed path can be followed one level at most

`` `render-${type}.mjs` `` is recognised. A path assembled from three variables inside `path.join(a, b, c)` is not. When it cannot tell, it does not guess — it reports the file and lets a human look.

### 4. Language coverage

JS/TS (including JSX and SFC), Python and Rust have syntax modules. The extensions of Java, Go, C/C++, Kotlin, Swift, Ruby and PHP are recognised, but the tool only says **"recognised, no module"** — it does not judge true or false for them.

### 5. Facts in a document have to be writable as a regex

A locator in `claims.json` is a regular expression, and the number in its first capture group is the value the document claims. If the document changes phrasing (say "about 20" becomes "a score or so"), the locator stops matching and the cell is recorded as "cannot be measured". **That is not the tool judging wrongly; it is the tool not seeing.**

---

## 6. Where this tool's boundary lies

**It verifies; it does not screen.**

- **Verification**: the document says X, go check whether X is true in the code. This output has never been wrong on a real repository.
- **Screening**: the tool decides there is a problem somewhere and reports it. This output has been wrong by whole categories on real repositories.

To tell which one a feature belongs to, ask whether it has a **source**:

| | Verification | Screening |
|---|---|---|
| Who raised it | the document itself | the tool |
| Is there a source | yes, it points at a line | no, it is a heuristic |
| Who notices when wrong | it shows up on the first run | nobody |

**Screening output must either carry evidence or stop appearing as a problem.** This is the most expensive lesson of the whole effort; see [Pitfalls](LESSONS.en.md).
