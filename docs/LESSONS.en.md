# Pitfalls

[中文](LESSONS.md) | [English](LESSONS.en.md)

Reverse chronological. Every entry states three things: **the symptom**, **the root cause**, **what changed**.

Two kinds: **defects in the tool** (it accuses wrongly, misses things, or crashes), and **my own operational mistakes** (not product bugs, but pitfalls all the same, and easier to repeat).

---

## 1. Defects in the tool

### Isolated modules counted entry scripts as defects (click, 15 of 15 wrong)

**Symptom** click reported 15 isolated modules; checking them by hand, **all 15 were wrong**: 12 under `examples/` (sample scripts you run with `python xxx.py`), 2 under `docs/` (configuration Sphinx loads), and one `src/click/testing.py`.

**Cause** The criterion was "no module imports it". In a library that is almost always wrong — **a module with no internal importer is usually an exit, not an entrance**. `click/testing.py` provides `CliRunner` for users; the library itself has no reason to import it.

**What changed** Evidence now comes from declarations written in the repository, and one match excludes the file, with the reason reported: directory role (`examples/`, `docs/`, `scripts/`, `bin/`), Python package membership (an `__init__.py` beside it), manifest declarations (`bin`/`main` in `package.json`, entry points in `pyproject.toml`, `path` in `Cargo.toml`), or a `#!` first line. click went 15 → 0; archify went 4 → 3 (the one removed starts with `#!`, it is a script).

**Lesson** "No incoming edge" is a structural fact, not a defect. Treating it as a defect is like diagnosing a person because their blood pressure is not referenced anywhere.

---

### "One layer down" treated history as the present (click, 53 of 100)

**Symptom** 100 findings, 53 of which existed only in the single-file `click.py` of 2014 (later split into `src/click/`) and were long gone at HEAD.

**Cause** Both `unreferenced` and `down` are recorded per commit, and `intervals()` keeps every range where the condition once held. The list is ordered by time and truncated to the first 40 — **all historical noise, and current problems never made it in**.

**What changed** Each finding carries `atHead`, computed from whether its `alive` interval covers the last commit. Historical entries are folded into `<details>`, collapsed by default but expandable.

**Lesson** Fold, do not delete. "It used to be here and then went away" is information: it says the path was fixed.

---

### Empty functions in tests and examples counted as defects (click, 45 of 47)

**Symptom** After removing historical noise, 45 of the remaining 47 "currently holding" findings were in `tests/`, 2 in `examples/`, and **zero in `src/`**.

**Cause** A fixture in a test (`def f(): pass`) and an empty CLI in an example are the writing itself, not a defect.

**What changed** Both the call-chain marking and the hollow-function marking now skip test files and `examples`/`docs`, reusing the same `ENTRY_DIR` as isolated modules. click reports 0 current and 48 historical.

**Lesson** The same thing as the first entry: treating "this is how it is meant to be" as "this is wrong".

---

### Isolated modules were not filtered by "still holds now" (vue, 119 of 170)

**Symptom** vue reported 170 isolated modules, **119 of which do not exist at HEAD at all** — early paths that were later renamed or moved.

**Cause** Exactly the same defect as "one layer down". `atHead` was added there and **missed here**.

**What changed** The same `aliveNow` predicate. 170 → 31.

**Lesson** A fix applied in one place does not mean the same class of problem is fixed elsewhere. **After fixing, ask: where else does this defect appear?**

---

### Files loaded by tooling by name counted as isolated (vue, 27 of 31)

**Symptom** After filtering history, 31 remained, all new faces: `vitest.config.ts`, `eslint.config.js`, `vite.config.ts`, `__benchmarks__/*.bench.ts`, `dts-test/*.test-d.ts`.

**Cause** They are never imported by application code, but **every one of them is alive** — the tools find them by file name, suffix or directory.

**What changed** Added `TOOL_LOADED` and `BENCH_DIR`. The criterion is the suffix and directory name, **not a guess** — this is literally how vitest, eslint, vite and tsc find them. 31 → 4.

**Lesson** Every new ecosystem brings another batch of "loaded by convention". That is an inherent cost of this tier; each one must be added individually, and each must point at "the tool really looks for it this way".

---

### A wrong rule accused the document of being false

**Symptom** A locator capture group carried one extra character (a backtick inside the parentheses captured `docs/help.md` plus a trailing backtick). The file existed, yet the claim was judged false.

**Cause** The captured text was used directly to look up a path; one extra character and the lookup fails.

**What changed** Two independent badges, neither changing the verdict: `ruleMiss` (the locator matched nothing across the whole history) and `captureHint` (after trimming leading and trailing punctuation, a file with that name does exist). Shown in amber, not red — **this is not "false", it is "not measured accurately"**.

**Lesson** A check that accuses wrongly is worse than no check: people stop believing the red.

---

### The first implementation of `ruleMiss` was wrong

**Symptom** It was meant to detect "the locator never matched", and it reported nothing.

**Cause** It was written as `verbatimRuns.length === 0`. But when a locator never matches, `verbatimRuns` **is not an empty array — every run has `text: null`**.

**What changed** `verbatimRuns.length === 0 || verbatimRuns.every((x) => x.text === null)`.

**Lesson** "Not found" has two shapes: an empty container, and a container full of empty values. A test caught this immediately.

---

### A claim that cannot be expressed was silently recorded as "not yet written in the document"

**Symptom** A `regex-count` claim's locator captured `8.6.0` (a version string), which does not parse as a number, so every commit was recorded as "not yet written". **The document clearly says 8.6.0, and the report says it does not.**

**Cause** Numeric fact types compare against the captured text; `parseClaimedNumber("8.6.0")` returns `null`, so the state fell to absent.

**What changed** Added claim lint (`lint.ts`), run before measuring, checking three things: the capture does not parse as a number, the locator matches nothing in the document at the base commit, and the `fact` object carries fields its type does not accept.

**Lesson** Silent degradation is worse than an error. An error at least tells you something is wrong; silent degradation makes you think nothing is.

---

### Extra fields in `fact` were dropped silently

**Symptom** `"compare": "gte"` and `"claim": 5` were written inside `fact`. Neither took effect, and nothing said so.

**Cause** `parseFact` **rebuilds the object**; fields it does not recognize are dropped.

**What changed** The linter checks the field whitelist per fact type and reports extras, listing which fields that type does accept.

**Lesson** Anywhere input is "read and rebuilt", information is lost silently.

---

### A piece of dead code that could never run

**Symptom** The linter was also going to check "compare on a referential fact is meaningless".

**Cause** While writing the test, it turned out `parseClaims` **already throws** for that — harder than a warning.

**What changed** Removed.

**Lesson** Do not keep a function that cannot run and let it pass for checking capability.

---

### A check that never fails is no check

**Symptom** The verifier passed on click, every time.

**Cause** It had never been shown to fail.

**What changed** Faked it twice: edited a number in the HTML, and forged the summary numbers in the payload. Both were caught, with the exact character position and the line. Also added a **renderer fingerprint** — when a report was produced by an older renderer, replay is skipped with a warning, **otherwise changing a stylesheet would mark every old report as tampered**.

**Lesson** A verifier must itself be verified. And **do not cry wolf**: cry it often enough and nobody reads the check.

---

### Rust module: `looksLike` used `=>` to exclude JS

**Symptom** Half the Rust files were treated as JS, and no functions were recognized.

**Cause** The predicate was "has `fn` and no `function(` and no `=>`". But **Rust `match` arms use `=>` too**.

**What changed** Look only at `fn name(` versus `function name(`.

**Lesson** Excluding one language by another language's syntax feature collides easily.

---

### Rust module: empty bodies counted as stubs

**Symptom** 13 "hollow" findings, all of them trait default implementations (`fn quitting(&mut self) {}`).

**Cause** An empty body is **idiomatic Rust**: trait defaults, marker impls, callback placeholders.

**What changed** In Rust, `empty` is not treated as hollow; the real markers are `unimplemented!()` and `todo!()`, which stay. `unreachable!()` does not count either — it is a guard, not a stub.

**Lesson** "Empty" means different things in different languages. Applying one rule across languages produces false positives.

---

### Rust module: imports were not resolved, and the graph shrank

**Symptom** After adding Rust, the import graph went from 160 edges **down to 19**, and isolated modules went from 9 **up to 74**.

**Cause** `.rs` files fell into the JS parsing branch, so not a single `use crate::a::b` was resolved.

**What changed** Added `resolveRust`: `crate::a::b` looks for `a/b.rs` or `a/b/mod.rs` under `src/`, `super::` goes up, `self::` is the current module. Back to 185 edges and 10 isolated.

**Lesson** **This defect cannot be found by unit tests** — it only shows up as numbers on a real repository. Adding a language adds a path that has not been validated.

---

### Moving directories: `tsc` green, 8 tests failing

**Symptom** After splitting 37 modules into six groups, `tsc --noEmit` passed and `npm test` failed 8 tests.

**Cause** The `STEPS` array in `run.ts` used **bare file names** (`"measure.ts"`); the path was assembled elsewhere. A rewrite rule keyed on the `"src/"` prefix could not reach them.

**What changed** Switched to repository-relative paths (`"src/measure/measure.ts"`), and added a test: scan `file: "..."` in `run.ts`, each must start with `src/` and exist.

**Lesson** **String paths are not imports, and `tsc` cannot see them.** Only running the tests catches this.

---

### Moving directories: `SKILL_ROOT` off by one level

**Symptom** Same round. `SKILL_ROOT` was computed as `path.resolve(HERE, "..")`; `HERE` changed from `src` to `src/core`, so it stopped at `src`.

**Cause** Computing a path by counting `..` levels breaks the moment a file moves, **and it does not fail loudly** — everything that points at it silently points somewhere else.

**What changed** Changed to `"../.."`, and added assertions: the repository root must contain `SKILL.md`, `package.json` and `src/`, and must not overshoot (no `types.ts` at the root).

**Lesson** Either assert on computed paths or do not compute them from level counts.

---

### Full document text stored per commit hit the V8 string limit

**Symptom** On vue (6513 commits) the pipeline died in its first step: `RangeError: Invalid string length`.

**Cause** One full copy of the document text per commit. vue's CHANGELOG is a few hundred KB, **6513 copies ≈ 1 GB**.

**What changed** Text is deduplicated by content and `commits` stores an index. **1 GB → 45 MB**. README has only 55 versions and CHANGELOG 315 — most commits never touch the documents.

**Lesson** Scale problems do not show up on small repositories. click (1384 commits) ran fine.

---

### Code samples inside comments and strings were parsed as real code

**Symptom** On vue, "one layer down" reported an empty function named `xxx`, plus `NODE` and `foo`. The source was two comment lines:

```js
// Note: functions inside this closure should use `const xxx = () => {}`
// no: function NODE() {}
```

**Cause** `findFunctions` scanned the raw text and did not skip comments or strings. Writing code samples in comments is common, and once one matches, `hollowFunctions`, `delegatedCalls` and `classifyDepth` all go wrong with it.

**What changed** Added `maskNonCode`: the **body** of comments and strings is replaced with spaces, keeping length, newlines and the quotes themselves. Length is preserved so offsets stay valid — a match position can still be used to slice the original text for line numbers. All three syntax modules and `delegatedCalls` now scan the masked text. On vue the current count went 12 → 7.

**Lesson** When a regex scans source code, code inside comments is the most common source of false positives.

---

### Type declaration files were counted as empty implementations

**Symptom** 4 of the remaining 7 were in type-test files under `dts-test` — `declare function foo(...)` treated as "the body is empty".

**Cause** A type declaration file cannot contain an implementation by definition. **Type declarations were being read as code.**

**What changed** A `TYPE_ONLY` regex, added to both skip conditions.

**Lesson** The first regex only recognized `.d.ts` and did not match `*.test-d.ts` (it ends in `-d.ts`, not `.d.ts`). A test caught it immediately.

---

### Performance: three rounds of micro-optimisation gained 4%, one incremental change gained 105%

**Symptom** On vue (6513 mainline commits) the whole pipeline took 1397 seconds. The graph step alone took 1102.

**How it was found** Not by guessing — `node --cpu-prof` over 80 real commits showed 43.5% in the file-name regex I had just added, 18.8% in git subprocesses, and 10.8% in `maskNonCode`.

**Four rounds**, each re-measured on the same 80 commits:

| Round | ms/commit | Cumulative |
|---|---|---|
| Start | 212.5 | — |
| Replace the backtracking regex | 204.5 | 1.04× |
| **Incremental** (only files that changed) | 103.6 | 2.05× |
| **Batched** (6513 git calls → 2) | 68.6 | 3.10× |
| Masking rewritten with slices | 63.8 | 3.33× |

End to end: **1397 seconds → 465 seconds**.

**The two lessons that matter:**

1. **A percentage in a profile is not recoverable wall-clock time.** I chased the 26.2% line for three rounds and gained 4% — that time was spent in the loop body over thirty thousand tokens, not in the map insertions I assumed. Only change a hotspot when its *size* can be reduced; making it slightly faster is usually wasted effort.

2. **Incremental is an order of magnitude better than micro-optimisation.** The hotspot was "rescan 5.6 MB of text per commit", while 99% of that text is identical between adjacent commits. Processing only changed files gained 105% in one go.

---

### Batching: the starting point was wrong, twice

**Symptom** Replacing 6513 `git ls-tree` calls with one `git log --raw` plus in-memory reconstruction produced 7 mismatches out of 8 sampled commits when compared against `ls-tree`.

**First mistake** I `unshift`-ed the first commit from `rev-list` into `order`, but `git log` output already contains it — the whole index was off by one, so every commit received the previous one's state.

**Second mistake** The starting point was "the commit requested first". Callers ask in chronological order, so the first request is the **earliest** commit, and `git log <earliest>` returns only that commit. The starting point must be the repository tip.

**How it was confirmed** Not by reading the code: eight sampled commits were compared entry by entry against `git ls-tree -r`, and only zero differences counted as passing.

**Lesson** Index-reconstruction code cannot be verified by reading it. **You need an independent reference implementation to compare against.** `git ls-tree` was that reference.

---

### A pointer that did not advance swallowed half a file

**Symptom** After rewriting `maskNonCode` from "split into a character array" to "accumulate slices", four tests failed.

**Cause** After handling a string, the cursor stayed on the closing quote, so the next iteration treated it as an opening quote and blanked everything from there to the next quote — or to end of file. The symptom was that everything after `import ... from './x'` was masked out.

**Lesson** In a hand-written scanner, ask of every branch: **did the pointer advance?** Wherever the code says "handled, continue", confirm the next iteration does not start on the character just handled.

---

### "Nothing uses it" and "I cannot see it" are two different things

**Symptom** archify reported two orphan files, and I had written in the docs that "the remaining 3 really are unused".

**Wrong** Both files are imported by .astro components:

  website/src/pages/community.astro:  import { packages } from '../data/community';
  website/src/layouts/SiteLayout.astro:  import { productChannel } from '../data/product-facts';

.astro was not in the code file set, so those edges did not exist. **When I said "really unused", the only fact I had was that the tool could not see them.**

**Lesson** "The tool found no evidence" and "there is no evidence" are two different sentences, and only the first is mine to say. Anywhere the docs claimed "confirmed unused", they should say "the tool found no reference".

**Three shapes of this** (no edge on the reference graph, yet the file is genuinely in use):

1. **Single-file components** .vue / .svelte / .astro — imports live in a <script> block or a --- fence
2. **Path-shaped strings** `${location.origin}/src/vue-dev-proxy` — loaded by the dev server by path
3. **Composed file names** `render-${type}.mjs` — the interpolation is treated as a wildcard

**What it costs** All three can only prove "someone mentioned this name", not "this file is being used". The third is the loosest: one `render-${x}.mjs` anywhere means no render-*.mjs will ever be reported as an orphan again. This whole tier has always leaned towards **missing a real orphan rather than reporting a file in use as unused**.

---

### examples in a nested directory did not count as examples

**Symptom** ElyOffice reported `crates/ely-ui/examples/shell/probe/support.rs` as an orphan.

**Cause** The `ENTRY_DIR` regex was anchored at the start (`^(?:examples?|...)\/`), so only a root-level examples directory counted. But `crates/x/examples/` is the Cargo convention and means exactly the same thing.

**What changed** A second regex, `ENTRY_DIR_ANY`, allows example directories at any depth. Only examples, samples, demos and benchmarks are opened up — their meaning is unambiguous. `scripts/`, `bin/` and `docs/` still only count at the root, because a nested directory with those names is often a build artefact or vendored code.

**One number corrected** I believed ElyOffice had 0 orphans back then. The stored run records show 9. It went 9 → 7 → 6, an improvement at every step, not a regression. **Checking recorded data beats trusting memory.**

---

## 2. My own operational mistakes

These are not product bugs, but **they are easier to repeat than product bugs**, and each one nearly made me misdiagnose the tool.

### Reading the state encoding backwards and chasing a bug that did not exist

**Symptom** I saw the tail of `states` was `0`, decided "0 means false", and concluded the tool was accusing wrongly. I wrote a probe, ran lookup, read `judgeState`, went through `analyze.ts`.

**The truth** **`0` is true.** The evidence was right beside it: `totalFalse=0`, and `actual` ended in `1,1,1`. I did not look.

**Lesson** Drawing a conclusion from a number you have not cross-checked is exactly what this project exists to prevent. **First look for a neighbouring number that contradicts you.**

---

### A backtick-n inside PowerShell single quotes is not a newline

**Symptom** Building a test repository, `Set-Content "src\mid1.ts" '...`n...'` produced a single line containing a literal `` `n ``, plus a BOM. The tool read garbage and recognized no functions.

**Cause** PowerShell **single-quoted** strings do not process escapes.

**What changed** Wrote the files from Node instead.

**Lesson** I almost reported this as a bug in the tool. **Suspect the data you built first.**

---

### `Set-Content -Encoding UTF8` writes a BOM

**Symptom** `JSON.parse` failed during `--accept`.

**Cause** PowerShell 5.1's `-Encoding UTF8` writes **UTF-8 with BOM**.

**What changed** Use `[System.IO.File]::WriteAllText($p, $s, [System.Text.UTF8Encoding]::new($false))`, and strip `/^\uFEFF/` when reading as a fallback.

---

### `>` redirection writes UTF-16

**Symptom** After `node x.ts > out.json`, `JSON.parse` could not read it.

**Cause** PowerShell's `>` defaults to UTF-16LE.

**What changed** Added an `--out` flag to `trace.ts` so it writes UTF-8 without BOM itself. **The same trap applies to an agent, so it was moved into the tool.**

---

### `.Contains()` in PowerShell compares array elements

**Symptom** "Does LICENSE contain MIT" returned `False`, although the file literally says `The MIT License`.

**Cause** `git show` output in PowerShell is an **array of strings**; `.Contains("MIT")` asks whether some element equals `MIT`.

**What changed** `-join "`n"` first, then `.Contains()`.

**Lesson** As above — **a wrong prediction makes me think the tool is wrong**.

---

### `git grep` returns empty silently outside a git repository

**Symptom** Running `git grep` in the ElyOffice copy (not a git repository) reported "0 stub markers", and I nearly reported the repository as clean.

**Cause** Outside a git repository `git grep` **returns empty silently**, without an error.

**What changed** Switched to scanning files with `Select-String`.

**Lesson** "Not found" and "the query failed" must be kept apart. This is exactly why the four-state design has an `unmeasurable` value.

---

### A probe script ran twice and overwrote its own backup with the broken version

**Symptom** To prove a new test catches a regression, I temporarily changed a step path back to a bare name. The probe backed up first, then edited — **but I ran it twice**. On the second run the file was already broken, so **the backup was overwritten with the broken version**, and restoring it restored the breakage. 30 tests failed before I noticed.

**What changed** Restore from `git checkout`, not from my own backup.

**Lesson** A probe script must be idempotent, or its restore must go through git.

---

### Slicing code by indentation, and slicing too little

**Symptom** While editing the call-chain loop in `layers-core.ts`, I bounded it by "the `}` above `pending = next`". That matched the inner `for` brace, cut too little, and left a syntax error.

**What changed** Reverted and used the `edit` tool for exact text replacement.

**Lesson** Guessing structure from indentation is fragile. **If a precise replacement tool exists, do not slice with a script.**

---

### An IIFE before `esc` was defined crashed on import

**Symptom** The warning block at the top of the report was written as a module-level immediately-invoked function; importing the module threw `ReferenceError: Cannot access 'esc' before initialization`.

**Cause** TDZ — `esc` is defined after that block.

**What changed** Turned it into a function, evaluated where the template uses it.

**Lesson** `tsc` was green. **The end-to-end test caught it.**

---

### Full clone versus blobless clone

**Symptom** click was cloned with `--filter=blob:none` first, and after 178 seconds it was still reading files.

**Cause** With a blobless clone every file read goes over the network.

**What changed** Use blobless clones to measure size (fast), and switch to a full clone before running the pipeline.

---

### Running the verifier in the wrong directory

**Symptom** Running `verify` inside click's directory with archify's run id produced "run run.ts first".

**Lesson** Each repository's verification has to run in its own directory.

---

## 3. The same defect, over and over

Looking back, nearly every defect in the tool is one sentence in different words:

> **Treating "this is how it is meant to be" as "this is wrong".**

| What was reported | What it actually was |
|---|---|
| 15 isolated modules | entry scripts, documentation tooling, a library's public API |
| 100 hollow chains | 53 historical + 45 test + 2 example |
| 170 isolated modules | 119 historical paths + 27 loaded by tooling by name |

Meanwhile the **verdict** output — the document says X, go check X — never got anything wrong on a real repository.

That boundary is now clear:

> **Wherever it is "the document says X, go check X", it is accurate.**
> **Wherever it is "the tool thinks there is a problem here", first ask "is this how it is meant to be".**

If that question cannot be answered, the finding should not be presented as a problem at all.
