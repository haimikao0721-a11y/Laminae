# laminae Design Specification

[中文](SPEC.md) | [English](SPEC.en.md)

This document explains laminae's data model, measurement approach, and UI implementation. See `README.md` in the root directory for how to run it.

---

## 1. Measurement

- One run binds to exactly one repository: the git root of the directory it runs in (overridable with `LAMINAE_REPO`). That root must not be laminae's own repository. File paths inside claims must be relative paths within that repository. laminae's code contains no paths or numbers belonging to any specific project
- File contents are read commit by commit from the git object database. Facts that count things in the repository neither check out nor modify files already tracked in the target repository. `test-passes`, `invariant-holds`, and `output-unchanged` run the commands written in claims.json inside a temporary git worktree, which is deleted once measurement finishes, leaving the main working tree untouched. Generated artifacts are written inside the target repository: `.laminae/data/` and `laminae.html`
- The commit sequence comes from `git log --first-parent --reverse`, following only the mainline; each merge counts only the merge commit itself, and commits on merged branches do not enter the sequence, otherwise the truth of the same claim would jump back and forth between the states of different branches. `measure.ts` and `build-data.ts` share `LOG_ARGS` from `config.ts`; the two sides align by index, so their arguments must match
- Each claim is declared in `.laminae/claims.json` in the target repository (the path can be overridden with `LAMINAE_CLAIMS`):

| Field | Meaning |
|---|---|
| `id` | Unique identifier |
| `file` | The file the claim lives in |
| `locator` | Locating regex; capture group 1 is the number the document asserts |
| `fact` | Declaration of the measurable fact |
| `label` | Display name, defaults to `id` |
| `impact` | `high` / `normal` / `low`, defaulting to `normal`. Annotated by the user, used only for badges on the page and for sorting "by importance"; it enters no calculation of hiatus, survival curves, or closure rate |
| `compare` | `eq` (default) / `gte` / `lte` / `approx`. For numeric claims, the claim is true when "the number written in the document" and "the fact" satisfy this relation, and false otherwise. `gte`: fact ≥ the document's number; `lte`: fact ≤ the document's number; `approx`: `abs(fact − the document's number) ≤ tolerance × abs(the document's number)` (when the document writes 0, only 0 counts). A reference-type fact can only be `eq`. The determination of "not written yet" and "unmeasurable" is unrelated to it, and outcome classification (reality-caught-up and so on) likewise only looks at whether the numbers changed, unaffected by it |
| `tolerance` | Only for `approx`; a relative error from 0 to 1, defaulting to `0.05` |

- Facts are described by a declarative `fact` and are not written into code. Types are in `src/facts.ts`:

| `type` | Number measured |
|---|---|
| `count-files` | Number of files matching a glob |
| `json-length` | Length of an array or number of keys of an object in JSON |
| `json-number` | A numeric field in JSON |
| `regex-count` | Number of regex matches in a file |
| `line-count` | Number of lines in a file |
| `file-bytes` | Number of bytes in a file |
| `test-passes` | 1 when the command's exit code is 0, 0 when non-zero. The document always asserts 1 (it should pass). Whether the claim changed is read from the body of the file the claim lives in (or of `source`) |
| `invariant-holds` | Same as `test-passes`; the semantics is an invariant |
| `output-unchanged` | 1 when standard output is identical to that at "the first appearance of the text captured by locator", 0 when different. If the captured text changes, the baseline resets. It does not judge whether the output is correct |

A timeout or a process that fails to start counts as "unmeasurable". If the contents of the files in `watch` are unchanged, the previous result is reused. For these three types, `compare` can only be `eq`.

- Layer reconciliation (`layers-core.ts`, automatic, does not need to be declared in claims.json, and only recognizes JS/TS/Python): conclusions that hold are split into three tiers. Hollow implementation = structurally empty (an empty file, a note saying it is not implemented, functions that only return empty values or constants); a route path that matches but whose handler is empty also counts. Failure to recognize it counts as an error. Covered up = pure re-export, referenced only by tests, `gte`/`lte`/`approx` with a relative gap of at least 15% and an absolute gap of at least 2 at the same time, an alias that cannot be resolved, a handler that traces outside the repository, a document that writes a range but has only one number captured. Substantive code = the first two tiers are excluded; it does not mean the thing the claim describes is really implemented. **Two further categories sit outside those three tiers and do not take part in the tiering**: isolated module = not referenced, not an entry point or a test, and not mentioned by any claim or idea; contract = paired by kind, listed with a note that only one side existing is not counted as a hole, and counted as a mismatch only when both sides exist and something references a name nobody declared. For Python routes, `APIRouter(prefix=)` and `include_router(..., prefix=)` are spliced into the path, including a single mount across files and nested mounts (at most 6 levels). Injection clues only mark locations and do not adjudicate
- Reference-type facts: what the document writes is not a number but a reference to something in the repository. `locator` captures the reference text, the measurable fact is whether it exists (1 or 0), and the document asserts 1. The "written in the document" column records the index of the reference text, so changing the reference to another target is seen as the document having moved:

| `type` | Condition for being true |
|---|---|
| `path-exists` | The captured path is a file or directory in the repository (an optional `base` serves as the relative directory) |
| `text-in-file` | The captured text appears in `file` |
| `json-has-key` | The captured name is a key of the object at `path` in `file` |

  Failure to capture text, an unreadable file, corrupt JSON, or a nonexistent `path` all count as "unmeasurable". Known limitation: when the document changes a reference to a new target, the fact also becomes "does the new target exist", and the closure is usually recorded as "both sides changed". A claim takes only the first match
- The measurable fact is measured independently at each commit and compared with the number in the document to obtain the true/false value at that commit. When the fact cannot be read, an empty value is returned and that commit is recorded as "unmeasurable"
- Claim definitions are validated when read: `id` is not duplicated, `locator` is a valid regex with at least one capture group, and the type and parameters of `fact` are valid. Error messages point to exactly which claim and which field
- At each commit, the body of every file that has ever appeared in `claims.json` is read; if a file cannot be read at that commit, it is recorded as an empty string (that is, the claim is "not written yet")
- Numeric claims, reference claims, and executed claims (whether tests pass, whether invariants hold, whether output changed) are supported. Natural language with no corresponding command (such as "this function behaves like...") is not supported

### Module import graph, ideas, and boundaries

Shares the same commit sequence as claims (`LOG_ARGS`), aligned by index, and reads only git objects.

- **Module import graph**: at each commit, take the code files (JS/TS/Python, excluding `node_modules`, `dist`, `vendor`, `.d.ts`, and minified files) and resolve imports; references that do not resolve to a file in the repository are dropped. Nodes and edges are both stored as runs of "which commit intervals they exist in", and adjacent commits whose code file set and `package.json` are both unchanged reuse the previous result. When there are more than 350 files, walk from the directory depth toward the shallow end to find the first merge granularity whose node count stays within the limit; imports inside the same group are not drawn. Test files are tagged and hidden by default in the UI.
- **Ideas and boundaries**: each entry in `.laminae/ideas.json` is `target` + a reference-type `fact` + `expect` (`present`/`absent`). The existence of the fact is computed commit by commit; agreement with `expect` is "satisfied" (idea: done; boundary: held), disagreement is "unsatisfied", and unreadability is "unmeasurable". For boundaries, `expect: absent` is the default. The fact can also be `import-edge` (two paths, `from` and `to`, with no `target`): commit by commit, check whether any file under `from` references a file under `to`; having such a reference is equivalent to "evidence exists". When no reference is found, if an unresolvable alias reference whose name carries `to` exists under `from`, or if `from` contains code in a language the import graph does not support, it is recorded as "unmeasurable" rather than "absent". "Regressed" means satisfied and then unsatisfied again; an "unmeasurable" in between does not count.
- **Clues**: `- [ ]`/`- [x]` checklists in a roadmap and TODO/FIXME are shown only as unconfirmed clues, with their count trends tracked, and take part in no determination.

---

## 2. Data model

Full types are in `src/types.ts`. Each claim produces one timeline:

| Field | Meaning |
|---|---|
| `id` / `label` | Identifier and display name |
| `file` / `line` | The file the claim lives in, and the line number at HEAD |
| `verbatim` | The verbatim source text at HEAD |
| `verbatimRuns` | How the source text changes across commits, run-length encoded, with the wording of a line stored only once |
| `states` | The true/false state, one cell per commit |
| `claimed` / `actual` | "The number written in the document" and "the number actually measured" at each commit |
| `runs` | List of false runs |
| `bornFalse` | Born false: false as soon as written, never true |
| `atHead` / `totalFalse` | The state at HEAD, and the cumulative number of false commits |

### States

| Value | Meaning |
|---|---|
| 0 | true |
| 1 | false |
| 2 | not written yet (the claim cannot be found in the document; shown on the page as "not written yet") |
| 3 | unmeasurable (the claim is in the document, but the corresponding fact cannot be measured) |

- "Not written yet" is stored separately from "false": a claim is not false before it is written down, it is simply not there yet.
- "Unmeasurable" is stored separately from "not written yet": the claim is plainly in the document, only the fact cannot be read (for example, the measured file is missing or corrupt at that commit). If the two were mixed together, the claim would vanish from the chart out of nowhere, and the "claim deleted" outcome could not be distinguished from it either.

The decision rule is `judgeState` in `src/classify.ts`.

### False runs

A consecutive interval of false commits is one false run (`Run`), recording the start and end commits, the length (in commits and in hours), whether it has still not ended at HEAD (right-censored), whether reality changed during the false run, and the outcome.

The window for "whether reality changed" starts from the cell before the false run (`didRealityMove`). A claim often turns false precisely because reality changed on the first cell of the run; looking only inside the run would miss that change.

### Outcomes

| Outcome | Meaning |
|---|---|
| `hanging-reality-still` | Still false at HEAD, reality never moved |
| `hanging-reality-moved` | Still false at HEAD, reality has already moved |
| `reality-caught-up` | Reality caught up with the claim |
| `doc-caught-up` | Reality moved first and the document was filled in later |
| `doc-corrected` | Reality did not move; the document was wrong from the start and was corrected later |
| `doc-removed` | After the false run the claim disappeared from the document (the claim was deleted or made vague) |
| `unmeasurable` | After the false run the fact cannot be measured, so how it closed cannot be determined |
| `both-changed` | The claim and the fact changed together on the same commit, so it cannot be determined |
| `anomaly` | Unexplained flip |

The outcome is decided by `classify` in `src/classify.ts`, in this order: still false at HEAD → claim disappeared → fact unmeasurable → reality caught up with the claim → both sides changed at once → document caught up with reality → document corrected.

Right-censored (`censored`) means the false run has still not ended at HEAD, or the fact cannot be measured afterwards and its end is unknown. A deleted claim is one definite ending and does not count as censoring.

### Summary

`Summary` contains: number of claims, number of commits, time span, number that were ever false, number still false at HEAD, number born false, number of false runs, number of right-censored runs, the survival estimate of hiatus (`survival`), the outcome distribution, and the closure-direction summary (`closure`).

#### Survival estimate of hiatus

False runs still hanging at HEAD are right-censored: all we know is that they have hung at least this long, and their true length will keep growing. If they are treated as "it ended right here" when taking the median, the result is systematically too small (for example, two runs hung for 5 and 6 commits respectively before ending, while three more just turned false 1 commit ago; the naive median is 1, yet those three runs have not ended). So the median hiatus uses the Kaplan-Meier estimate (`src/survival.ts`):

- Sample: false runs that were true first and became false afterwards. The born-false run does not enter the sample; what it measures is "how long the document was wrong from the very start", not "how long a genuinely true claim hung after drifting". Each run's `Run.bornFalse` marks it.
- Event: the false run actually ended (`censored` is false, including a deleted claim). Censoring: still false at HEAD, or the fact cannot be measured afterwards (`isCensored`, see `classify.ts`).
- When endings and censorings both occur at the same moment, the censored ones count as still at risk at that moment.
- The median is the earliest moment at which the survival probability drops below 0.5. When the curve stays above 0.5 throughout, it is `null`, meaning there is too much censoring to estimate, and no number is forced to fill the gap.
- Two medians are given, one in commits and one in hours. The sample size `n` is shown together with the number of censorings; with very few samples the median is very unstable.

Validation uses the textbook 6-MP example (see `test/survival.test.ts`).

#### Closure direction

`closure` splits the false runs that have closed by direction, over a base of all false runs (including the born-false one):

| Field | Meaning | Corresponding outcome |
|---|---|---|
| `docUpdated` | Disappeared by editing the document, with the claim still there | `doc-caught-up`, `doc-corrected` |
| `docRemoved` | Disappeared by deleting the claim | `doc-removed` |
| `realityFixed` | Disappeared by changing reality | `reality-caught-up` |
| `undetermined` | Closed, but the direction cannot be determined | `both-changed`, `unmeasurable`, `anomaly` |
| `pending` | Still hanging at HEAD | `hanging-*` |

`determinable` is `docUpdated + docRemoved + realityFixed`, and the percentages on the page use it as the denominator.

Both hiatus and outcomes are computed at build time; the front end only renders them.

---

## 3. Interface

The artifact is a single HTML file containing one state history chart: commits on the horizontal axis, claims on the vertical axis, and each cell being the true/false value at that commit. Cells are not merged with one another, and every cell can be opened to view the source text at that commit.

Clicking a cell opens a drawer; see `README.md` for its contents.

Below the state chart is the "false runs of each claim" list (`renderDetails` in `web/app.ts`), which tells each false run in two lines: the start (commit, commit subject, and the numbers the document and reality had when it turned false) and the end (commit, commit subject, closure method, duration). A false run still false at HEAD has no end commit; it is reworded as "still false at HEAD", with a note on whether reality moved during that time. The list follows the search and the preset views, and claims that never had a false run are only counted. `test/browser.test.ts` loads the generated page in a headless browser to check this rendering (skipped when Chrome or Edge is not found).

Implementation:

- One `div` per cell, laid out with CSS Grid, using neither SVG nor a charting library
- Crosshair highlighting and theme switching are implemented with CSS variables and attribute selectors
- Keyboard accessible: `role="gridcell"` plus `tabindex="0"`
- Single file, no external requests; image export is rendered with headless Chrome
- The browser-side script is precompiled into `dist/app.js` and committed, and `render.ts` inlines it together with `web/style.css` and the data. Running it in a target project therefore requires neither esbuild nor any installation; after changing anything in `web/` you must re-run `npm run build:web` and commit `dist/app.js`

---

## 4. Known limitations

The following behaviors are pinned by test/pipeline.test.ts:

- After the file a claim lives in is renamed or moved, the old path cannot be read and the claim is treated as disappeared (the state becomes "not written yet"; if it was in a false run at the time, the outcome is doc-removed). Renames are not tracked.
- When the fact file is missing or corrupt, the state at that commit is "unmeasurable" and is not treated as false.
