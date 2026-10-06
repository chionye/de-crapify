# Build: de-crapify

You are building **de-crapify**, an open-source Node.js CLI that cleans up messy patterns AI coding assistants leave in JavaScript/TypeScript code (including React and React Native): unused imports, leftover debug logs, comments that just narrate the code, over-nested conditionals, duplicated or badly stitched logic, and "god files" that cram several components or modules into one file.

**It must work right after `npm install`, with no other setup.** The deterministic rules need nothing. The AI part runs a small model on the user's machine, built into the tool (downloaded once on first use), or uses Ollama if the user already has it. Code never leaves the machine: no cloud AI, no telemetry. The only network use is that one-time model download.

## The core principle (read this first)

**The AI suggests, the code verifies.** A small local model will sometimes break code while "cleaning" it. The tool must never trust model output. Every change is validated before it is offered, and nothing is written to disk unless the user explicitly asks. When in doubt, leave the code alone. A missed cleanup is fine; a broken file is a failure. A false alarm (e.g. flagging a valid import as hallucinated) is also a failure, because users stop trusting the tool.

## How to work

- Start in plan mode. Read this whole spec, then propose a file structure and the order of work before writing code.
- Build in the phases below. After each phase: run the tests, show me a short summary of what was done and anything you were unsure about, then **stop and wait for me** before starting the next phase.
- Write tests alongside each piece, not at the end.
- Keep dependencies minimal. If you want to add one not listed here, ask first.
- If any part of this spec seems wrong or unsafe once you're in the code, tell me rather than working around it silently.

## Tech constraints

- Node.js >= 20, plain JavaScript, ES modules (`"type": "module"`). Use JSDoc types where they help.
- `package.json` exposes the binary: `"bin": { "de-crapify": "./src/index.js" }`, with `#!/usr/bin/env node` at the top of that file. Declare `"engines": { "node": ">=20" }`.
- Dependencies: `commander`, `chalk`, `diff`, `ignore` (for .gitignore rules), `@babel/parser`, `@babel/traverse`, `magic-string` (to remove code ranges without reformatting the rest of the file), and `node-llama-cpp` as an **optional** dependency (runs the built-in model in-process from prebuilt binaries; optional so that if it can't install on some machine, de-crapify still installs and runs without AI). Our `package.json` sets `config.nodeLlamaCppPostinstall: "ignoreFailedBuild"`, and the library is always loaded with `build: "never"` and `skipDownload: true`, so it never clones or compiles llama.cpp.
- Use `node:fs/promises` and `node:path` (no `fs-extra`). Use native `fetch` for Ollama.
- Tests: the built-in `node:test` runner and `node:assert`. Tests must never need Ollama running; the Ollama client must accept an injectable `fetch` so tests can mock it.
- Do **not** add TypeScript as a (runtime) dependency. For type-checking, use the project's own TypeScript (see Validation). `typescript` (7.x) and `typescript-6` (an alias of 6.x) are devDependencies used only by tests, to exercise both typecheck backends against real compilers.
- Dependency versions must support Node 20: `commander` 14 and `chalk` 5 (later majors require Node 22).

### Supported files and parsing

Supported in v1: `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`, including React Native platform files like `Button.ios.tsx`, `Button.android.tsx`, `Button.native.tsx`, `Button.web.tsx`. Vue, Svelte, and Flow are out of scope.

Babel parser plugins by extension:

- `.ts`, `.mts`, `.cts`: `typescript` **without** `jsx` (with JSX enabled, generic arrows like `<T>(x: T) => x` fail to parse).
- `.tsx`: `typescript` + `jsx`.
- `.js`, `.jsx`, `.mjs`, `.cjs`: `jsx` (React Native and many React projects put JSX in `.js` files).
- Always: decorators (NestJS, MobX, TypeORM use them; use `decorators-legacy` for TypeScript files if needed so parameter decorators like `@Body() dto` parse, verified against real NestJS-style code), `classProperties`, `topLevelAwait`, `importAttributes`. Use `sourceType: "module"`, falling back to `"script"` for `.cjs` or if module parsing fails.
- If a file fails to parse, skip it and list it in the summary. Never attempt to change a file the tool can't parse.

## CLI

```
de-crapify clean <path> [options]
```

`<path>` can be a file or a directory (recursive).

Options:

| Flag | Default | Meaning |
|---|---|---|
| `--write` | off | Apply changes to disk. **Without it, the tool only shows a diff (dry run is the default).** |
| `--check` | off | CI mode: print a summary, exit with code 1 if any cleanups or any **likely hallucinated** imports were found, 0 otherwise ("could not verify" imports, unsafe console calls, and god files don't affect the exit code). Never writes. Combining with `--write` is an error (exit 2). |
| `--force` | off | Allow `--write` on a git repo with uncommitted changes, or outside a git repo. |
| `--no-ai` | AI on | Run only the deterministic rules; no model is loaded or contacted. |
| `--ai-provider <name>` | `auto` | `auto`: Ollama if it's running with the model, else the built-in model. `builtin` or `ollama` force one (see AI providers). |
| `--yes` | off | Allow the one-time built-in model download without asking (for scripts and CI). |
| `--model <name>` | `qwen2.5-coder:7b` | Ollama model to use. |
| `--ollama-url <url>` | `http://localhost:11434` | Ollama server address. |
| `--num-ctx <n>` | `8192` | Context window to request from Ollama. |
| `--typecheck` / `--no-typecheck` | auto | Run `tsc --noEmit` as a validation step. Auto = on when a `tsconfig.json` exists and the project has TypeScript installed. |
| `--test-cmd "<cmd>"` | none | Shell command (e.g. `npm test`) run after changes to a file; if it fails, that file's changes are reverted. Run once before any changes as a baseline; if the baseline fails, abort with exit 2. Only meaningful with `--write`. |
| `--max-file-size <kb>` | `200` | Skip files larger than this. |
| `--keep-console <methods>` | `error,warn` | Console methods never removed. |
| `--verbose` | off | Log each step, including rejected AI suggestions and why. |

## File discovery

- If the path is a file, process just that file (if it's a supported extension).
- If it's a directory, walk it recursively. Always skip: `node_modules`, `dist`, `build`, `out`, `coverage`, `.next`, `.nuxt`, `.expo`, `.turbo`, `.cache`, and any file or folder starting with `.` (below the given path; the path itself may start with `.`, e.g. `de-crapify clean .`). Skip `android` and `ios` folders only when they sit next to a `package.json` that depends on `react-native` or `expo` (native folders in React Native projects); elsewhere they may hold real source.
- Respect git ignore rules: inside a git repo, list files with `git ls-files --cached --others --exclude-standard` (exact git semantics, including nested `.gitignore` files). Outside a git repo, fall back to the `ignore` package, applying every `.gitignore` found in the walked directories and the nearest one above the target.
- Skip minified files (e.g. `*.min.js`, or a single line longer than ~1000 characters), declaration files (`*.d.ts`, `*.d.mts`, `*.d.cts`), and generated files containing a `@generated` marker.
- A file containing `// de-crapify-ignore-file` is skipped entirely.
- Any statement or declaration directly preceded by a `// de-crapify-keep` comment (other comments may sit in between) must never be changed by any rule or the AI. A marker at the end of a line (`console.log(x); // de-crapify-keep`) also protects the statement on that line.

## Project context (load once per run)

Before processing files, build a small project context object. Rules use it to avoid false positives.

- **Packages:** collect dependencies, devDependencies, peerDependencies, and optionalDependencies from the nearest `package.json` **and every `package.json` above it up to the git root** (or the filesystem root if there is no git repo; monorepos often hoist deps to the root). Also detect workspace roots (`workspaces` in package.json, `pnpm-workspace.yaml`) and treat workspace package names as installed. Also treat a package as installed if it exists in a reachable `node_modules`. A package's own `name` counts (self-imports), and so does `@types/x` for type-only imports of `x`. Read the `imports` field (`#x` subpath imports) of the nearest `package.json`.
- **Path aliases:** read `compilerOptions.baseUrl` and `compilerOptions.paths` from `tsconfig.json` / `jsconfig.json`, following `extends` chains (including `extends` pointing to a package such as `expo/tsconfig.base`; if it can't be resolved, continue without it). If a `.babelrc` or `babel.config.json` (JSON only) contains `module-resolver` aliases, read those too. If the project has a `babel.config.js`, `metro.config.js`, or `vite.config.*` (JS configs the tool won't execute), note that unknown aliases may exist (see rule 3).
- **JSX runtime:** determine whether the project uses the classic runtime (needs `React` in scope) or the automatic runtime. Check in this order, first match wins:
  1. a per-file `/** @jsxRuntime classic|automatic */` pragma;
  2. tsconfig `jsx`: `react` → classic; `react-jsx` / `react-jsxdev` → automatic (`preserve` decides nothing; Next.js sets it);
  3. React version below 17 → classic;
  4. the project uses Expo, Next.js, or Vite with its React plugin (`@vitejs/plugin-react` or `-swc`; Vite's own esbuild JSX is classic), with a *known* React version of 17+ → automatic;
  5. otherwise classic. **If unsure, assume classic** (the safe choice).
- **TypeScript:** whether a `tsconfig.json` exists and `typescript` is installed in the project (for the typecheck step), and `compilerOptions.moduleSuffixes` (React Native projects use it for platform files).

## Pipeline (per file)

### Stage 1: Deterministic rules

These run first, are fast, and are safe by construction. Each rule produces a list of edits (ranges to remove) plus a human-readable reason. Apply with `magic-string` so untouched code keeps its exact formatting.

1. **Unused imports.** Remove import specifiers whose local name is never referenced (count usage in JSX too, e.g. `<Button />` uses `Button`, and `<Foo.Bar />` uses `Foo`). Remove the whole import statement if all its specifiers are unused. Never remove:
   - side-effect imports (`import './styles.css'`, `import 'react-native-gesture-handler'`);
   - type-only usages (they count as usages in TypeScript);
   - the `React` import (default `import React` or namespace `import * as React`) in any file containing JSX, **unless** the project context says the automatic JSX runtime is in use;
   - anything imported in a file that also uses `eval`, `with`, or JSX pragma comments (`/** @jsx h */`); skip this rule for those files.
2. **Debug console calls.** Remove standalone expression statements like `console.log(...)`, `console.debug(...)`, `console.info(...)`, `console.trace(...)`, `console.dir(...)`, `console.table(...)`. Do not remove methods listed in `--keep-console`. Do not remove console calls that are part of a larger expression or whose arguments could have a side effect (only literals, identifiers, member access, spreads of those, and templates/objects/arrays built from them are safe; calls, `new`, `await`, assignments, `++`/`--`, and tagged templates are not); report them instead. Only remove a call whose parent is a block or the program body; never remove one that is the body of a brace-less `if`/`else`/`for`/`while`/`do` (removing it would make the next statement conditional) or the body of an arrow function without braces (e.g. `onPress={() => console.log('x')}`, which would break the syntax); report those instead. Skip calls where `console` is a local binding rather than the global. Operators over safe values (`'n: ' + n`, `!x`, `a ?? b`, `a ? b : c`; not `delete`) and TypeScript casts are also safe: they carry the same risk as template literals. When removals leave an `if` with no `else` empty, and its condition is side-effect free, remove the whole `if` (e.g. `if (__DEV__) { console.log(...) }`); never touch an `if` that was already empty.
3. **Unresolvable imports (report only, never delete).** Report in two levels, so the tool doesn't cry wolf:
   - **Likely hallucinated:** a bare package import (e.g. `import x from 'react-super-forms'`) that isn't installed per the project context, isn't a Node built-in (with or without the `node:` prefix), isn't a workspace package, and doesn't match any known alias; or a relative import whose file doesn't exist.
   - **Could not verify:** an import starting with an alias-like prefix (`@/`, `~/`, `#`, or `@something/` that isn't an installed scoped package) when the project has JS config files that might define aliases the tool can't read. Also: `require()` / `import()` inside a `try` block (the optional-dependency pattern) that would otherwise be "likely hallucinated".

   Never flag: Node built-ins including subpaths like `fs/promises` (use `isBuiltin` from `node:module`), virtual modules (`virtual:*` and similar `scheme:` specifiers), and specifiers with query or loader suffixes after stripping them (`./icon.svg?react`, `./file.txt?raw`).

   When resolving relative and aliased imports, try these in order: the exact path; the path plus `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.json`; React Native platform variants (`.ios`, `.android`, `.native`, `.web` before each extension, e.g. `Button.ios.tsx`, plus any tsconfig `moduleSuffixes`); and the same set for `index.*` inside a directory. Also handle TypeScript ESM style, where `./utils.js` in source refers to `./utils.ts` (and `.mjs`→`.mts`, `.cjs`→`.cts`). Imports of assets (images, fonts, `.svg`, `.css`, `.scss`, `.json`, `.md`, etc.) only need the exact file to exist. `require()` and `import()` calls with a string literal are checked the same way as imports.
4. **God files (report only in v1).** Flag files that cram too much together, with a short reason and a suggested split. A false alarm here is costly (a `utils.ts` full of small independent helpers is a normal, healthy file), so only flag when one of these is true (thresholds as constants, easy to tune):
   - more than one React component is defined at top level (a function/arrow/class whose name starts with a capital letter and that returns JSX or is used as JSX in the file), and at least two of them are over ~40 lines;
   - the dependency graph of top-level declarations splits into at least ~3 separate groups that are each large (over ~60 lines).

   File size alone (e.g. more than ~400 lines) or many small unrelated declarations alone are not enough; mention them as context in the reason only when one of the conditions above is met.

   For the suggestion, group top-level declarations by which ones reference each other, and propose one file per main component or group, e.g. "move `UserCard` and `formatDate` (used only by `UserCard`) to `UserCard.tsx`." This is plain dependency analysis, no AI needed. Don't move anything in v1.

5. **Narrating comments.** Remove a single `//` comment line directly above a statement (no blank line between, not part of a multi-line comment block) when it only restates that statement: every meaningful word of the comment appears among the words of the statement's identifiers, keywords and string literals (camelCase split, lowercased, plurals and -ing/-ed folded), ignoring stopwords and a short list of generic words ("value", "variable", "function", "result", "create", "check"...). Never remove comments with `TODO`/`FIXME`/`HACK`/`NOTE`/`XXX`, `@` tags, directives, URLs, a `?`, explanation words ("because", "why", "since", "otherwise", "workaround", "so that"), or more than ~10 words. Also remove a comment directly above a debug console call that Rule 2 removes when the comment talks about logging ("log", "debug", "print", "console", "output"). A missed comment is fine (the AI may catch it); a removed explanation is not.
6. **Needless nesting.** `if (a) { if (b) { … } }` where neither `if` has an `else` and the outer block contains only the inner `if` becomes `if (a && b) { … }` (operands that bind looser than `&&` get parentheses; chains collapse fully). `else { if (c) … }` where the `else` block contains only that `if` becomes `else if (c) …`. Skip anything with comments between the parts. The body is re-indented one level, unless it contains multi-line strings or templates, in which case the transform is skipped.
7. **Unneeded `else` after `return`/`throw`.** `if (c) { …; return x; } else { … }` becomes `if (c) { …; return x; }` followed by the `else` body (re-indented), when the `if` sits in a statement list and the `else` body declares nothing (`let`/`const`/`class`/`function`) that would clash with a name already bound in the enclosing scope.
8. **Redundant return variable.** `const x = expr; return x;` (adjacent statements, a single declarator, no type annotation, `x` used nowhere else, no comments in between) becomes `return expr;` (parenthesized when needed). Same for `let` that is never reassigned.

Rules 5–8 are applied repeatedly (up to a few passes) until nothing changes, because one transform can expose another (removing an `else` can make nesting collapsible). Like all Stage 1 rules, they respect `de-crapify-keep`, and the result must parse or the file is left unchanged.

### Stage 2: AI cleanup (skipped with `--no-ai`)

- Split the file (after Stage 1) into chunks: each top-level function, class, function-valued variable (arrow components, `memo(...)`/`forwardRef(...)` wrappers), or exported value is one chunk. Top-level code outside these is left alone in v1, and so are TypeScript interfaces, types and enums (the signature check doesn't cover their members, so a dropped field would go unnoticed).
- A chunk includes the `//` line comments directly above it (no blank line in between), so narrating comments there can be removed. Block comments and JSDoc above a chunk stay outside it, so the model can never touch them.
- Skip chunks that are tiny (under ~5 lines), marked `de-crapify-keep`, or too large for `--num-ctx` (estimated at ~3.5 characters per token, counting the reply as about as long as the chunk).
- Process chunks from the end of the file to the start, so accepting a rewrite never shifts the chunks still to come.
- Send each chunk to Ollama with a small amount of context: the file's import list and the names of other top-level declarations, so the model doesn't invent or remove references.
- The model may only: remove comments that restate what the code obviously does, flatten unnecessary nesting (e.g. early returns), remove redundant intermediate variables, and merge clearly duplicated logic. It must keep the same function name, parameters, return behavior, and side effects. It must not add new imports, new dependencies, or new features, and must not rename anything that's used outside the chunk. In React components it must not move, add, remove, or reorder hook calls, and must not add an early return before any hook call.
- Never send JSDoc comments, TypeScript type annotations, or `eslint-disable` / `@ts-ignore` / `@ts-expect-error` comments as things to remove; the prompt must tell the model to keep them.
- Process chunks one at a time (local models are slow, and parallel requests just queue).

### Stage 3: Validation (every AI suggestion must pass all checks, or it's rejected)

For each AI-rewritten chunk:

1. Strip markdown code fences and any prose before/after the code (models often add them despite instructions). If the reply has several top-level statements and exactly one declares the chunk's name, keep only that one: small models often echo the imports and neighbouring declarations shown in the prompt. The echoed extras are never applied, and the kept declaration still goes through every check.
2. If Ollama reports `done_reason` other than `"stop"` (e.g. it hit the length limit), reject.
3. The chunk must parse on its own (with the same parser settings as the file), and the full file with the chunk replaced must parse.
4. The set of top-level declared names and exported names in the file must be unchanged.
5. The chunk's declared name and signature must be unchanged: parameter list (including default values and TypeScript type annotations), return type annotation, and `async` / generator flags.
6. **No new free identifiers:** every identifier the new chunk references without declaring it must already have been referenced without declaration in the original chunk (value and type positions both count). This catches the model inventing helpers or reaching for globals the original didn't use, without needing an exhaustive list of JS/browser/Node/React Native/TS-lib globals. Dropping a reference is allowed.
7. **Rules of hooks:** compare the original and new chunk's hook calls (any call to a function named `use` followed by a capital letter, or `use` itself, including member calls like `React.useState`). The sequence of hook names must be identical, and in the new chunk every hook call must be at the top level of the component/hook body: not inside a condition, loop, nested function, or after an early `return`. The dependency arrays of `useEffect`, `useLayoutEffect`, `useInsertionEffect`, `useMemo`, `useCallback`, and `useImperativeHandle` must be textually unchanged (ignoring whitespace).
8. `@ts-ignore`, `@ts-expect-error`, `eslint-disable*`, and `eslint-disable-next-line` comments in the original must still be present, attached to the same statement (same normalized text of the next statement).
9. **Literals unchanged:** the string, number, bigint, regex, and template-literal text values in the new chunk must be a subset (as a multiset) of the original's. The model must not "fix" messages, URLs, or numbers.
10. **Kept statements untouched:** any statement inside the chunk preceded by `// de-crapify-keep` must appear byte-identical in the rewrite.
11. If the rewrite, measured with comments and whitespace stripped, is more than ~60% shorter than the original, or longer than the original, reject it as suspicious (constant, easy to tune). Comment-only removal is never rejected by this check.

A rewrite that is the same code as the original apart from formatting (same AST, same comments) is treated as "no change", so formatting churn never reaches the diff. In check 6, `undefined`, `NaN` and `Infinity` are never counted as new identifiers.

Rejected suggestions are dropped silently in normal mode and logged with the reason in `--verbose` mode.

**Typecheck (project-level):** when typecheck is enabled, use the scanned project's own TypeScript to check that the changes add no new type errors. Compare errors as a multiset keyed by file, line-independent message, and code (so a second copy of an existing error counts as new). The baseline is the project as it is on disk. Two backends, chosen by what the project has installed:

- **API backend (TypeScript ≤ 6):** load the project's `typescript` package (via `createRequire` from the project, never bundled or installed) and type-check in memory with a compiler host that serves the modified file contents. Used in **both** dry-run and write mode; in write mode the check happens *before* anything is written, so a file that fails never reaches disk.
- **CLI backend (TypeScript 7+):** the native compiler has no classic JS API (its package only exports `version` and `unstable/*`), so run the project's `tsc` script (`node <typescript/bin/tsc> --noEmit -p <config> --pretty false`) and parse its output. It can only check files on disk: in write mode, each candidate version is written temporarily, checked, and the previous content is always restored afterwards; in dry-run mode it's skipped and the summary says so.
- **Solution-style tsconfigs:** if the `tsconfig.json` has `"files": []` (and no `include`) and only `references` (the Vite template does this), checking it checks nothing. Detect this and check each referenced config instead. The summary must name the configs that were checked.
- **Finding the culprit:** if the changes together add errors, check each changed file on its own; files that add errors alone are changed back (if none does alone, they interact and all are). A changed-back file first loses only its AI changes; if it still adds errors, all of its changes are dropped. Repeat until the remaining changes are clean.
- Never install TypeScript on the user's behalf. Note in the README that typecheck runs the scanned project's own TypeScript package/binary, i.e. code from that project.

With `--write` and `--test-cmd`: run the test command once before any changes as a baseline (if it fails, abort with exit 2 rather than reverting every file). After writing, run it once; if it fails, put every file back and re-apply them one at a time, testing after each. A file that breaks the tests first loses its AI changes, then all of them, and is reported. Ctrl-C during this puts every file back.

## AI providers

- **auto (default):** if Ollama answers at `--ollama-url` and has `--model`, use it. Otherwise use the built-in model. If the AI can't be used (the user declines the download, there's no space, or the machine can't run it), print one yellow line saying so and how to enable it, and **continue with the deterministic rules**; this never changes the exit code. In a non-interactive run (no TTY, e.g. CI or `--check`), never prompt: use the built-in model only if it's already downloaded or `--yes` is given.
- **builtin:** an in-process model via `node-llama-cpp`. Default model: a small code model (Qwen2.5-Coder 1.5B Instruct, GGUF Q4_K_M, about 1 GB) that runs on ordinary laptops without a GPU, using Metal/CUDA/Vulkan when available. Downloaded once on first use, after asking (show the size; `--yes` skips the question), with a progress bar, into the user cache directory (`~/.cache/de-crapify/models`, or the platform equivalent); verified by size/checksum; resumed or re-downloaded if incomplete. Same chat interface, `temperature: 0`, and `--num-ctx` as Ollama; the per-chunk timeout is 300s (it may run on CPU only). Exact file: `qwen2.5-coder-1.5b-instruct-q4_k_m.gguf` from `Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF` on Hugging Face, 1,117,320,768 bytes, SHA-256 `cc324af0…6933bb046`. `DE_CRAPIFY_CACHE_DIR` overrides the cache location.
- **ollama:** as described below. When chosen explicitly with `--ai-provider ollama`, a missing Ollama or model is a setup error (exit 2), as originally specified.

## Ollama client (`src/ollama.js` or similar)

- Before processing any files (unless `--no-ai`), call `GET /api/tags` to check that Ollama is reachable and the chosen model is installed. With `--ai-provider auto`, a failure here just means "use the built-in model"; the messages below apply when Ollama was chosen explicitly.
  - Not reachable: print with `chalk.yellow` that Ollama doesn't seem to be running, suggest `ollama serve`, mention `--no-ai` as an alternative, and exit with code 2.
  - Model missing: print the exact `ollama pull <model>` command, list the models that *are* installed, and exit with code 2. Do not silently fall back to another model.
- Use `POST /api/chat` with `stream: false`, a system message plus a user message, and `options: { temperature: 0, num_ctx: <--num-ctx> }`.
- Add a per-request timeout (120s with `AbortController`; the preflight uses 5s). On timeout or error for one chunk, skip that chunk and continue; don't crash the run. Failed requests are counted in the summary's AI line, not as rejected suggestions.
- A model name without a tag means `:latest`, as in Ollama. Never match a different tag.
- Write the system prompt as a separate exported constant so it's easy to tune. It should be strict and specific: return only code, no explanations, no markdown fences; list exactly what may and may not be changed (from Stage 2 above, including the hooks and type-annotation rules); and say that if nothing should change, return the code unchanged. Tell the model the file's language (JS, TS, JSX, TSX) and whether it's React / React Native code.

## Output

- **Dry run (default):** for each changed file, print a Git-style colored diff: file header, hunk headers in cyan, removed lines in red with `-`, added lines in green with `+`, a few lines of unchanged context in dim gray. Under each file, list the reasons (e.g. "removed unused import `useMemo`", "AI: flattened nested conditionals in `handleSubmit`").
- **Reports:** after diffs, list report-only findings grouped by type: likely hallucinated imports, imports that could not be verified, console calls that weren't safe to remove, and god files with their suggested split. Each with file and line.
- **Write mode:** before any other work, if the path is not inside a git repo, or source files under it have uncommitted changes (modified, staged or untracked), and `--force` isn't set, refuse and explain why (so the user can always undo with git). Then apply changes atomically (never overwriting a file that changed on disk during the run) and print a short per-file summary; `--verbose` adds the diff.
- **Always end with a summary:** files scanned, files changed, deterministic fixes, AI fixes accepted, AI suggestions rejected (with counts per rejection reason), report-only findings by type, files skipped and why (unparseable, too large, minified, ignored), and whether the typecheck ran.
- Exit codes: 0 success, 1 cleanups found in `--check` mode, 2 setup error (Ollama/model/bad path).

## Test fixtures and tests

Create a `test-fixtures/` folder with several small fake projects (each with its own `package.json`, and `tsconfig.json` where relevant), containing realistic, messy, AI-style files:

- **react-classic/**: React 16 project, tsconfig `"jsx": "react"`. A component with unused imports, `console.log`s, comments narrating every line, deeply nested `if`s in a submit handler, and a redundant state variable. It imports `React` and only uses it via JSX; the tool must **keep** that import.
- **react-automatic/**: Vite + React 18 project, tsconfig `"jsx": "react-jsx"`. Same kind of mess; here an unused `import React from 'react'` **should** be removed.
- **react-native-expo/**: Expo project with `@/` path aliases in tsconfig `paths`, a `Button.ios.tsx` + `Button.android.tsx` pair imported as `./Button`, an image `require('./assets/logo.png')`, `__DEV__` usage, and an `onPress={() => console.log('pressed')}`. None of the imports should be flagged, and the inline console call must be reported, not removed.
- **god-file/**: one `.tsx` file with four components, two helpers each used by only one component, and ~450 lines. Expect a god-file report with a sensible suggested split. Also include a `utils.ts` with ~15 small independent helpers that must **not** be flagged.
- **node-api/**: Express route file with a duplicated validation block, a hallucinated package import, an import of a relative file that doesn't exist, and a `.js` import that resolves to a `.ts` file (must not be flagged).
- **monorepo/**: root `package.json` with workspaces and hoisted deps; a package whose own `package.json` doesn't list a dependency that the root does. Must not be flagged.
- **ts-utils/**: TypeScript file with type-only imports (must NOT be removed), decorators, a generic arrow function in a `.ts` file, a `console.error` (kept), a `@ts-expect-error` comment, and a `// de-crapify-keep` block.
- A file with `// de-crapify-ignore-file`.

For each fixture that has runnable logic, include a small test that checks its behavior, so we can verify behavior is unchanged before and after cleanup. No `react`/`express` dev dependencies: keep runnable logic (validation helpers, submit-handler logic) in plain functions with no third-party imports and behavior-test those; for React/TS parts, test that they still parse and that the expected diff is produced.

Tests copy each fixture project into a temporary directory before running, so project-context lookups (walking up for `package.json` / `node_modules`) can't leak into de-crapify's own `package.json`.

Unit tests should cover: parser settings per extension, file discovery and ignore rules, project context loading (aliases, `extends`, monorepo deps, JSX runtime detection), each deterministic rule (including every "must not remove" and "must not flag" case above), every validation check (feed in deliberately bad "AI output", including a hook moved into an `if`, a hook after an early return, a changed `useEffect` dependency array, a removed `@ts-expect-error`, an invented helper function, a new global reference, a changed string literal, an edited `de-crapify-keep` statement, and a changed parameter type, and confirm each is rejected), fence stripping, and the Ollama client's error paths using a mocked `fetch`.

## Phases

1. **Scaffold:** package.json, CLI with all flags parsed, parser setup per extension, file discovery and ignore rules, diff printer (test it with a hardcoded fake change), summary output. Tests.
2. **Project context:** package/workspace/alias/JSX-runtime/TypeScript detection, with the fixture projects. Tests.
3. **Deterministic rules:** the four Stage 1 rules, `de-crapify-keep` handling, report output, `--no-ai` working end to end. Tests.
4. **Validation module:** all Stage 3 per-chunk checks as pure functions, heavily tested with bad inputs. Then the typecheck step.
5. **Ollama integration:** client, preflight check, chunking, system prompt, wiring AI → validation → diff. Tests with mocked fetch. Then I'll try it against a real local model.
6. **More deterministic rules:** Stage 1 rules 5–8 (narrating comments, needless nesting, unneeded `else`, redundant return variable), edits that replace text (not only remove it), and repeated passes. Tests, including behavior tests on the fixtures.
7. **Built-in model and provider selection:** `node-llama-cpp` provider with the one-time download (consent, progress, cache, verification), `--ai-provider`, `--yes`, automatic fallback, and non-interactive behavior. Tests without downloading a real model (the model loader is injectable), plus one opt-in test that uses the real model.
8. **Write mode and polish:** `--write`, git dirty check, `--test-cmd` with revert, `--check` exit codes, README with install, usage, a "how it stays safe" section, supported/unsupported code, and limitations.

Remember to stop after each phase and wait for me.

## Later (do NOT build now): bring-your-own-key cloud provider

An opt-in `--ai-provider` for a hosted model (e.g. Claude) using the user's own API key, for people who want stronger suggestions and accept sending code to that provider. Never the default; the same validation applies to every suggestion.

## Later (do NOT build now): `de-crapify split`

Recorded here so the v1 architecture leaves room for it. Keep the god-file analysis (dependency grouping between top-level declarations) in its own module so this command can reuse it.

Planned design: for a flagged god file, the AI proposes a **plan only** as structured JSON (which declarations go to which new file, and the new file names, following the project's existing naming style). Plain code then performs the move exactly: create the new files, move declarations verbatim, add exports, add imports in the original file, and update imports in every other project file that imported the moved names. Refuse plans that would create circular imports. Validate with a full-project parse, `tsc --noEmit`, and `--test-cmd`, and revert everything if any check fails. Dry run by default, showing the plan and all diffs.
