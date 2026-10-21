# Security

[中文](SECURITY.md) | [English](SECURITY.en.md)

## The one thing to know first: it executes shell commands

Three fact types — `test-passes`, `invariant-holds` and `output-unchanged` — take a `command` field from `claims.json` and hand it to a shell:

```ts
spawnSync(command, { cwd, shell: true, timeout })
```

Which means:

- **Pipes, redirects, `&&` and command substitution all work.** It is not running a single executable.
- **The working directory is a temporary worktree of that commit**, but the command can `cd` anywhere and read or write the whole filesystem.
- **No sandbox, no command allowlist, no network isolation.**
- **Same privileges as the person running `run.ts`.**

`command` is only length-limited (2000 characters). It does **not** go through `repoRelative` or any other path validation.

### When this is a risk

`.laminae/claims.json` is input, and it comes from one of two places:

1. You or your agent wrote it in **your own repository** — the risk is the same as running a script yourself.
2. **It came from somewhere else** — a repository someone handed you, a `claims.json` someone gave you, or one an agent wrote after reading untrusted documentation.

The second case is the one to worry about. This project's premise is that documentation lies: if a document hides content that steers an agent into writing some command into `claims.json`, that command gets executed.

**Do not run a `.laminae/claims.json` from a source you do not trust.** Read the `command` fields first.

### What is already constrained

These are **conventions and boundary checks, not a sandbox**:

- `file`, `fact.file`, `fact.base`, `fact.source` and the `target` of an idea must be relative paths inside the repository; absolute paths and `..` are rejected
- Commands run in a temporary worktree, so **the target repository's main working tree is not modified**
- The worktree is removed afterwards
- Default timeout is 60 seconds (`timeout` can change it); on timeout the process started directly is terminated, but **child processes it spawned are not guaranteed to be cleaned up**
- When several repositories run at once, a single repository using these three fact types forces serial execution (so tests do not fight over ports and databases)
- laminae refuses to analyse its own repository

### What is not done

- No restriction on what a command may do
- No network isolation
- Not run as an unprivileged user
- No auditing of command content

If you need those, wrap it yourself: a container, `firejail`, a separate user, or simply do not allow fact types that execute commands.

---

## What is not involved

- The nine repository-counting fact types (`count-files`, `json-length`, `path-exists` and the rest) **only read git objects**. They execute nothing, check nothing out, and do not modify any tracked file in the target repository.
- The generated `laminae.html` is a single file with no external requests; it loads no remote scripts or styles.
- The "verify on GitHub" links in the report point at the target repository's own web address and only navigate when the user clicks them.
- laminae collects nothing, uploads nothing, and has no telemetry.

---

## Reporting a problem

Use GitHub's [private vulnerability reporting](https://github.com/haimikao0721-a11y/Laminae/security/advisories/new) rather than opening a public issue.

If that entry point is unavailable, open an issue that says only "I would like to report a security problem privately", without details, and we will arrange a channel.

Please say which part is affected (command execution, path validation, generated report, dependencies), how to reproduce it, and what the consequences could be.

---

## Dependencies

There are no runtime dependencies. Three development dependencies (TypeScript, esbuild, @types/node) do not ship in the output; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.en.md).

## Worth turning on in the repository settings

- **Dependabot alerts**: flags known vulnerabilities in the development dependencies listed in `package-lock.json`
- **Code scanning (CodeQL)**: free for public repositories; scans the TypeScript in `src/` and `web/`
- **Secret scanning**: free for public repositories; helps catch committed credentials

All three are toggles in the repository's Settings. They have nothing to do with running laminae, but a public repository should have them on.

---

## Licence

[MIT](LICENSE).
