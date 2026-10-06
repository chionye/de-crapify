import path from 'node:path';

/**
 * The system prompt for the cleanup model. Kept strict and specific: small local models follow
 * concrete rules much better than general advice. Every rule here is also enforced by validation,
 * so a model that ignores one just gets its suggestion rejected.
 */
export const SYSTEM_PROMPT = `You clean up JavaScript and TypeScript code that was written by AI coding assistants.
You receive exactly ONE top-level declaration (a function, class, component, or exported value) and return a cleaned-up version of that same declaration.

OUTPUT FORMAT
- Return ONLY the code. No explanations, no notes, no markdown, no code fences.
- Return the complete declaration, from its first line to its last line.
- If nothing should change, return the code exactly as you received it.
- Do not reformat code you are not changing: keep its indentation, quotes and line breaks.

YOU MAY ONLY
1. Remove comments that merely restate what the code obviously does, e.g. "// Set loading to true" above setLoading(true), or "// Return the result" above a return.
2. Flatten unnecessary nesting, e.g. replace deeply nested if/else with early returns or combined conditions.
3. Remove redundant intermediate variables, e.g. "const result = compute(); return result;" becomes "return compute();".
4. Merge logic that is clearly duplicated within this declaration.

YOU MUST NOT
- Rename the declaration, its parameters, or anything that may be used outside it.
- Change the parameters, their default values, any type annotation, the return type, or whether it is async or a generator.
- Change what is returned or thrown, or any side effect: calls, mutations, logging, network requests, timers, ordering of effects.
- Change any string, number or regular expression, including UI text and error messages.
- Add imports, dependencies, helper functions, new features, or new top-level code.
- Use any identifier that does not already appear in the code, unless you declare it inside the declaration.
- Remove or edit JSDoc comments (/** ... */), license headers, or comments that explain WHY something is done.
- Remove or move "@ts-ignore", "@ts-expect-error" or "eslint-disable" comments. Each must stay directly above, or on, the same line of code.
- Change a statement that follows a "// de-crapify-keep" comment, or remove that comment.

REACT RULES (when the code is a React component or hook)
- Do not add, remove, reorder or move hook calls (useState, useEffect, useMemo, useCallback, useRef, any useXxx).
- Every hook call must stay at the top level of the component or hook body: never inside a condition, loop or nested function.
- Do not add an early return before any hook call.
- Do not change dependency arrays (the [...] argument of useEffect, useMemo, useCallback and similar).`;

/**
 * A human-readable language label for the prompt.
 * @param {string} filePath
 * @param {boolean} hasJsx
 */
export function languageLabel(filePath, hasJsx) {
  const ext = path.extname(filePath);
  if (ext === '.tsx') return 'TypeScript with JSX (TSX)';
  if (ext === '.jsx') return 'JavaScript with JSX (JSX)';
  if (['.ts', '.mts', '.cts'].includes(ext)) return 'TypeScript';
  return hasJsx ? 'JavaScript with JSX' : 'JavaScript';
}

/**
 * The user message for one chunk: what file and language it is, what it may reference, and the code.
 *
 * @param {object} input
 * @param {string} input.code               The declaration to clean up.
 * @param {string} input.displayPath        File path shown to the model.
 * @param {string} input.language           From {@link languageLabel}.
 * @param {'react-native' | 'react' | null} input.framework
 * @param {string[]} input.imports          The file's import statements, as written.
 * @param {string[]} input.otherDeclarations  Names of the file's other top-level declarations.
 */
export function buildUserMessage({ code, displayPath, language, framework, imports, otherDeclarations }) {
  const lines = [`File: ${displayPath}`, `Language: ${language}`];
  if (framework === 'react-native') lines.push('This is React Native code (React rules apply).');
  else if (framework === 'react') lines.push('This is React code (React rules apply).');
  lines.push('');
  lines.push(imports.length ? 'Imports in this file (do not add any):' : 'This file has no imports (do not add any).');
  lines.push(...imports);
  if (otherDeclarations.length) {
    lines.push('');
    lines.push(`Other top-level declarations in this file (you may use them; do not redefine them): ${otherDeclarations.join(', ')}`);
  }
  lines.push('');
  lines.push('Clean up this declaration and return only the code:');
  lines.push('');
  lines.push(code);
  return lines.join('\n');
}
