# de-crapify

Clean up the mess AI coding assistants leave in JavaScript and TypeScript code: unused imports, leftover `console.log`s, comments that just narrate the code, `if` pyramids, needless `else`s, and imports of packages that don't exist.

```diff
-import React, { useState, useEffect, useMemo } from 'react';
+import React, { useState } from 'react';
 ...
-  // State for the email field
   const [email, setEmail] = useState('');
 ...
-    if (Object.keys(result).length === 0) {
-      if (!submitting) {
-        if (email) {
-          if (password) {
-            // Set submitting to true
-            setSubmitting(true);
+    if (Object.keys(result).length === 0 && !submitting && email && password) {
+      setSubmitting(true);
```

It works on React, React Native, Node and plain TS/JS projects, runs entirely on your machine, and **never writes a change it hasn't verified**.

## Quick start

Requires Node.js 20 or newer.

```sh
npx de-crapify clean src            # show what it would change (writes nothing)
npx de-crapify clean src --write    # apply the changes
```

Or add it to a project: `npm install --save-dev de-crapify`.

The first run asks whether to download a small AI model (about 1.1 GB, once). Say no, and everything except the AI cleanup still works.

## What it does

**Cleanups (no AI, instant):**

- Unused imports, including unused `React` imports when the project uses the automatic JSX runtime.
- Debug `console.log` / `debug` / `info` / `trace` / `dir` / `table` calls (`console.error` and `console.warn` are kept).
- Comments that only repeat the next line (`// Set loading to true` above `setLoading(true)`). Comments that explain *why*, `TODO`s, links and the like always stay.
- Nested `if`s merged into one condition; `else { if … }` into `else if`.
- `else` after `return` or `throw`.
- `const result = …; return result;` folded into `return …;`.

**AI cleanups** (a local model, see below): narrating comments the rules aren't sure about, needless nesting the rules don't cover, redundant variables, clearly duplicated logic. Every AI suggestion is checked before it's used (see [How it stays safe](#how-it-stays-safe)).

**Reports (never changed automatically):**

- **Likely hallucinated imports:** packages that aren't installed or listed in any `package.json`, and relative imports of files that don't exist. Path aliases, workspaces, React Native platform files (`Button.ios.tsx`), and `.js` imports of `.ts` files are understood.
- **Imports that could not be verified:** alias-like imports when your bundler config (e.g. `vite.config.ts`) might define aliases de-crapify can't read.
- **Console calls not safe to remove,** e.g. `onPress={() => console.log('x')}`, or calls whose arguments do something.
- **God files:** several large components or unrelated modules in one file, with a suggested split.

## AI: local, private, optional

de-crapify uses a small code model running on your own machine. Your code is never sent anywhere.

- **Built in:** on first use, it asks to download *Qwen2.5-Coder 1.5B Instruct* (1.1 GB, checksum verified, resumable) into your user cache folder (`~/Library/Caches/de-crapify` on macOS, `~/.cache/de-crapify` on Linux, `%LOCALAPPDATA%\de-crapify\Cache` on Windows; override with `DE_CRAPIFY_CACHE_DIR`). It runs on the GPU when available (Metal, CUDA, Vulkan) and on the CPU otherwise.
- **Ollama:** if [Ollama](https://ollama.com) is running with `qwen2.5-coder:7b` (or `--model <name>`), de-crapify uses it instead. Larger models give better suggestions.
- **No AI:** `--no-ai` runs only the rules above. If AI can't be used for any reason (download declined, no network, not enough memory, an unusual platform), de-crapify says so in one line and carries on without it.

In scripts and CI, nothing is ever downloaded without `--yes`.

## Usage

```
de-crapify clean <path> [options]
```

`<path>` is a file or a directory (searched recursively, respecting `.gitignore`).

| Option | Default | |
|---|---|---|
| `--write` | off | Apply the changes. Without it, de-crapify only shows a diff. |
| `--check` | off | CI mode: print a summary, exit 1 if anything would be cleaned or a likely hallucinated import is found. Never writes. |
| `--force` | off | Allow `--write` with uncommitted changes or outside a git repository. |
| `--test-cmd "<cmd>"` | | With `--write`: run your tests after writing; files that break them are changed back. |
| `--no-ai` | AI on | Only the deterministic rules. |
| `--ai-provider <auto\|builtin\|ollama>` | `auto` | `auto` uses Ollama if it's running, else the built-in model. |
| `--yes` | off | Allow the one-time model download without asking. |
| `--model <name>` | `qwen2.5-coder:7b` | Ollama model (implies Ollama). |
| `--ollama-url <url>` | `http://localhost:11434` | Ollama address (implies Ollama). |
| `--num-ctx <n>` | `8192` | AI context window. |
| `--typecheck` / `--no-typecheck` | auto | Check changes with your project's TypeScript (on when there's a `tsconfig.json` and TypeScript is installed). |
| `--max-file-size <kb>` | `200` | Skip larger files. |
| `--keep-console <methods>` | `error,warn` | Console methods never removed. |
| `--verbose` | off | Show every step, including rejected AI suggestions and why. |

Exit codes: `0` success, `1` cleanups found (`--check` only), `2` setup problem (bad path, unsafe `--write`, failing baseline tests, requested AI provider unavailable).

### In CI

```sh
npx de-crapify clean src --check --no-ai
```

`--check` fails the build for cleanups and likely hallucinated imports. "Could not verify" imports, unsafe console calls and god files are reported but don't fail it.

### Keeping code as it is

```js
// de-crapify-keep
console.log('this stays');   // the statement after the marker is never touched
```

A file containing `// de-crapify-ignore-file` is skipped entirely, and so are files marked `@generated`, minified files, `.d.ts` files, `node_modules`, `dist`, `build` and the like.

## How it stays safe

The AI suggests, the code verifies. de-crapify assumes a model *will* sometimes break code, and never trusts its output:

1. **Rules are safe by construction.** Each one only makes changes that can't alter behavior. For example, it never removes a console call whose arguments do something, and never lifts code out of an `else` if that could shadow another name. Every change is all-or-nothing, and the result must parse or the file is left alone.
2. **Every AI suggestion is validated** before it's used. It's rejected if it:
   - changes a name, signature, export or type annotation;
   - uses any identifier the original didn't;
   - moves or reorders a React hook, or changes a dependency array;
   - drops a `@ts-expect-error` or `eslint-disable` comment;
   - changes any string or number;
   - shrinks or grows suspiciously.
3. **Your type checker** (if the project has TypeScript) must report no new errors, using the project's own TypeScript. A file that adds errors loses its AI changes first, then all of them.
4. **Your tests** (`--test-cmd`) must still pass. A file that breaks them is changed back the same way.
5. **Nothing is written without `--write`**, and `--write` refuses to run unless your work is committed, so every change can be reviewed with `git diff` and undone with `git restore`.

When in doubt, de-crapify leaves the code alone: a missed cleanup is fine, a broken file is not.

## Supported code

- `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`, including JSX in `.js` files and React Native platform files.
- TypeScript, decorators (including NestJS-style parameter decorators), top-level `await`, import attributes.
- Monorepos (npm, yarn and pnpm workspaces), tsconfig `paths` and `extends`, Babel `module-resolver` aliases.

Not supported: Vue, Svelte and Astro files, and Flow.

## Limitations

- The built-in model is small. It's careful but limited; Ollama with a larger model makes more and better suggestions.
- AI cleanup works on whole top-level functions, classes and components; code at the top level of a file is left to the rules.
- Aliases defined only in JavaScript config files (`vite.config.ts`, `webpack.config.js`, `babel.config.js`) can't be read, so such imports are reported as "could not verify" rather than checked.
- The type check runs your project's own TypeScript, which is code from your project. With TypeScript 7 or newer it uses the `tsc` binary, so it only runs with `--write`.
- God files are reported, not split.

## Notes

- The AI part uses the optional dependency [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp) (prebuilt binaries; about 55 MB on macOS, more on Linux because of the GPU variants). If it can't be installed on your machine, de-crapify still installs and works without built-in AI.
- `npm audit` currently reports an advisory in `simple-git`, a dependency of `node-llama-cpp` that is only used to compile llama.cpp from source. de-crapify never compiles anything, so that code never runs.

## License

ISC
# de-crapify
