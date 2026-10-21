---
name: laminae
license: MIT
description: Checks whether two sides of a repository agree (a doc claim and a measurable fact, or two artifacts the user names), commit by commit when git history exists, and writes a self-contained HTML report. Do not replace the user's real question with a file-exists check. If the question cannot be measured, say so. Module graph and hollow-function checks only understand JS/TS and Python.
disable-model-invocation: true
---

# laminae

[中文](SKILL.md) | [English](SKILL.en.md)

Run it in the current project: first hear what the user wants checked, then find in the repository the two sides that should agree, check whether they agree, and generate the report at `.laminae/runs/<id>/laminae.html` (`.laminae/latest` holds the id of the most recent run). With no Markdown, use the contracts already written down in code, rules, and tests. With no git history, compare once against the current code only.

The import graph, import boundaries, hollow implementations, and "covered up" only understand JS/TS and Python. For Java, Go, Rust, and C#, only claims that do not read syntax can be verified (file counts, paths, text, JSON keys). Do not promise the user module relationships or implementation depth for these languages.

A run binds to exactly one repository: the git root of the current directory, or `LAMINAE_REPO`. That root must not be laminae itself; if it is, stop immediately and write no files. The scope is only this repository's mainline (`git log --first-parent`). Claims and ideas live in its `.laminae/`, the report lives in its root. Facts read only this repository's git objects; commands to run are executed only in its temporary worktree. Paths in claims must be relative paths inside the repository; `..` and absolute paths are not accepted.

Not part of this binding: other branches, other repositories, the tool's own directory, files outside the repository. Whether a formula computes correctly is also outside the scope of "counting the repository", unless it is written as a test, an invariant, or an output diff. The skill itself contains no path, number, or filename of any specific project.

## Process

1. First write down in one sentence the thing the user really wants checked. Whether a fee is calculated correctly, whether an interface is wired up, whether some piece of logic is empty — all of these count. Do not rewrite it as "whether some file exists".
2. Find the two sides in the repository. One side is the assertion, the other a measurable fact. **Check [docs/PATTERNS.md](docs/PATTERNS.en.md) first**: a real document has only so many claim patterns, and which fact can measure each one, and when it cannot be measured, is written there, so do not work it out from scratch every time. What you check must be something that, if wrong, would make people do the wrong thing. For formulas, conventions of calculation, and totals, the oracle is not in the shape of the files: use `test-passes` (does this test pass), `invariant-holds` (does this property hold), or `output-unchanged` (the document says it should not change; did the output change). Counting files, matching paths, and matching JSON keys answer only "does it exist", and must not be used in place of the questions above. With no documents, use code and tests. If no runnable oracle can be found, stop and tell the user "this question cannot be checked accurately", and list the files you read. Using a single `path-exists` or `text-in-file` as a substitute is forbidden.
3. Only after the user confirms, write the measurable ones into `.laminae/claims.json`. Before writing, look the content up with commands; do not read files or JSON into context. When writing, state what this run does not cover.
4. Run it in the directory to verify (it must be a git repository; if there is no commit history, first state that only the current files can be looked at, and do not invent a timeline):

   ```bash
   node <skill dir>/scripts/run.ts
   ```

5. The report is at `.laminae/runs/<id>/laminae.html`; read `.laminae/latest` first to get the id. Tell the user three things, without mixing them together:
   - **Confirmed disagreement**: the declaration and the measured fact do not match; the report holds the values and locations of both sides.
   - **Cannot verify**: the tool did not catch up (route decorators could not be connected, the language is not recognised, aliases could not be resolved). This is not a defect list.
   - **Needs human review**: empty functions, pure re-exports, referenced only by tests. These are only signs, and cannot be taken as business errors already caught.

It needs git, and a Node that can run `.ts` files directly. The target project does not need dependencies installed. When it reports "node not found / cannot run .ts", check the environment first:

```bash
powershell -File <skill dir>/scripts/setup.ps1   # Windows
bash <skill dir>/scripts/setup.sh                # macOS / Linux
```

By default it only checks and prints the install commands for what is missing, without changing the system. Add `-Install` (`--install` for `setup.sh`) only after the user agrees, and do not install anything on your own initiative.

## Choosing claims

Pick only claims that have real meaning for readers and that would mislead people if the number were wrong, usually no more than ten or twenty. For every extra trivial claim, the report gains one more row of green cells that carry no information.

- Check on HEAD first; do not fill in JSON from memory. For whether that sentence is present in the documents, use `git grep -n -E '<wording>' -- '<file>'`. For a draft, first run `node <skill dir>/src/lookup.ts draft.json`: it prints the text each claim captured, and the number the fact measures now (JSON lengths, keys, and values are also looked up by it). If they do not match, change `locator` or `fact`; do not put it in directly.
- `locator` matches only wording that actually exists in the document. If the wording has changed, use a regex that covers both the old and the new phrasing.
- Pick only claims that can be measured with the fact types below; do not force in ones that cannot be measured.

You can first run `node <skill dir>/src/suggest.ts` in the target repository. It uses `git grep` to fish out sentences in Markdown of the kinds "1600+", "about 2000", "pnpm run …", "12 in total", prints JSON, writes no files, and does not read the whole document into context. The `fact` is mostly a placeholder; change it to the thing that should really be counted in this repository, check it against lookup, and then put it into `claims.json`.

## claims.json

An array, each element:

| Field | Required | Meaning |
|---|---|---|
| `id` | Yes | Unique identifier |
| `file` | Yes | File the claim is in, relative to the repository root |
| `locator` | Yes | Locating regex; capture group 1 is the number written in the document (for reference-type claims, the referenced text) |
| `fact` | Yes | The measurable fact, see below |
| `label` | No | Display name in the UI; defaults to `id` |
| `impact` | No | `"high"`, `"normal"` (default), `"low"`. Mark claims that would make people do the wrong thing if misread as `high` (e.g. install commands, critical paths). Used only for sorting and labels, and takes part in no statistics |
| `compare` | No | How the number written in the document is compared with the fact: `"eq"` (default, strict equality), `"gte"` (fact ≥ the document's number; the document writes "1600+" or "at least 10 items"), `"lte"` (fact ≤ the document's number, "at most 50"), `"approx"` (difference no more than `tolerance`, "about 2000"). Only for numeric facts |
| `tolerance` | No | Only for `approx`: relative error, between 0 and 1, default `0.05` (difference no more than 5%) |

```json
[
  {
    "id": "levels",
    "label": "README：关卡数",
    "file": "README.md",
    "locator": "共 (\\d+) 关",
    "fact": { "type": "json-length", "file": "data/levels.json", "path": "levels" }
  }
]
```

The number in a document is not necessarily an exact value. When you see wording like "1600+", "at least", "more than", "about", "at most", do not use the default strict equality, or a document that is not wrong will still be judged false:

```json
{
  "id": "icon-count",
  "file": "README.md",
  "locator": "provides (\\d+)\\+ vector",
  "fact": { "type": "count-files", "glob": "icons/*.svg" },
  "compare": "gte"
}
```

There is a fallback if you forget: claims whose wording looks like a lower bound or an approximation but which are compared with strict equality are listed in the terminal summary, and the page drawer hints at them as well, but the verdict is not changed automatically; you confirm it.

`compare` compares only direction and does not look at whether the document is conservative: when the README writes "1000+" and the actual value is 1539, it is still true under `gte`. "Written too stale" is exposed only by an exact value or by `approx`. A range ("1600–1800 of them") cannot capture two numbers; split it into two claims, one taking each end, `gte` for the lower bound and `lte` for the upper bound.

## Fact types

| `type` | Parameters | Measured number |
|---|---|---|
| `count-files` | `glob` | Number of files matching the glob. `*` does not cross directories, `**` does, `?` matches a single character |
| `json-length` | `file`, `path` (optional) | Length of an array in JSON, or the number of keys of an object. `path` is dot-separated, and may be omitted when the root node is an array |
| `json-number` | `file`, `path` | A numeric field in JSON |
| `regex-count` | `file`, `pattern`, `flags` (optional) | Number of matches of the regex in the file |
| `line-count` | `file` | Number of lines in the file |
| `file-bytes` | `file` | Number of bytes in the file |

These facts are measured independently on every commit, reading only git objects. When a fact cannot be read (file missing, JSON corrupt, path does not exist), that commit is recorded as "unmeasurable" and is not treated as false. They answer "does it exist", and cannot answer "is it calculated correctly".

### Only running reveals it

The oracle is brought into the repository by a test, an invariant, or a piece of output. laminae does not understand formulas; it only records each commit's result as a sequence, working out from which cell it first goes wrong, how long it hangs, and whether in the end the code was changed or the claim was changed.

Commands are executed with a shell in a temporary worktree and do not change the main working tree. Do not write commands that would change the system or delete data. `watch` lists the files the command really reads (glob); once those files have not changed, it is not run again. With no `watch`, it runs on every commit. `timeout` is in seconds, default 60.

| `type` | Parameters | Condition for true | How to read the outcome |
|---|---|---|---|
| `test-passes` | `command`, `watch` (optional), `timeout` (optional), `source` (optional) | Exit code 0. The claim's `file` should point at the test file, and `locator` captures the test name or the expectation in the assertion | The test file's body did not change and the result went from failing to passing: the code under test was changed (reality caught up with the claim). The body and the result change together in the same cell: the assertion was changed, or both sides were changed (both sides changed) |
| `invariant-holds` | Same as `test-passes` | Exit code 0, meaning the property holds | Same as tests. `source` defaults to the file the claim is in |
| `output-unchanged` | `command`, `watch` (optional), `timeout` (optional) | Standard output is the same as "when this captured text first appeared". If the captured text changes (for example the convention goes from v1 to v2), the baseline is reset with it | The output changes and changes back while the sentence stays the same: reality caught up with the claim. The sentence and the output change together in the same cell: both sides changed. Whether the output is right is not judged, only whether it changed |

```json
{
  "id": "fee",
  "label": "酬金计算",
  "file": "tests/test_fee.py",
  "locator": "def (test_fee_calc)\\b",
  "fact": {
    "type": "test-passes",
    "command": "python -m pytest tests/test_fee.py::test_fee_calc -q",
    "watch": ["tests/test_fee.py", "fee.py"]
  }
}
```

Failing to start or timing out is recorded as "unmeasurable", not as a failure. A non-zero exit code is recorded as a failure. On a non-zero exit, `output-unchanged` treats this output as "changed" rather than unmeasurable.

### Reference type: the document writes a reference to something in the repository, not a number

Capture group 1 of `locator` is the referenced text (a path, a command name, …), and the fact is whether it exists. Good for verifying stale paths, commands, and configuration entries.

| `type` | Parameters | Condition for true |
|---|---|---|
| `path-exists` | `base` (optional) | The captured path is a file or directory in the repository; with `base`, relative to that directory |
| `text-in-file` | `file` | The captured text appears in that file |
| `json-has-key` | `file`, `path` (optional) | The captured name is a key of some object in that JSON, e.g. whether `scripts` in `package.json` has the `xxx` of `npm run xxx` |

```json
{
  "id": "build-cmd",
  "file": "README.md",
  "locator": "npm run (\\w+)",
  "fact": { "type": "json-has-key", "file": "package.json", "path": "scripts" }
}
```

Notes:
- A claim takes only the first match. If the document references several paths, write one claim for each, telling them apart with a more specific `locator`.
- When the document changes a reference to another target, the fact becomes "does the new target exist" along with it, and the closure of that false run is recorded as "both sides changed", so there is no telling which moved first.

## Module import graph (automatic, no configuration needed)

During a run, import references between modules (JS/TS and Python) are also extracted for every commit; on the page you can drag the time slider to see the structure at a given moment, or pick two points in time to compare the modules and references that appeared and disappeared. Clicking a node shows what it references, what references it, and which claims and ideas it is connected to. Module level only, no function calls; when there are no recognisable code files, this section is not generated.

## Where the layers do not reconcile (automatic, no configuration needed)

Each layer on its own may hold; only stacked together do the holes become visible. This section does the following automatically, with nothing to write in claims.json:

- **Hollow implementation**: the claim is true, or the idea is done, but the file it points at is structurally empty: an empty file, one that says `not implemented` / `未实现`, or a function body that is empty and only `return null` / `[]` / `{}` / a constant. It cannot tell that a computation is wrong. When a route path matches, the handler is looked at as well; an empty one still counts as a hollow implementation, and one more level is traced along relative imports. `APIRouter(prefix=)` and `include_router(..., prefix=)` are joined onto the decorator path.
- **Covered up**: the file is only `export { x } from "./another-file"`; the module is referenced only by tests; the document holds only under a comparison such as "at least" or "no more than", and the actual value differs noticeably from the number written; an alias cannot be resolved, so there is no way to see whether it was bypassed.
- **Has substantive code**: the two categories above are excluded. This is not "really implemented"; the tool cannot see whether this code is doing the thing the claim says.
- **Isolated module**: the code file is not referenced by any code, is not an entry point (`index`, `main`, `bin`, `cmd`), and no claim or idea mentions it.
- **Contract**: pair up "things declared" and "things referenced" in the repository by kind. Currently only HTTP paths are recognised (`app.get("/x")`, `@app.route("/x")`, `@router.get("/x")` against `fetch("/x")`, `axios.get("/x")`). Python routes get the `APIRouter` and `include_router` prefixes joined on.

It does not presuppose that a project has a frontend or a backend. Missing either side is a normal project shape (pure library, pure frontend, pure backend); it only records "this side does not exist", and that is not a hole. Only when both sides exist and something somewhere references a name that nobody declared does it count as a mismatch. A pure library has no routes and is covered by entry points and isolated modules.

It also marks the locations of the injection leads (`eval`, `new Function`, `child_process`, `innerHTML`, `dangerouslySetInnerHTML`). These are only leads; whether they can be exploited is not judged.

## ideas.json (optional): ideas and boundaries

The things to be done and the lines that must not be crossed are declared by the user, still using reference-type facts, except that the "referenced text" is written directly in `target`. The file lives at `.laminae/ideas.json` (the path can be overridden with `LAMINAE_IDEAS`); if it does not exist, skip it.

| Field | Required | Meaning |
|---|---|---|
| `id`, `text` | Yes | Unique identifier, description shown in the UI |
| `target` | Yes (not used by `import-edge`) | The path, command name, or text being checked |
| `fact` | Yes | A reference-type fact (`path-exists`, `text-in-file`, `json-has-key`), or the module reference `import-edge` (see below) |
| `expect` | No | `"present"` or `"absent"`. For an idea the default is `present`; for a boundary it is `absent` |
| `boundary` | No | `true` means a boundary: met is "held", not met is "crossed" |
| `source` | No | Where this idea comes from, e.g. "ROADMAP.md line 12" |

Status: an idea is "done / not done", a boundary is "held / crossed"; evidence that cannot be read is recorded as "unmeasurable" and is not treated as a regression. The direction and the evidence must be decided by a human; the tool will not guess for you.

One example of each of the four forms:

```json
[
  {
    "id": "export-pdf",
    "text": "支持导出 PDF",
    "target": "src/export-pdf.ts",
    "fact": { "type": "path-exists" },
    "source": "ROADMAP.md 第 12 行"
  },
  {
    "id": "no-network",
    "text": "边界：运行时不联网，不引入 http 客户端",
    "target": "node-fetch",
    "fact": { "type": "json-has-key", "file": "package.json", "path": "dependencies" },
    "boundary": true
  },
  {
    "id": "old-parser-removed",
    "text": "旧解析器要删掉",
    "target": "src/old-parser.ts",
    "fact": { "type": "path-exists" },
    "expect": "absent"
  }
]
```

### Import boundary: `import-edge`

For a boundary such as "the frontend must not import the backend", write it as whether a file under `from` imports a file under `to`; `target` is not needed:

```json
{
  "id": "ui-not-server",
  "text": "边界：前端不许引用后端",
  "fact": { "type": "import-edge", "from": "src/ui", "to": "src/server" },
  "boundary": true
}
```

`from` and `to` are a directory or a single file, matched on whole path segments (`src/ui` does not include `src/ui2`). A boundary defaults to `expect: "absent"`: no such reference is "held", any is "crossed"; the page lists the references that crossed, and can mark them red on the import graph. Written as an idea (`expect: "present"`, e.g. "A must be wired to B"), it is the opposite.

When it cannot be measured, it does not pretend the boundary held:

- If under `from` there is an alias reference that cannot be resolved (such as `@/server/db`, `~/server`, `src/server/db`) and its form carries the name of `to`, then the conclusion is "unmeasurable", and which reference in which file is written out.
- If there is not a single JS/TS/Python file under `from` (for example everything is Go), the import graph does not support it, and it is likewise "unmeasurable".
- If a definite crossing reference is found, the conclusion is definite and is not affected by the above.

References that can be resolved: relative paths, and internal packages in a monorepo (`@acme/server` pointing at `packages/server`). tsconfig/webpack alias configuration is not read.

The `- [ ]` checklists in a roadmap and the TODO/FIXME in code are listed separately as "leads" and a count trend is drawn for them, but they are only leads: a tick does not mean it was really done, and they do not become ideas automatically.

## Impact on the target project

- Repository-counting facts read only git objects; nothing is checked out, no tracked file is modified, and the project's own `.gitignore` is not touched. `test-passes`, `invariant-holds`, and `output-unchanged` run the commands you wrote in a temporary worktree and do not modify the main working tree.
- Generated artifacts land in `.laminae/data/`, `.laminae/runs/<id>/`, and `.laminae/latest`; a run registers them in `.git/info/exclude` automatically, so they do not appear in `git status`. `.laminae/claims.json` is the user's input and is not ignored.
- By default the terminal prints only a compact summary, whose line count does not grow with the number of commits. When you need the full per-commit timeline, add `--verbose`, or read `.laminae/data/timeline.json`.

Environment variables, error handling, and the meaning of each field of the result are in [docs/REFERENCE.md](docs/REFERENCE.en.md); read it when you need it.
