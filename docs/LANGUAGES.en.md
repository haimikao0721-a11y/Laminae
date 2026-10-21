# Multi-language support

[中文](LANGUAGES.md) | [English](LANGUAGES.en.md)

Only JS/TS and Python are recognised today. This document covers three things: why the project should not be rewritten in another language, how to turn language support from "write code" into "fill in data", and which steps are worth speeding up with shell.

## Current state

`src/lang.ts` sorts files into three classes by extension:

| Class | Extensions | What happens |
|---|---|---|
| Supported syntax module | `.js .ts .jsx .tsx .mjs .cjs .mts .cts`, `.py`, `.rs` | Imports parsed, graph built, hollow implementations and routes detected |
| Recognised, no syntax module | `.java .go .cs .c .cc .cpp .h .hpp .kt .kts .swift .rb .php .scala .m .mm` | Listed under "syntax not supported yet"; no graph edges, no hollow-implementation checks |
| Not treated as code | everything else | Ignored entirely |

**That split is deliberate.** Recognising an extension and then guessing at the structure produces fake reference edges and fake hollow-implementation findings — worse than not judging at all.

Document claims (counts, paths, whether some text is present, whether a JSON key exists) do not depend on syntax, so they work in a repository in any language. **Only the import graph and layer reconciliation are language-bound.**

## Should this be rewritten in Python

The conclusion: **exactly one place is worth it, and the rest is not.**

### The one place worth it

`parsePython` in `src/imports.ts` is a line-by-line regex:

```ts
function parsePython(line: string): RawImport[] | null {
  const t = line.replace(/#.*$/, "").trim();
  let m = t.match(/^from\s+(\.*[A-Za-z_][\w.]*|\.+)\s+import\s+(.+)$/);
```

**It is called per line, so a multi-line import cannot be parsed correctly by construction.** That is exactly the limitation recorded in `REFERENCE.md`: "Python's multi-line `from x import (\n a,\n b)` only reads the names on the first line".

Switching that to Python's `ast` module would fix a whole cluster at once:

| Not parseable today | Why `ast` can |
|---|---|
| Multi-line imports | It reads a syntax tree, not lines |
| Re-exports in `__init__.py` | It sees the actual bindings and `__all__` |
| The level of a relative import | The `level` field is right there |
| Conditional imports | Node kinds can be distinguished |
| Decorator routes | The decorator list comes out directly |
| `def f(): pass` versus `def f(): return None` | No longer a string comparison |

That is roughly 100 to 150 lines, but it is load-bearing.

### The parts not worth it

| Part | Lines | Why leave it |
|---|---|---|
| `web/` (browser side and styles) | 3299 | Must compile to JS and be inlined into the HTML; none of it can move |
| `render` / `build-data` / `indexhtml` | 917 | Template assembly; changing language buys nothing |
| `facts` / `claims` / `classify` / `survival` / `compare` / `accuracy` | 1042 | Pure logic |
| `gitutil` / `paths` / `config` / `repos` / `runid` / `exclude` | 705 | Equivalent either way |
| `observe` | 181 | Spawns processes and reads exit codes; either language does it |
| The JS/TS parsing | about 400 | Python has no mature TS parser; moving it there would only make it worse |

A wholesale language change also adds a second runtime. "You need Node, and the target project installs nothing" is the property that lets this be picked up as a skill without ceremony.

**So: no rewrite. If anything moves, it is an optional Python sidecar.**

## Extending to more languages: syntax modules as data, not code

Adding a language today means writing TypeScript: a `parseX`, a `resolveX`, and another branch inside layer reconciliation. **That is why there are only two languages.**

**The first layer is done: detection now lives in one place.** It used to be spread across three call sites as inline ternaries (`findPythonFunctions(text).length > 0 && !/(?:function\s*\(|=>)/`); now only `pickModule` decides which language a piece of text is written in, and everything else asks a module.

| File | What goes there |
|---|---|
| `src/syntax.ts` | the interface and the shared parts (bracket matching, string skipping, body emptiness, handler classification) |
| `src/syntax-js.ts` | JS/TS: brace-delimited bodies, `import … from`, `app.get("/x")`, NestJS `@Get("/x")` |
| `src/syntax-py.ts` | Python: indentation-delimited bodies, `from … import`, `@router.get("/x")`, `APIRouter(prefix=)`, `include_router` |
| `src/syntax-registry.ts` | the lookup. `pickModule` is the only place that decides which language a piece of text is written in |

There is one deliberate asymmetry in the split:

- **Function finding asks only the module that was recognised**
- **Route and import parsing asks every module and merges the results**

The second is not laziness. A file containing only `app = FastAPI()` and `include_router` has no `def` in it and so is not recognised as Python, yet it really is doing a mount; asking only the recognised module would lose the prefix.

**The second layer is not done yet**: the modules' contents are still written in TypeScript. The next step is moving those regexes into JSON so the engine becomes generic.

Made declarative, adding a language means filling a few regexes into JSON:

```json
{
  "id": "java",
  "label": "Java",
  "ext": [".java"],
  "skip": ["/test/", "/build/"],
  "imports": [
    { "re": "^\\s*import\\s+(?:static\\s+)?([\\w.]+?)(?:\\.\\*)?\\s*;", "spec": 1 }
  ],
  "definitions": [
    { "re": "^\\s*(?:(?:public|private|protected|static|final|abstract|synchronized)\\s+)*[\\w<>\\[\\],.]+?\\s+(\\w{2,})\\s*\\(", "name": 1 }
  ],
  "hollow": [
    { "re": "throw\\s+new\\s+UnsupportedOperationException\\s*\\(", "reason": "unimplemented" },
    { "re": "^\\s*\\{\\s*\\}\\s*$", "reason": "empty-body" }
  ],
  "routes": [
    { "re": "@(Get|Post|Put|Delete|Patch)Mapping\\s*\\(\\s*\"([^\"]+)\"", "style": "annotation" }
  ]
}
```

The engine is generic: read the target repository's files, pick the module by extension, extract with the module's regexes, and hand the result to the existing graph and layer logic. **One JSON per language, no code.**

Two side effects worth having:

- **Patterns can be measured.** Whether a regex is right no longer requires running the whole history to find out; one `git grep` gives the number (next section).
- **Patterns can be reviewed.** A regex sitting in JSON can be read by a human; scattered across TypeScript branches, it can only be read by reading code.

## What shell can speed up

### Yes: locating, counting, validating patterns

`git grep` searches git objects directly, without checking anything out. It is much faster than "read the whole text, then regex it in JS", and it skips binaries for free.

**Validating a newly written pattern** takes three steps:

```bash
# 1. How many files does it hit
git grep -l -E '^\s*import\s+[\w.]+;' HEAD -- '*.java' | wc -l

# 2. Eyeball a few lines to see whether it matched the wrong thing
git grep -n -E '^\s*import\s+[\w.]+;' HEAD -- '*.java' | head -20

# 3. Reverse check: did anything get matched that should not have
git grep -n -E '^\s*import\s+[\w.]+;' HEAD -- '*.java' \
  | grep -vE ':[0-9]+:import ' | head
```

**Hit counts for the same pattern across commits** show whether it is stable:

```bash
for sha in $(git rev-list --first-parent --reverse HEAD | head -20); do
  n=$(git grep -c -E '<pattern>' "$sha" -- '*.java' 2>/dev/null | wc -l)
  echo "$sha $n"
done
```

### Yes: finding change points

`git log -S'<pattern>'` reports directly when a piece of text appeared or disappeared. **That is an order of magnitude faster than walking every commit by hand**, and it is the right way to narrow down "which few commits deserve a close look" before running the full pipeline over just those ranges.

### Yes: pulling candidate text for a model to read

`git grep -n -C2` includes context and the output stays small, which makes it a good thing to hand to a model to answer "is this pattern matching the construct I meant". This is the correct place for a model to take part — **changing the rule, not judging truth**.

### No: judging

**Judgement has to stay in the tool. It must not be handed to a model.** That is the point of this project: if a model has the last word on "nothing wrong here", you have added another layer of unverifiable judgement, which is the very problem the tool exists to address.

What a model can do is choose claims, write patterns, and revise patterns after looking at false positives. **After that, the conclusion is still computed by the tool from the rules, recorded commit by commit, and open to review.**

### No: cross-line structure

Shell works line by line. Cross-line imports, nested function bodies, multi-line annotation arguments — `git grep` gives you one line and nothing can be decided from it. **Those need the surrounding text read out.**

`scan.ts` is already optimised for this: a persistent `git cat-file --batch` reads bodies in bulk by blob id, each blob is read once and parsed once, and a commit whose code files and `package.json` are unchanged reuses the previous result. Most files do not change between adjacent commits, so each commit only reads a few new ones.

**So the division of labour is: `git grep` to find candidates (fast, coarse), `cat-file` to fetch full text (exact, only for what is needed).**

## Steps for adding a language

1. Add a JSON under `src/lang/` with the four groups of patterns: imports / definitions / hollow / routes.
2. Use the three `git grep` steps above to validate hit rate and false hits on at least two real repositories.
3. Move the extension in `lang.ts` from `unsupported` into the supported list.
4. Record, separately from `docs/PATTERNS.md`, the known misjudgements of this language's patterns on those two repositories.
5. Update the supported range in both the Chinese and English documentation.

**Do not add a pattern that has not been validated.** A wrong regex pollutes the import graph, the boundary checks and the hollow-implementation detection at the same time, and it does not raise an error — it just produces wrong red cells.

## What is out of reach

These are design boundaries, not a to-do list:

- **Semantics.** Declarative patterns recognise shape; they cannot recognise "this code is computing the right thing". Generics, type inference, macros and templates are all beyond a regex.
- **Cross-line structure**, as above. The real answer is a real parser per language (Python's `ast`, the TypeScript compiler API for JS/TS, javac for Java, and so on), which is a different project.
- **Build configuration.** Alias paths (tsconfig paths, webpack alias, Java sourceSets) are not resolved. Today only internal packages in a monorepo are recognised, via the `name` field of a non-root `package.json`.
- **Runtime behaviour.** Only the three fact types `test-passes` / `invariant-holds` / `output-unchanged` can reach a number computed inside a function body. They do it by running a command, not by reading code.

**Keeping "shape" separate from "semantics" is the only boundary this tool currently holds.** Changing what language it is written in will not move that line.
