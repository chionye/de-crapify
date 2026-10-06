import MagicString from 'magic-string';
import { resolveJsxRuntime } from '../context/jsx-runtime.js';
import { findKeepRanges } from '../keep.js';
import { parseCode } from '../parse.js';
import { consoleCallsRule } from './console-calls.js';
import { godFileRule } from './god-files.js';
import { overlaps } from './shared.js';
import { unresolvableImportsRule } from './unresolvable-imports.js';
import { unusedImportsRule } from './unused-imports.js';

/**
 * @typedef {object} DeterministicResult
 * @property {string} output                 The cleaned source (identical to the input if nothing changed).
 * @property {string[]} reasons              One per fix, e.g. "removed unused import `useMemo` from 'react'".
 * @property {import('./shared.js').RuleReport[]} reports  Report-only findings (line numbers refer to the input).
 * @property {string[]} notes                Extra information for --verbose.
 * @property {import('./shared.js').Range[]} keepRanges
 */

/**
 * Stage 1: run the deterministic rules on one parsed file.
 *
 * All rules look at the original AST; edits are applied together in one pass with magic-string so
 * untouched code keeps its exact formatting. The result is parsed again as a safety net: if it
 * doesn't parse, every edit is dropped and the file is left alone.
 *
 * @param {object} input
 * @param {string} input.source
 * @param {import('@babel/types').File} input.ast
 * @param {string} input.filePath
 * @param {import('../context/index.js').DirContext} input.ctx
 * @param {import('../context/files.js').FileCache} input.files
 * @param {{ keepConsole: Set<string> }} input.options
 * @returns {Promise<DeterministicResult>}
 */
export async function runDeterministicRules({ source, ast, filePath, ctx, files, options }) {
  const notes = [];
  const keepRanges = findKeepRanges(ast, source);

  const consoleResult = consoleCallsRule({ ast, source, keepConsole: options.keepConsole, keepRanges });

  const jsxRuntime = resolveJsxRuntime(ctx.jsxRuntime, source);
  const importsResult = unusedImportsRule({
    ast,
    source,
    keepRanges,
    // References inside console calls that are being removed don't keep an import alive.
    removedRanges: consoleResult.edits,
    jsxRuntime: jsxRuntime.runtime,
  });
  if (importsResult.skipReason) notes.push(`unused imports not checked: ${importsResult.skipReason}`);

  const unresolved = await unresolvableImportsRule({
    ast,
    filePath,
    ctx,
    files,
    // An unused import that's being removed doesn't need a report.
    ignoreNodes: new Set(importsResult.removedDeclarations),
  });
  const godFile = godFileRule({ ast, source, filePath });

  const edits = mergeEdits([...consoleResult.edits, ...importsResult.edits], keepRanges);
  const reasons = [...importsResult.reasons, ...consoleResult.reasons];
  const reports = [...unresolved.reports, ...consoleResult.reports, ...godFile.reports].sort((a, b) => a.line - b.line);

  let output = source;
  if (edits.length > 0) {
    const ms = new MagicString(source);
    for (const edit of edits) ms.remove(edit.start, edit.end);
    output = ms.toString();
    const check = parseCode(output, filePath);
    if (!check.ok) {
      notes.push(`deterministic edits produced code that does not parse (${check.error.message}); file left unchanged`);
      return { output: source, reasons: [], reports, notes, keepRanges };
    }
  }
  return { output, reasons, reports, notes, keepRanges };
}

/**
 * Sort edits and drop any that overlap an earlier one or a protected range.
 * @param {import('./shared.js').Edit[]} edits
 * @param {import('./shared.js').Range[]} keepRanges
 */
function mergeEdits(edits, keepRanges) {
  const sorted = edits.filter((e) => e.end > e.start).sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const edit of sorted) {
    if (keepRanges.some((r) => overlaps(r, edit))) continue;
    const last = merged[merged.length - 1];
    if (last && edit.start < last.end) continue;
    merged.push(edit);
  }
  return merged;
}
