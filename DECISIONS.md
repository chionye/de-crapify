# Decisions

Decisions made while building de-crapify that go beyond, refine, or change [the spec](de-crapify-SPEC.md). The spec has been updated to match. This file records *why*.

The guiding rule throughout: **a missed cleanup is fine; a broken file or a false alarm is not.** When a choice trades coverage for safety, safety wins.

## Setup and tooling

| Decision | Why |
|---|---|
| `commander` 14 and `chalk` 5, not the latest majors | `commander` 15 and `chalk` 6 require Node 22; the spec targets Node ≥ 20. |
| Tests run with `node --test test/*.test.js` (shell glob) | Node 20's test runner doesn't expand globs itself. |
| `typescript` (7.x) and `typescript-6` (alias of 6.x) as **devDependencies** | To test both typecheck backends against real compilers. Never a runtime dependency: the tool always uses the scanned project's own TypeScript. |
| Unexpected crashes exit with code 2 | Exit 1 means "cleanups found" in `--check` mode, so a crash must never look like that. |
| `--write` and `--check` together is an error (exit 2) | `--check` promises never to write. |

## File discovery

| Decision | Why |
|---|---|
| Inside a git repo, files come from `git ls-files --cached --others --exclude-standard`; outside one, the `ignore` package applies every `.gitignore` found | Git's own semantics (nested `.gitignore`, `.git/info/exclude`, global excludes) can't be matched exactly by reading only the nearest `.gitignore`. |
| `android/` and `ios/` are skipped only next to a `package.json` that uses `react-native` or `expo` | Elsewhere they may hold real source (`src/platforms/ios/`). |
| Symlinked files are skipped and listed | Writing through a symlink could change a file outside the target. |
| `@generated` only counts on a comment line | Otherwise any file mentioning the marker in a string (including de-crapify itself) is skipped. |
| The target path itself may start with a dot | So `de-crapify clean .` works; the dot rule applies below the target. |

## Parsing

| Decision | Why |
|---|---|
| Each file tries a list of parser settings: TS files try `decorators-legacy` then `decorators`; JS the reverse; `.cjs`/`.cts` try `script` first | TS parameter decorators (`@Body() dto`, NestJS) only parse with `decorators-legacy`, which rejects `export @dec class`. Verified against real NestJS-style code. |

## Project context

| Decision | Why |
|---|---|
| Context is computed per directory and cached, not once per run | In a monorepo, files belong to different packages and tsconfigs. Every config file is still read only once. |
| Referenced tsconfigs are read too: `jsx` is taken from them when they all agree; their `paths` are combined | Vite's template keeps `jsx` and `paths` in `tsconfig.app.json`, not the root config. Combining aliases can only make *more* imports resolve, so it never causes false alarms. |
| Vite counts as the automatic JSX runtime only with `@vitejs/plugin-react(-swc)`; Expo/Next/Vite all need a *known* React ≥ 17 | Vite's own esbuild JSX transform is classic. When unsure, "classic" is the safe answer (it only means the `React` import is kept). |
| The installed React version wins over the range in `package.json` | It's what actually runs. |
| An unparseable tsconfig/`.babelrc`, or an `extends` that can't be found, makes aliases "uncertain" | Unknown config might define aliases; alias-like imports are then "could not verify" instead of "likely hallucinated". |
| `webpack.config.*` and `.babelrc.js` are also treated as JS configs that may define aliases | Same reason, more coverage of real projects. |
| `node_modules` lookups walk to the filesystem root; `package.json` lookups stop at the git root | The first matches how Node resolves packages; the second is the spec's rule. |

## Deterministic rules

| Decision | Why |
|---|---|
| All rules look at the original parse; edits are applied in one pass, then the result is parsed again (any failure: the file is left unchanged) | Reports keep line numbers that match the file on disk, and a bug in a rule can never write broken code. |
| References inside `console.log(...)` calls being removed don't keep an import alive | Otherwise `console.log(debugThing)` would keep an import that becomes unused. |
| Import usage is counted generously: any same-named identifier in a value, type, JSX, export position, or in a JSDoc comment | Overcounting only keeps an import. JSDoc counts because `checkJs` projects reference imported types from comments. |
| `import * as React` is protected like `import React` under the classic runtime | Classic JSX needs `React` in scope either way. |
| More console arguments count as side-effect free than the spec first listed: operators over safe values and TS casts (`delete` excluded) | Same risk as template literals; without it, very common calls like `console.log('n: ' + n)` would only ever be reported. |
| An `if` emptied by console removals is removed when its condition has no side effects and it has no `else` | `if (__DEV__) { console.log(...) }` would otherwise leave `if (__DEV__) {}`. An `if` that was already empty is never touched. |
| A removed line never leaves a double blank line behind | Cosmetic, but it's the first thing a reviewer notices in the diff. |
| An unused import of a nonexistent package is just removed, not also reported | The problem is gone. |
| Root-relative imports (`/src/x`) that don't exist are "could not verify" | Each bundler interprets them differently. |
| Imports loaded inside `try` are "could not verify" | That's the optional-dependency pattern. |
| A `de-crapify-keep` marker at the end of a line protects that line as well as the next statement | That's what people usually mean by it; over-protecting is the safe direction. |
| God files: needs **two** components over ~40 lines (or ≥ 3 large unrelated groups); file size alone is only context | A component plus a small helper component is normal. Avoids false alarms. |
| God-file suggestions: the component that stays is the default export, else the one rendering the most others, else the largest; helpers move with their only user, exported or not | Matches how people actually split such files; a future `split` command will update importers anyway. |

## Validation (AI rewrites)

| Decision | Why |
|---|---|
| A rewrite with the same AST and comments as the original is "unchanged", not "accepted" | A model that only reformats (quotes, spacing) must not flood the diff. |
| Prose around unfenced code is trimmed only when a line reads like a sentence | A short code line (`const b`, `return total`) must never be thrown away as prose. |
| `undefined`, `NaN` and `Infinity` are never "new identifiers" | They can't be meaningfully shadowed and have no side effects. Everything else new is rejected. |
| The literal check treats strings, template text and JSX text as one pool, and includes JSX text | `'a' + b` → `` `a${b}` `` isn't a new literal; a model must not reword UI text. |
| The hooks check only blames violations the rewrite *adds*; `React.useX` ↔ `useX` is a change | Pre-existing problems aren't the model's fault; the identifier swap changes what's called. |
| Size limits stay at the spec's values (≤ 60% shorter, never longer) | To be revisited with a real model in Phase 5: early-return rewrites of small functions can come out a few characters longer. |

## Typecheck

| Decision | Why |
|---|---|
| Two backends: the in-memory compiler API for TypeScript ≤ 6; the `tsc` binary for TypeScript 7+ | **TypeScript 7 (the native Go compiler, now `latest` on npm) has no classic JS API**: its package exports only `version` and `unstable/*`. |
| With the API backend, write mode checks in memory *before* writing (instead of the spec's original write → `tsc` → bisect) | Same compiler, same answer, but a broken file never touches disk, even briefly. |
| With the CLI backend (TS 7+), dry run skips the typecheck and says so; write mode writes each candidate temporarily and always restores | The binary can only check files on disk, and a dry run must never write. The spec allowed skipping in dry run. |
| A file that adds type errors first loses only its AI changes; only if it still fails are all its changes dropped | Keeps safe deterministic fixes where possible. It also catches the rare case where removing an "unused" import breaks a type augmentation. |

## AI stage (Ollama)

| Decision | Why |
|---|---|
| Chunks include the `//` comments directly above them; JSDoc and block comments above stay outside the chunk | Narrating comments above a function can be removed, while JSDoc and license headers are protected by construction, not just by the prompt. |
| TypeScript interfaces, types and enums are never sent to the model | The signature check doesn't cover their members; a dropped field would only be caught by the typecheck, which may not run. |
| Non-exported plain values (`const settings = {...}`) are not chunks; exported ones are | The spec's list: functions, classes, components, exported declarations. |
| Chunks are processed from the end of the file to the start | Applying a rewrite never shifts the positions of chunks still to come; no re-parsing needed between calls. |
| Chunks too large for `--num-ctx` are skipped up front (≈ 3.5 chars/token, reply ≈ chunk size) | Otherwise the model runs out of context mid-reply, wasting minutes before the reply is rejected as truncated. |
| "Ollama not running" is a yellow warning (still exit 2); "model missing" is a red error | The first is a state to fix; the second is usually a typo or a missing `ollama pull`. |
| A model name without a tag means `:latest`; other tags never match | Mirrors Ollama, and never silently uses a different model. |
| Failed or timed-out requests appear in the summary's AI line, not as "rejected suggestions" | They aren't suggestions; mixing them would hide model-quality signal. |
| AI fixes are counted after the typecheck | So changes the typecheck drops aren't reported as accepted. |
| Without `--verbose`, one progress line per chunk goes to stderr | Local models take seconds to minutes per chunk; a silent run looks hung. stdout stays clean for the diff. |
| AI reasons describe what changed, from the AST (comments removed, nesting flattened, variables removed) | Matches the spec's example ("AI: flattened nested conditionals in `handleSubmit`") without trusting the model's own description. |

## Zero-setup direction (after Phase 5)

| Decision | Why |
|---|---|
| The tool must be useful right after `npm install`, with no other setup | Requiring the Ollama app and a 4.7 GB model download before anything works defeats the purpose of an npm tool. |
| More cleanups move into deterministic rules (Phase 6); AI becomes a built-in local model, downloaded once with consent (Phase 7); Ollama is used if already present; a bring-your-own-key cloud provider is recorded for later | Deterministic rules are instant, free and safe by construction. A built-in model removes the separate app. Code still never leaves the machine by default. |
| The "no network calls" rule is replaced by "the only network use is the one-time model download" | Requested; the download is the one unavoidable network step for local AI. |

## More deterministic rules (Phase 6)

| Decision | Why |
|---|---|
| Every structural transform is one atomic edit that carries its own reason | If an overlap means an edit is dropped, it's dropped whole: a half-applied rewrite (variable removed, still returned) can't happen, and no reason is reported for an edit that wasn't applied. |
| Structural rules repeat in passes (up to 5) until nothing changes; reports come from the first pass only | One transform exposes another (removing an `else` makes nesting collapsible). Report line numbers must match the file on disk. |
| Narrating comments are matched against the statement's "head": a declaration's name, an `if`'s condition, a loop's header, otherwise the whole statement | Matching against a whole function body would let almost any comment "match" and remove real explanations. |
| Comments are only removed when *every* meaningful word appears in the code; explanation words, `TODO`-style flags, `?`, URLs, `@` tags, directives, comment blocks, and comments over 10 words are always kept | A missed narrating comment is harmless (the AI may catch it); a removed explanation loses information. |
| A comment about logging directly above a removed console call goes with it, and the two removals are joined so no double blank line is left | `// Log the current state` with nothing below it is noise. |
| Removing an `else` after `return` takes priority over collapsing `else { if }` into `else if` | It produces the flatter result in fewer passes. |
| Lifting an `else` body also requires that its `let`/`const`/`class` names aren't used anywhere else in the enclosing block (not just "not already declared") | Otherwise a lifted `const status` would shadow a later use of a global `status`, silently changing behavior. |
| Re-indenting rules skip code with multi-line strings or template literals | Re-indenting would change the string's contents. |
| `const x: T = expr; return x;` is left alone | Folding would drop the annotation, which can change what the type checker infers. |

## Built-in model (Phase 7)

| Decision | Why |
|---|---|
| Default model: Qwen2.5-Coder 1.5B Instruct, Q4_K_M GGUF (1.1 GB, checksum verified) | Small enough for ordinary laptops without a GPU, and a code model. The 3B version is 2.1 GB. Verified on an Apple-silicon Mac: download 107s, load 3s (Metal), ~5s per chunk; 8 of 8 suggestions on three fixtures accepted. |
| `node-llama-cpp` is an **optional** dependency, loaded lazily | Its postinstall builds llama.cpp from source when no prebuilt binary fits, and exits with an error if that fails. As a required dependency that would make `npm install de-crapify` fail on such machines; as an optional one, npm skips it and de-crapify runs without AI. |
| Always `build: "never"`, `skipDownload: true`; plus `config.nodeLlamaCppPostinstall: "ignoreFailedBuild"` in our package.json | We never compile or clone anything on the user's machine. The config setting only takes effect in some install layouts, so it's a second line of defence, not the main one. |
| Known: `npm audit` reports a critical advisory in `simple-git` (via `node-llama-cpp` 3.22.1) | `simple-git` is only used by `node-llama-cpp` to clone llama.cpp for source builds, which we disable, so the vulnerable code never runs in de-crapify. The fix is in `simple-git` 4.x, which `node-llama-cpp` doesn't allow yet; users' `npm audit` will show it until upstream updates. Re-check when upgrading. |
| Install size: ~55 MB on macOS; on Linux x64, npm also installs the CUDA and Vulkan binary variants (~190 MB for CUDA alone) | That's how `node-llama-cpp` publishes its platform binaries; npm can't tell which GPU a machine has at install time. |
| Our own downloader (native `fetch`), not `node-llama-cpp`'s | Resume via `Range`, disk-space check, size and SHA-256 verification before the file is moved into place, a marker so the 1 GB file isn't re-hashed every run, and an injectable `fetch` so tests never download anything. |
| Provider `auto`: Ollama if running with the model, else the built-in model; anything that prevents AI becomes one yellow line and the run continues | "Works right after `npm install`." An explicit `--ai-provider`, `--model` or `--ollama-url` means the user asked for something specific, so failures there stay setup errors (exit 2). |
| The download is asked for once in a terminal (Enter = yes); never asked in CI, `--check`, or without a TTY; `--yes` allows it without asking | A 1.1 GB download should never surprise anyone, and CI must never hang on a question. |
| When a reply echoes imports or neighbouring declarations, only the requested declaration is kept | Seen with the real 1.5B model: it repeated the prompt's imports (and silently changed an interface). Previously that was rejected as unparseable; now the extras are simply never applied, and the declaration is still fully validated. The prompt also asks the model not to do this. |
| `--model` and `--ollama-url` no longer have commander defaults (defaults are applied later) | So we can tell whether the user actually asked for Ollama. |

## Write mode (Phase 8)

| Decision | Why |
|---|---|
| The git check is scoped to the target path and to source files de-crapify could change | Unrelated work elsewhere in the repo (or an untracked `notes.md`) shouldn't block a run; every file de-crapify might touch can still be undone with git. |
| The git check and the `--test-cmd` baseline run before any AI work | Don't make someone wait for a model only to be refused at the end. |
| Tests run once after writing; only if they fail are files re-applied one at a time | The common case costs one test run instead of one per file. The files left on disk are always a state the tests passed on. |
| A file that breaks the tests first loses only its AI changes, then all of them | Same two-step approach as the typecheck; keeps safe deterministic fixes. |
| Writes are atomic (temp file + rename, permissions kept), and a file that changed on disk since it was read is not overwritten | No half-written files after a crash; never clobbers someone's edits. |
| Ctrl-C while the tests are being checked puts every file back | The run never ends in a half-verified state. A Ctrl-C during the TS 7 binary check could leave a candidate on disk, but `--write` requires a clean git tree, so `git restore` recovers it. |
| Write mode prints one line per file (`✔ wrote a.js (5 fixes: 3 deterministic, 2 AI)`); `--verbose` adds the diff | As the spec says; the diff is in `git diff` anyway. |
| Removing code at the very top of a file also removes the blank line after it | Otherwise removing a file's only import leaves it starting with a blank line. |

## Open items

- **Size limits** for AI rewrites: re-tune after trying a real model.
- **Real-model trial:** the built-in model has been tried on the fixtures (all suggestions accepted after the echo fix). Try it on a real codebase with `--verbose` and tune the prompt and size limits from what gets rejected.
- **`simple-git` advisory:** re-check on each `node-llama-cpp` upgrade.
- **Narrating comments left above removed console calls** (`// Log the current state`): left for the AI stage, which may remove narrating comments.
