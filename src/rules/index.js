import MagicString from 'magic-string';
import { resolveJsxRuntime } from '../context/jsx-runtime.js';
import { findKeepRanges } from '../keep.js';
import { parseCode } from '../parse.js';
import { consoleCallsRule } from './console-calls.js';
import { godFileRule } from './god-files.js';
import { loggingCommentEdits, narratingCommentsRule } from './narrating-comments.js';
import { nestingRules } from './nesting.js';
import { returnVariableRule } from './return-variable.js';
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

/** Upper bound on structural passes (each one can expose more work for the next). */
export const MAX_STRUCTURAL_PASSES = 5;

/**
 * Stage 1: run the deterministic rules on one parsed file.
 *
 * Pass 1 runs the console and import rules and all reports on the original AST (so report line
 * numbers match the file on disk). Then the structural rules (narrating comments, nesting, `else`
 * after `return`, return variables) run in repeated passes until nothing changes, since one
 * transform can expose another. Edits are applied with magic-string so untouched code keeps its
 * exact formatting, and every pass must produce code that parses: if one doesn't, its edits are
 * dropped and the last good version is kept.
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
  const reports = [...unresolved.reports, ...consoleResult.reports, ...godFile.reports].sort((a, b) => a.line - b.line);

  // Pass 1: console calls (plus the "// log the value" comments above them) and imports.
  const loggingComments = loggingCommentEdits({ ast, source, removed: consoleResult.edits, keepRanges });
  const pass1 = applyEdits(source, mergeEdits([...consoleResult.edits, ...loggingComments, ...importsResult.edits], keepRanges, source), filePath);
  if (!pass1.ok) {
    notes.push(`deterministic edits produced code that does not parse (${pass1.error}); file left unchanged`);
    return { output: source, reasons: [], reports, notes, keepRanges };
  }
  const reasons = [...importsResult.reasons, ...consoleResult.reasons, ...loggingComments.map((e) => /** @type {string} */ (e.reason))];

  // Passes 2+: structural rules until nothing changes.
  let output = pass1.output;
  for (let pass = 0; pass < MAX_STRUCTURAL_PASSES; pass++) {
    const parsed = parseCode(output, filePath);
    if (!parsed.ok) break;
    const passKeep = findKeepRanges(parsed.ast, output);
    const candidates = [
      ...narratingCommentsRule({ ast: parsed.ast, source: output, keepRanges: passKeep }),
      ...nestingRules({ ast: parsed.ast, source: output, keepRanges: passKeep }),
      ...returnVariableRule({ ast: parsed.ast, source: output, keepRanges: passKeep }),
    ];
    const edits = mergeEdits(candidates, passKeep, output);
    if (edits.length === 0) break;
    const next = applyEdits(output, edits, filePath);
    if (!next.ok) {
      notes.push(`a structural rule produced code that does not parse (${next.error}); kept the previous version`);
      break;
    }
    output = next.output;
    reasons.push(...edits.map((e) => /** @type {string} */ (e.reason)));
  }

  return { output, reasons, reports, notes, keepRanges };
}

/**
 * Apply non-overlapping edits and check the result still parses.
 * @param {string} source
 * @param {import('./shared.js').Edit[]} edits
 * @param {string} filePath
 * @returns {{ ok: true, output: string } | { ok: false, error: string }}
 */
function applyEdits(source, edits, filePath) {
  if (edits.length === 0) return { ok: true, output: source };
  const ms = new MagicString(source);
  for (const edit of edits) {
    if (edit.text === undefined) ms.remove(edit.start, edit.end);
    else if (edit.end > edit.start) ms.update(edit.start, edit.end, edit.text);
    else ms.appendLeft(edit.start, edit.text);
  }
  const output = ms.toString();
  const check = parseCode(output, filePath);
  return check.ok ? { ok: true, output } : { ok: false, error: check.error.message };
}

/**
 * Sort edits, drop any that overlap an earlier one or a protected range, and join removals that
 * touch (a comment line and the console call below it) so no double blank line is left behind.
 * @param {import('./shared.js').Edit[]} edits
 * @param {import('./shared.js').Range[]} keepRanges
 * @param {string} [source]
 */
function mergeEdits(edits, keepRanges, source) {
  const sorted = edits.filter((e) => e.end > e.start || e.text).sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const edit of sorted) {
    if (keepRanges.some((r) => overlaps(r, edit))) continue;
    const last = merged[merged.length - 1];
    if (last && edit.start < last.end) continue;
    if (source && last && last.text === undefined && edit.text === undefined && edit.start === last.end) {
      last.end = collapseBlankLine(source, last.start, edit.end);
      continue;
    }
    merged.push({ ...edit });
  }
  return merged;
}

/**
 * If removing `start..end` (whole lines) leaves a blank line directly above and below, also remove
 * the one below. Returns the new end.
 * @param {string} source
 * @param {number} start
 * @param {number} end
 */
function collapseBlankLine(source, start, end) {
  const prevLineStart = source.lastIndexOf('\n', start - 2) + 1;
  const prevBlank = start > 0 && source[start - 1] === '\n' && source.slice(prevLineStart, start - 1).trim() === '';
  const nextLineEnd = source.indexOf('\n', end);
  const nextBlank = nextLineEnd !== -1 && source.slice(end, nextLineEnd).trim() === '';
  return prevBlank && nextBlank ? nextLineEnd + 1 : end;
}
