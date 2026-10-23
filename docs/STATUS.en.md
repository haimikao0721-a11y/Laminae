# Status and known issues

[中文](STATUS.md) | [English](STATUS.en.md)

As of `d136ada`. This document answers three things: **what it can do now**, **what it has been validated on**, and **what is still missing**.

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
| **archify** | 889 files / 1 commit | JS, MJS | isolated 64 → 4 (later 3); a clean repository |
| **ElyOffice** | 1971 files / 1 commit | Rust, TS, Python | unsupported 703 → 0; graph 160 → 185 edges |
| **pallets/click** | 178 files / 3379 commits (1384 on the mainline) / 1207 merges | Python | 3 of 3 claims judged correctly; isolated 15 → 0; one layer down 100 → 0 current |
| **vuejs/core** | 703 files / 7234 commits (6513 on the mainline) / 35 merges | TS | isolated 170 → 4; all 4 claims true at HEAD; `verify` passes |

There are also 6 fixtures built for specific behaviours (call chains, branches, merges, entry points, claim lint, one layer down).

**235 tests**, of which 30 are end-to-end (they really spawn subprocesses and run the whole pipeline).

### Why these

- **click**: Python, real historical baggage (single file → multi-file refactor), textbook abstract methods, 1207 merges. It is the first repository that showed the tool could be wrong by whole categories at once.
- **vue**: clearly larger (4.7× click's mainline commit count), a TS monorepo, used to stress performance.
- **django was not chosen**: 34072 mainline commits × 7089 files, with an `ls-tree` of the whole tree per commit; estimated at tens of hours.

---

## 3. Validated

| Capability | How it was validated |
|---|---|
| Claim verdicts | 3 claims on click, 4 on vue, each cross-checked by hand; `verify` recomputes them from git |
| Call-chain tracing | A four-level cross-file chain, intra-file nesting, and a call wrapped in an `if` all reach the bottom |
| Branch "fixed but unmerged" | A fixture with an unmerged branch reports correctly |
| Merge "the fix was lost" | A fixture whose merge dropped a file reports correctly |
| Reproducible artifacts | The same payload rendered twice is byte-identical; a single edited character is caught |
| Multiple languages | JS/TS, Python and Rust each have a syntax module; Rust was validated on 703 files in ElyOffice |

---

## 4. Known issues, by severity

### 1. Imports inside `.vue` files are invisible

**Symptom** The last 4 isolated modules on vue all have the same cause: they are imported from a `.vue` file.

```js
// packages-private/sfc-playground/src/Header.vue
import { downloadProject } from './download/download'
```

`.vue` is not in the set of code files, so the edge does not exist and `download.ts` looks unused.

**Impact** Any Vue, Svelte or Astro project will have this whole class of false positives.

**Fixing it means reading the `<script>` block of an SFC**, not adding another rule.

---

### 2. "One layer down" has a whole class of false positives

**Symptom** vue originally had 12 "currently holding" findings. After fixing comment masking and type declarations, 3 remain, and all three are code that is meant to be this way:

| Example | Why it is wrong |
|---|---|
| `shared/src/general.ts:13  NO  return-const` | `export const NO = () => false`, documented as "Always return false." — an intentional constant predicate |
| `compiler-sfc/src/index.ts:89  shouldTransformRef` | `() => false`, a feature flag that is temporarily off |
| `runtime-core/src/apiWatch.ts:186  watchStopHandle` | an empty handle that later gets `.stop` / `.resume` so the API shape holds |

Two classes were fixed: code samples inside comments and strings (`xxx`, `NODE`, `foo`), and type declaration files (`declare function`).

**Impact** Arrow constant functions, type declarations and parsing artifacts will keep being reported.

**Why it is not fixed** Its root cause is different from the ones above (it is not "this is how it is meant to be", it is "the parse is wrong"), and it needs its own design. Forcing it in would also suppress genuine stubs.

---

### 3. The graph stage takes 79% of the time

**Symptom** On vue (6513 mainline commits):

```
measure      290s
graph       1102s   ← 79%
ideas          3.6s
build-data     0.5s
render         0.2s
verify         0.9s
```

**Impact** Another doubling in size will not finish. A repository the size of django is out of reach.

**This is the next thing to optimise.**

---

### 4. `hops` under-reports on a forked tree

**Symptom** `hops` records the distance to the nearest stub. On a straight chain it is exact (measured on a four-level chain: `deep(1) mid2(1) mid1(2) top(3)`), but on a forked tree a function reaches a stub at different distances along different paths, and a single number loses that.

**Impact** It currently only affects the confidence label, not the true/false verdict.

---

### 5. Command facts need a working tree

`test-passes`, `invariant-holds` and `output-unchanged` execute a command and need a temporary working tree. Branch scanning skips them and records "unmeasurable" — **it does not pretend to have checked**.

---

## 5. Not done yet

| Item | Why it is worth doing |
|---|---|
| Read the `<script>` block of `.vue` / `.svelte` | Removes the first class of false positives and covers the frontend ecosystem |
| Optimise the 1102 seconds in graph | Decides whether larger repositories are reachable at all |
| Classify the false positives in "one layer down" | Arrow constants, type declarations, parsing artifacts |
| Locate a chain from a natural-language question | Today a function name or keyword must be supplied |

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
