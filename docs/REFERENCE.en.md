# laminae Reference

[中文](REFERENCE.md) | [English](REFERENCE.en.md)

Details not expanded in `SKILL.md`. For the data model and decision rules see [SPEC.md](SPEC.en.md); when choosing claims consult [PATTERNS.md](PATTERNS.en.md); third parties and provenance are in [../THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.en.md).

## Environment variables

All are optional.

| Variable | Purpose |
|---|---|
| `LAMINAE_REPO` | Target repository path; defaults to the root of the repository that contains the current directory. When the parent directory is not a repository, the sub-repositories beneath it are listed |
| `LAMINAE_REPO_URL` | Web page address, used for the “go verify” link; defaults to the `origin` remote |
| `LAMINAE_CLAIMS` | Path to the claim definition file; defaults to `<repo>/.laminae/claims.json` |
| `LAMINAE_IDEAS` | Path to the ideas and boundaries definition file; defaults to `<repo>/.laminae/ideas.json`, skipped when the file does not exist |
| `LAMINAE_DATA` | Intermediate data directory; defaults to `<repo>/.laminae/data` |
| `LAMINAE_HTML` | Report path; defaults to `<repo>/.laminae/runs/<id>/laminae.html` |
| `LAMINAE_RUN` | Run id. A concrete name uses that run; `new` starts a new one; unset continues the run that `.laminae/latest` points to |
| `LAMINAE_REPOS` | Comma-separated repository list, equivalent to `--repos` |
| `LAMINAE_JOBS` | Concurrency, equivalent to `--jobs` |
| `LAMINAE_VERBOSE` | Set to `1` for the equivalent of `--verbose` |
| `LAMINAE_NO_EXCLUDE` | Set to `1` to skip writing generated artifacts into `.git/info/exclude` |

## Command-line arguments

These are consumed by `scripts/run.ts` and are not passed on to the individual steps.

| Argument | Purpose |
|---|---|
| `--repo <path>` | Specify a single repository |
| `--repos a,b,c` | Specify multiple repositories |
| `--all` | When the current directory is not a repository, run every repository found beneath it |
| `--run <id>` | The id of this run. A readable name is easier to recognize than a timestamp |
| `--new-run` | Start a separate run when running step by step by hand, instead of continuing from `latest` |
| `--jobs <N>` | Concurrency. Defaults to the smaller of the CPU count and the repository count; forced to 1 when there are claims that need to execute commands |
| `--allow-parallel-commands` | Force parallelism even when there are commands such as `test-passes` |
| `data` | Run only through step 5, without rendering HTML |
| `--verbose` | Print the full per-commit timeline |

## Output

| Location | Contents |
|---|---|
| `.laminae/runs/<id>/laminae.html` | The report; a single file with data, styles and scripts all inlined, no external requests |
| `.laminae/runs/<id>/payload.json` | Full data. Enough to re-render; two copies can be diffed by hand, the tool has no comparison command yet |
| `.laminae/latest` | The id of the most recent run |
| `.laminae/data/` | Intermediate data, one shared copy, overwritten every time, safe to delete |
| `.laminae/data/graph.json` | Module import graph: in which commit ranges nodes and edges exist. Above 350 files, files are merged into nodes by directory; test files are tagged and hidden by default |
| `.laminae/data/ideas-timeline.json` | Per-commit status of each idea/boundary, first satisfaction, and number of regressions; `import-edge` additionally carries the references matched at HEAD (at most 30, `hits`/`hitsTotal`) and the reason it could not be decided (`unsure`) |
| `.laminae/data/candidates.json` | The roadmap inventory and TODO leads, plus the count trend across about 40 sampling points |

### Artifacts with multiple repositories

The parent directory (the level that is not a repository but has repositories beneath it) gains:

| Location | Contents |
|---|---|
| `<parent dir>/.laminae/runs/<id>/index.html` | Index page: one row per repository, plus the longest-standing false run across all repositories |
| `<parent dir>/.laminae/repos.json` | Optional. The repository list; write it here and you no longer need to pass `--repos` every time |

### Run ids and keeping a copy

- The default id is a local timestamp `20261020T031422`; a collision within the same second gets a sequence number, and existing directories are never overwritten.
- The id may contain only letters, digits, dots, underscores and hyphens, and must not contain path separators or `..`. It comes from `claims.json` and the command line; without blocking it, artifacts could be written outside the repository.
- Running the same `--run` name a second time overwrites that run, and prints a notice beforehand. If two people each want to keep a copy, use a different name.
- When running step by step by hand without `LAMINAE_RUN`, it continues the run that `.laminae/latest` points to, so all six steps land in the same directory. To start a separate run, use `--new-run`.
- Only `payload.json` and `laminae.html` are kept; the intermediate data is one shared copy. For a repository with hundreds of commits, copying `docs-by-commit.json` on every run would fill up the disk.
- The cost: scratch files such as `facts.json` and `timeline.json` are overwritten on every run. After changing the decision rules, re-running the analysis against the old data is not possible; only a full re-run.
- “Two reports were kept” does not by itself produce a conclusion. To compare the difference between two invocations you have to diff the two `payload.json` files yourself; the tool has no such command.

### Limits of numeric claims

- One claim captures only one number in the docs. A range has to be split into two claims (lower bound `gte`, upper bound `lte`).
- `compare` only compares direction. `gte` will not point out that “the lower bound written in the docs is already too conservative” (the README says “1000+” while 1539 is still true); such staleness can only surface through an exact value or `approx`.
- The “wording looks like a lower bound / approximation” hint is guessed by literal rules (`N+`, 约, 至少, 超过, at least, more than, etc.), so it may miss cases and may over-report; it only hints and never changes the verdict.
- The commit sequence follows only the `--first-parent` mainline: in repositories with many merge commits the sequence is shorter than `git rev-list --count` (for example lucide's mainline has 2562, all commits about 3000).
- It also runs on a blobless / partial clone, but every unseen file version has to be fetched over the network, so measuring a long-history repository is much slower (lucide's 2562 commits take about 6 minutes); the import graph step reads every code file and is slower still, so a full clone is recommended.

### Facts produced by a run

- The commands for `test-passes`, `invariant-holds` and `output-unchanged` are executed by the shell in a temporary worktree, with the same permissions as the person running laminae, and do not modify the main working tree.
- Without `watch`, every commit is run. With a long history you must list the files the command actually reads; if the contents did not change, the previous result is reused.
- The outcome compares only the cell after the false run ends with the last cell of the false run. A test file changed in the middle of the false run and not changed again in the ending cell is not recorded separately as “assertions changed”.
- The layer reconciliation section still does not execute code. A function written out in full such as `return b * r * 1.2` still counts there as “has substantive code”.

### Limits of layer reconciliation

- A hollow implementation is recognized only when: after comments are removed there is no code; the whole file has no other implementation and says only `not implemented`, `NotImplementedError`, `未实现`, `unimplemented!()`, `todo!()`; the function body is empty, or only `return`s an empty value, a boolean or a number (including `return 1`). When the file already contains another implementation, a lone `NotImplementedError` does not make the whole file a hollow implementation. Empty methods inside a class and syntax it cannot make sense of still count as “has substantive code”. This is still not a check of “whether this code is doing the thing the claim says”.
- Having substantive code is not “actually implemented”. This section does not execute code and does not know whether the formula is right. The numbers it computes have to be checked with `test-passes`, `invariant-holds` or `output-unchanged`.
- A pure re-export is recognized only when the whole file is `export … from` or Python relative imports. Re-exports are followed only two hops further.
- Wording covers up the gap: it is recorded only when `compare` is `gte` or `lte` and holds, the relative gap is at least 15%, and the absolute gap is at least 2. “5 in total, 6 actually” differs by only 1, so it is not recorded; “1600, 1899 actually” satisfies both, so it is recorded. These two numbers are set by hand, not estimated from false-positive samples.
- An isolated module treats files under `index`, `main`, `cli`, `app`, `server`, `mod`, `__init__`, `__main__` and `bin/`, `cmd/` as entry points and does not count them as isolated. Files referenced by tests do not count either.
- A file with no import edge whose **file name appears as a literal in the body of some other file** is recorded as "loaded by convention" and is not treated as isolated. The reason is that three kinds of thing have no edge at all in a static graph: scripts that `package.json` `scripts` invoke by path, assets that pages pull in with `<script src>`, and paths assembled from template strings (``` `renderers/${type}/render-${type}.mjs` ```). Names shorter than five characters do not count, otherwise names like `index.js` would blanket-suppress genuine isolation. A mention inside a test file counts too.
  - **A file with entry-point evidence is not isolated, and the reason is reported with it.** This rule was added after a real repository: click reported 15 isolated modules and all 15 were wrong — 12 under `examples/` (sample scripts you run), 2 under `docs/` (configuration that Sphinx loads), and one `src/click/testing.py` (a public module of the library, imported by its users). Only four kinds of evidence are accepted, and every one of them is written down in the repository: directory role (`examples/`, `docs/`, `scripts/`, `bin/`, `tools/` and similar), Python package membership (an `__init__.py` beside it), a manifest declaration (`bin`/`main` in `package.json`, entry points in `pyproject.toml`, `path` in `Cargo.toml`), or a `#!` first line. None of them depends on what the file name looks like.
  - Why this matters: **in a library, "this module has no internal importer" usually means it is an exit, not an entrance.** Reading a structural fact as a defect is the easiest mistake in this tier.
- The cost of this rule has to be stated: **it only proves that something referred to the name, not that the code can actually be reached.** A typo in a name, or a reference to a file that was deleted, both look like use.
- Contracts currently cover only HTTP paths. Route declarations recognize `.get("/x")` on `app` / `router`-style objects and Python's `@router.get("/x")`, `@app.route("/x")`; references recognize `fetch("/x")` and `axios.get("/x")`. `APIRouter(prefix="/users")` and `include_router(router, prefix="/api/v1")` are joined into `/api/v1/users/...`, and cross-file mounting such as `from users import router` is joined too. Paths with variables (`` `/api/${id}` ``) do not match and are skipped outright.
- When a repository has no route declarations at all, `fetch` calls are not judged as holes: it is impossible to tell whether they call an external service or whether this repository has not implemented it. Conversely, declarations with no calls are not judged either, since the caller may live outside the repository.
- Injection leads recognize `eval(`, `new Function(`, `child_process`, `.innerHTML`, `dangerouslySetInnerHTML`, `os.system(`, `subprocess`, `document.write(`. Their presence does not mean they are exploitable; the page marks them as leads.
- Function calls: **intra-file** calls count too (tagged `local`, no import lookup needed), and call sites **anywhere** in the body count, no longer only bodies that are a single call (previously one extra `if` or `await` broke the whole chain). The callee must come from a relative import (`./`, `../`, Python's `.`). Tracing outward from an already-flagged function goes at most 4 hops, and each result records `hops`, which the report turns into confidence — **1 hop is seen directly, 4 hops is inferred**. Third-party packages are not followed. The line number is the definition line.

### Limits of the module import graph

- Module-level imports only, for JS/TS (`import`, `require`, dynamic `import()`, `export … from`) and Python (`import`, `from … import`). Java, Go, C# and other languages are not recognized (see [LANGUAGES.md](LANGUAGES.en.md) for how extensions work). Rust has had a syntax module since 0.2: files whose extension is not among `.js` / `.ts` / `.jsx` / `.tsx` / `.mjs` / `.cjs` / `.py` are not treated as code.
- There is no function-level call graph.
- Python's multi-line `from x import (\n a,\n b)` reads only the names on the first line.
- Text that looks like an import inside comments or strings may produce spurious edges.
- Alias paths (tsconfig paths, webpack alias) are not resolved, so such references are not drawn. Internal packages in a monorepo (`@acme/x`, identified by the `name` of a non-root `package.json`) are resolved and drawn.
- Alias references that cannot be resolved do not enter the graph, but the `import-edge` boundary uses them to decide “unmeasurable”. For Python, this step is not performed when an absolute import cannot be resolved; only imports that resolve to a file inside the repository are recognized.
- `import-edge` recognizes only references between code files, at module level; `from` / `to` match by whole path segments.
- The direction and evidence of ideas are declared by humans; the checked state of the roadmap inventory is only a lead.

## When something goes wrong

| Error | Handling |
|---|---|
| Not inside a git repository | Change into the project directory and run again, or set `LAMINAE_REPO`. When there are several repositories under the parent directory, the message lists them and gives the command |
| This is laminae's own repository | Run it from the project directory you want to verify. The tool does not verify itself |
| A path points outside the repository | Change `file`, `base`, `source`, and the `from` / `to` of the import boundary, to relative paths inside the repository |
| The `--run` name is invalid | Use a name made of letters, digits, dots, underscores and hyphens; it must not contain path separators |
| `找不到说法定义文件` | Write `.laminae/claims.json` first. With multiple repositories, each repository needs its own |
| A field of `claims[N]` is invalid | The error message points out which entry and which field; change it as suggested |
| Measurement data out of sync with claims.json | Re-run `run.ts` after changing `claims.json` |
| One repository fails with multiple repositories | The rest still run to completion, and the overall exit code is non-zero. Re-run that one alone with `--repo` |

## When the rule itself is wrong

Two hints, neither of which changes the verdict — they only point at what looks suspicious:

- **Rule never matched**: a claim's `locator` matched nothing anywhere in the history. The state shows "not written yet", but the cause may be that the document never said it, or that the regex is wrong. The tool cannot tell these apart, so it adds a separate badge and points at `lookup` to show what the locator actually captured.
- **Capture suspect**: a reference claim is false, but after trimming leading and trailing punctuation (backticks, quotes, brackets, commas, full stops, colons) from the captured text, a file of that name does exist at HEAD. That is almost always a capture group that swallowed an extra character — for example a backtick written inside the parentheses, which captures the path plus a trailing backtick.

**Both of these make the tool accuse the wrong thing.** A check that accuses wrongly is worse than no check: people stop believing the red. So each has its own badge and neither is folded into "false".

## How to read the results

What each of the five commands answers, and how src should be grouped, is in [LAYOUT.md](LAYOUT.en.md).


At each commit every claim has one of four states: true, false, not written yet (gray), unmeasurable. A consecutive stretch of false is a false run, whose length is the hiatus, and it is classified by closure method. The meaning of each outcome is in [SPEC.md](SPEC.en.md).
