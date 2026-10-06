import { parse } from '@babel/parser';
import { findKeepRanges } from '../keep.js';
import {
  canonical,
  chunkSignature,
  directiveComments,
  freeIdentifiers,
  hookCalls,
  literalValues,
  strippedLength,
  topLevelNames,
} from './analysis.js';
import { extractCode } from './fences.js';

/** Size check bounds, on code with comments and whitespace stripped. Easy to tune. */
export const SIZE_LIMITS = Object.freeze({
  /** Reject rewrites shorter than this fraction of the original (more than ~60% shorter). */
  MIN_RATIO: 0.4,
  /** Reject rewrites longer than this fraction of the original. */
  MAX_RATIO: 1.0,
});

/** Short labels per check, used to group rejections in the summary. */
export const CHECKS = Object.freeze({
  empty: 'no code in reply',
  truncated: 'reply was cut off',
  parse: 'does not parse',
  keep: 'changed de-crapify-keep code',
  topLevel: 'changed top-level names or exports',
  signature: 'changed name or signature',
  identifiers: 'uses new identifiers',
  hooks: 'breaks the rules of hooks',
  directives: 'dropped or moved a @ts-/eslint directive',
  literals: 'changed literal values',
  size: 'suspicious size change',
});

/** @typedef {keyof typeof CHECKS} CheckId */

/**
 * @typedef {{ ok: true, changed: false }} Unchanged
 * @typedef {{ ok: true, changed: true, code: string, fileSource: string }} Accepted
 * @typedef {{ ok: false, check: CheckId, reason: string }} Rejected
 * @typedef {Unchanged | Accepted | Rejected} ValidationResult
 */

/**
 * Stage 3: validate an AI rewrite of one chunk of a file. Pure: no I/O.
 *
 * Every check must pass. A rewrite that means the same code as the original (only formatting
 * differs) is reported as unchanged so formatting churn never reaches the diff.
 *
 * @param {object} input
 * @param {string} input.fileSource        The file the chunk lives in (after Stage 1).
 * @param {{ start: number, end: number }} input.chunk  The chunk's range in fileSource.
 * @param {string} input.reply             The model's raw reply.
 * @param {string | undefined} input.doneReason  Ollama's `done_reason`.
 * @param {import('@babel/parser').ParserOptions} input.parserOptions  The settings the file parsed with.
 * @returns {ValidationResult}
 */
export function validateRewrite({ fileSource, chunk, reply, doneReason, parserOptions }) {
  const reject = (/** @type {CheckId} */ check, /** @type {string} */ reason) => /** @type {Rejected} */ ({ ok: false, check, reason });
  const original = fileSource.slice(chunk.start, chunk.end);

  // 2. (checked first: a truncated reply is never worth parsing)
  if (doneReason !== 'stop') return reject('truncated', `done_reason was "${doneReason ?? 'missing'}", not "stop"`);

  // 1. Fences and prose.
  const code = extractCode(reply, parserOptions);
  if (code === null) return reject('empty', 'the reply contained no code');

  // 3. Parses alone, and in the file.
  const origAst = parseOrNull(original, parserOptions);
  if (!origAst) return reject('parse', 'the original chunk does not parse on its own');
  const newAst = parseOrNull(code, parserOptions);
  if (!newAst) return reject('parse', 'the rewrite does not parse on its own');

  if (canonical(newAst.program) === canonical(origAst.program) && sameComments(origAst, newAst)) {
    return { ok: true, changed: false };
  }

  const newFile = fileSource.slice(0, chunk.start) + code + fileSource.slice(chunk.end);
  const origFileAst = parseOrNull(fileSource, parserOptions);
  const newFileAst = parseOrNull(newFile, parserOptions);
  if (!newFileAst) return reject('parse', 'the file does not parse with the rewrite in place');

  // 10. Kept statements byte-identical.
  for (const range of findKeepRanges(origAst, original)) {
    const kept = original.slice(range.start, range.end);
    if (!code.includes(kept)) return reject('keep', `a de-crapify-keep statement was changed: ${firstLine(kept)}`);
  }

  // 4. Top-level names and exports of the whole file.
  if (origFileAst) {
    const before = topLevelNames(origFileAst);
    const after = topLevelNames(newFileAst);
    const declaredDiff = listDiff(before.declared, after.declared);
    if (declaredDiff) return reject('topLevel', `top-level declarations changed (${declaredDiff})`);
    const exportedDiff = listDiff(before.exported, after.exported);
    if (exportedDiff) return reject('topLevel', `exports changed (${exportedDiff})`);
  }

  // 5. Name and signature.
  const sigBefore = chunkSignature(origAst);
  const sigAfter = chunkSignature(newAst);
  if (sigBefore && sigAfter) {
    if (sigBefore.name !== sigAfter.name) return reject('signature', `name changed from \`${sigBefore.name}\` to \`${sigAfter.name}\``);
    const keys = new Set([...Object.keys(sigBefore.parts), ...Object.keys(sigAfter.parts)]);
    for (const key of keys) {
      if (sigBefore.parts[key] !== sigAfter.parts[key]) return reject('signature', `\`${sigBefore.name}\`: ${key} changed`);
    }
  }

  // 6. No new free identifiers.
  const freeBefore = freeIdentifiers(origAst);
  const invented = [...freeIdentifiers(newAst)].filter((name) => !freeBefore.has(name));
  if (invented.length) {
    return reject('identifiers', `references ${invented.map((n) => `\`${n}\``).join(', ')}, which the original did not use and the rewrite does not declare`);
  }

  // 7. Rules of hooks.
  const hooksBefore = hookCalls(origAst);
  const hooksAfter = hookCalls(newAst);
  const namesBefore = hooksBefore.map((h) => h.name);
  const namesAfter = hooksAfter.map((h) => h.name);
  if (namesBefore.join() !== namesAfter.join()) {
    return reject('hooks', `hook calls changed from [${namesBefore.join(', ')}] to [${namesAfter.join(', ')}]`);
  }
  for (let i = 0; i < hooksAfter.length; i++) {
    if (hooksAfter[i].violation && !hooksBefore[i].violation) {
      return reject('hooks', `\`${hooksAfter[i].name}\` (hook #${i + 1}) is now ${hooksAfter[i].violation}`);
    }
    if (hooksAfter[i].deps !== hooksBefore[i].deps) {
      return reject('hooks', `the dependency array of \`${hooksAfter[i].name}\` (hook #${i + 1}) changed`);
    }
  }

  // 8. Directive comments kept and still attached to the same code.
  const directivesAfter = directiveComments(code, newAst);
  for (const directive of directiveComments(original, origAst)) {
    const index = directivesAfter.indexOf(directive);
    if (index === -1) return reject('directives', `missing or moved: ${directive.split(' → ')[0]}`);
    directivesAfter.splice(index, 1);
  }

  // 9. Literals: the rewrite's values must be a sub-multiset of the original's.
  const literalsBefore = literalValues(origAst);
  for (const [value, count] of literalValues(newAst)) {
    if (count > (literalsBefore.get(value) ?? 0)) return reject('literals', `new or changed literal ${value}`);
  }

  // 11. Size, ignoring comments and whitespace.
  const sizeBefore = strippedLength(original, origAst);
  const sizeAfter = strippedLength(code, newAst);
  if (sizeBefore > 0) {
    const ratio = sizeAfter / sizeBefore;
    if (ratio > SIZE_LIMITS.MAX_RATIO) return reject('size', `the rewrite is longer than the original (${Math.round(ratio * 100)}%)`);
    if (ratio < SIZE_LIMITS.MIN_RATIO) return reject('size', `the rewrite is ${Math.round((1 - ratio) * 100)}% shorter than the original`);
  }

  return { ok: true, changed: true, code, fileSource: newFile };
}

/** @param {string} code @param {import('@babel/parser').ParserOptions} parserOptions */
function parseOrNull(code, parserOptions) {
  try {
    return parse(code, parserOptions);
  } catch {
    return null;
  }
}

/** @param {import('@babel/types').File} a @param {import('@babel/types').File} b */
function sameComments(a, b) {
  const text = (/** @type {import('@babel/types').File} */ ast) => (ast.comments ?? []).map((c) => c.value.trim()).join('\n');
  return text(a) === text(b);
}

/** Human-readable difference between two sorted name lists, or '' when equal. */
function listDiff(/** @type {string[]} */ before, /** @type {string[]} */ after) {
  const removed = before.filter((n) => !after.includes(n));
  const added = after.filter((n) => !before.includes(n));
  if (removed.length === 0 && added.length === 0 && before.length === after.length) return '';
  const parts = [];
  if (removed.length) parts.push(`removed ${removed.join(', ')}`);
  if (added.length) parts.push(`added ${added.join(', ')}`);
  if (!parts.length) parts.push('a name now appears a different number of times');
  return parts.join('; ');
}

/** @param {string} text */
function firstLine(text) {
  const line = text.split('\n').find((l) => l.trim() && !l.trim().startsWith('//')) ?? text;
  return line.trim().slice(0, 60);
}
