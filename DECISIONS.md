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

## Open items

- **Size limits** for AI rewrites: re-tune after trying a real model (Phase 5).
- **Narrating comments left above removed console calls** (`// Log the current state`): left for the AI stage, which may remove narrating comments.
