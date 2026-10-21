# Third-party notices

[中文](THIRD-PARTY-NOTICES.md) | [English](THIRD-PARTY-NOTICES.en.md)

## Summary

**No third-party code ships in the output.**

Everything inside `laminae.html` comes from this repository: `dist/app.js` compiled from `web/*.ts`, `web/style.css`, and data measured at runtime. No chart library, no UI framework, no runtime dependency of any kind.

`package.json` has no `dependencies`.

---

## Development dependencies (not shipped)

Used only when developing this repository. They do not ship and are not needed to run laminae in a target project.

| Package | Version | Licence | Purpose |
|---|---|---|---|
| [typescript](https://www.typescriptlang.org/) | 5.9.3 | Apache-2.0 | Type checking (`npm run typecheck`); not part of the build output |
| [esbuild](https://esbuild.github.io/) | 0.25.12 | MIT | Compiles `web/*.ts` into `dist/app.js`; the output is the compiled result and contains no esbuild code |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | 24.19.2 | MIT | Type declarations for Node's built-in modules; compile-time only |

All three are permissive and compatible with [MIT](LICENSE).

---

## Designs we looked at (not code)

### [archify](https://github.com/tt-a1i/archify)

What we took was its public **interaction capability list**, not code.

The comment at the top of `web/app.ts` saying the interaction language references archify refers to exactly this: a source that can be opened to verify, search, preset views, a clickable legend, time-lapse playback, deep links. It also records what we deliberately did not adopt — its Semantic Radar (minimap), Reading Depth (detail by zoom level) and Route Probe (path between two nodes) — because this chart does not need them.

Since only the list was an inspiration and every implementation here was written in this repository, its licence terms do not apply. It is written down here so readers know where the interaction list came from.

### Projects read during the positioning research

Public write-ups of the projects below were read while working out where this tool sits. **None of their code was imported**, and none of their documentation was copied verbatim. They are listed because a few design decisions relate to them, so a reader who wants to trace things back has somewhere to go.

| Project | Relation to this work |
|---|---|
| [docclaims](https://github.com/jhaney0214-sys/docclaims) | The shape of a claim ledger; the principle that "not checked" must never read as "passed" |
| [docrot](https://github.com/dager23/docrot) | Reference parsing and git-based tracing; "cannot decide" must not turn into a conclusion |
| [staledocs](https://pypi.org/project/staledocs/) | Two-step confirmation; the check itself is subject to being checked |
| DOCER (Empirical Software Engineering, 2023) | Verifying reference existence commit by commit; the three-way classification of how it ends |
| DocPrism | The framing of the question "we cannot know whether code or documentation should be rectified" |

Storing "unmeasurable" separately from "false", giving `unmeasurable` its own outcome, and refusing to count a parse failure as a problem — these are general principles, not lifted from any one implementation. They were settled after reading the projects above, which is why they are listed here.

### Repositories used for trial runs

[Lucide](https://github.com/lucide-icons/lucide) and google-analytics were only **subjects** of manual trial runs. They are not dependencies; their source was neither used nor distributed. The commit counts quoted in the README and [docs/REFERENCE.md](docs/REFERENCE.en.md) are there to illustrate that first-parent mainline history is shorter than total history.

---

## Adding something here

Three cases, handled differently:

| What you are adding | Do you record it here | How |
|---|---|---|
| **An idea, a principle, a framing of a problem** | Yes, in the section above | Ideas are not protected by copyright, but state the source so readers can trace it |
| **An interface shape, field naming, an interaction list** | Yes | Specific expression is protected. Referring is fine; do not copy comments and documentation word for word |
| **Code** | Yes, and keep the other party's full licence text | Check their licence first: MIT / Apache-2.0 / BSD can be merged in, keeping the copyright notice; **GPL / AGPL must not be merged in** — they require the derivative work to be distributed under the same free licence, which conflicts with turning this project into GPL-licensed code |

The test is simple: **if you copied their source, it is the third case.**

Include the source in the commit message, for example:

```
Ported XXX's decision logic from <project> (<URL>, <licence>)
```

---

## The other direction

This project is released under [MIT](LICENSE). Others may use it in commercial products, relicense it, or put it inside a GPL project — MIT is one-way compatible with the GPL.

The only obligation is to keep the copyright notice and the permission notice.

If that ever needs to be narrowed, the thing to change is [LICENSE](LICENSE), not this file.
