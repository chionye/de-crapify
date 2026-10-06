import { insideAny, isReferencePosition, jsxReferenceKind, lineAwareRange, overlaps, traverse } from './shared.js';

/**
 * Why a file is skipped entirely by this rule, or null. Files using `eval` or `with` can reference
 * any name dynamically; files with a JSX pragma (`@jsx h`) use an import implicitly.
 *
 * @param {import('@babel/types').File} ast
 * @returns {string | null}
 */
export function unusedImportsSkipReason(ast) {
  for (const comment of ast.comments ?? []) {
    if (/@jsx\s+\S/.test(comment.value)) return 'file has a JSX pragma comment';
  }
  let reason = null;
  traverse(ast, {
    noScope: true,
    WithStatement(path) {
      reason = 'file uses `with`';
      path.stop();
    },
    Identifier(path) {
      if (path.node.name === 'eval' && isReferencePosition(path)) {
        reason = 'file uses `eval`';
        path.stop();
      }
    },
  });
  return reason;
}

/**
 * Rule 1: remove import specifiers whose local name is never used, and whole import statements
 * when none of their specifiers are used.
 *
 * Usage is counted generously: any identifier with the same name in a reference position (value,
 * type, JSX, export) counts, as does the name appearing inside a JSDoc comment. Overcounting only
 * means an import is kept, which is always safe.
 *
 * @param {object} input
 * @param {import('@babel/types').File} input.ast
 * @param {string} input.source
 * @param {import('./shared.js').Range[]} input.keepRanges
 * @param {import('./shared.js').Range[]} input.removedRanges  Code other rules are removing; references inside don't count.
 * @param {'classic' | 'automatic'} input.jsxRuntime
 * @returns {{ edits: import('./shared.js').Edit[], reasons: string[], removedDeclarations: import('@babel/types').ImportDeclaration[], skipReason: string | null }}
 */
export function unusedImportsRule({ ast, source, keepRanges, removedRanges, jsxRuntime }) {
  const result = { edits: [], reasons: [], removedDeclarations: [], skipReason: unusedImportsSkipReason(ast) };
  if (result.skipReason) return result;

  const imports = ast.program.body.filter((s) => s.type === 'ImportDeclaration');
  if (imports.length === 0) return result;

  const { used, hasJsx } = collectUsedNames(ast, removedRanges);
  for (const comment of ast.comments ?? []) {
    if (comment.type === 'CommentBlock' && comment.value.startsWith('*') && !insideAny(comment, removedRanges)) {
      for (const word of comment.value.match(/[A-Za-z_$][\w$]*/g) ?? []) used.add(word);
    }
  }
  const keepReact = hasJsx && jsxRuntime === 'classic';

  for (const decl of /** @type {import('@babel/types').ImportDeclaration[]} */ (imports)) {
    if (decl.specifiers.length === 0) continue; // side-effect import: `import './styles.css'`
    if (keepRanges.some((r) => overlaps(r, decl))) continue;

    const unused = decl.specifiers.filter((spec) => {
      const name = spec.local.name;
      if (keepReact && name === 'React' && spec.type !== 'ImportSpecifier') return false;
      return !used.has(name);
    });
    if (unused.length === 0) continue;

    const names = unused.map((s) => `\`${s.local.name}\``);
    const from = decl.source.value;
    if (unused.length === decl.specifiers.length) {
      result.edits.push(lineAwareRange(source, decl.start, decl.end));
      result.removedDeclarations.push(decl);
    } else {
      result.edits.push(...specifierEdits(decl, new Set(unused), source));
    }
    for (const name of names) result.reasons.push(`removed unused import ${name} from '${from}'`);
  }
  return result;
}

/**
 * Ranges that remove some (not all) specifiers of an import declaration while keeping the rest of
 * its formatting intact (multi-line lists, trailing commas).
 *
 * @param {import('@babel/types').ImportDeclaration} decl
 * @param {Set<import('@babel/types').ImportDeclaration['specifiers'][number]>} unused
 * @param {string} source
 * @returns {import('./shared.js').Edit[]}
 */
function specifierEdits(decl, unused, source) {
  const edits = [];
  const head = decl.specifiers.find((s) => s.type !== 'ImportSpecifier'); // default or namespace
  const named = decl.specifiers.filter((s) => s.type === 'ImportSpecifier');
  const namespace = decl.specifiers.find((s) => s.type === 'ImportNamespaceSpecifier');
  const defaultSpec = decl.specifiers.find((s) => s.type === 'ImportDefaultSpecifier');

  // `import React, * as X from 'y'`: handle the default and namespace pair directly.
  if (defaultSpec && namespace) {
    if (unused.has(defaultSpec)) edits.push({ start: defaultSpec.start, end: namespace.start });
    else edits.push({ start: defaultSpec.end, end: namespace.end });
    return edits;
  }

  const namedKept = named.filter((s) => !unused.has(s));
  const openBrace = named.length > 0 ? source.lastIndexOf('{', named[0].start) : -1;
  const closeBrace = named.length > 0 ? source.indexOf('}', named[named.length - 1].end) : -1;

  if (head && unused.has(head)) {
    // `React, { useState }` → `{ useState }`
    edits.push({ start: head.start, end: openBrace });
  }

  if (named.length > 0 && namedKept.length === 0) {
    // Every named specifier is unused but the default import stays: `React, { a, b }` → `React`.
    edits.push({ start: /** @type {any} */ (head).end, end: closeBrace + 1 });
    return edits;
  }

  // Remove runs of consecutive unused named specifiers.
  let i = 0;
  while (i < named.length) {
    if (!unused.has(named[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < named.length && unused.has(named[j + 1])) j++;
    if (j + 1 < named.length) {
      // A kept specifier follows: remove from this run's start up to it (takes the commas along).
      edits.push({ start: named[i].start, end: named[j + 1].start });
    } else {
      // The run is at the end: remove from the previous kept specifier's end (leaves any trailing comma).
      edits.push({ start: named[i - 1].end, end: named[j].end });
    }
    i = j + 1;
  }
  return edits;
}

/**
 * Names used anywhere in the file in a reference position, ignoring code inside `removedRanges`.
 *
 * @param {import('@babel/types').File} ast
 * @param {import('./shared.js').Range[]} removedRanges
 */
function collectUsedNames(ast, removedRanges) {
  const used = new Set();
  let hasJsx = false;
  traverse(ast, {
    noScope: true,
    ImportDeclaration(path) {
      path.skip(); // the imports themselves aren't usages
    },
    JSXElement() {
      hasJsx = true;
    },
    JSXFragment() {
      hasJsx = true;
    },
    Identifier(path) {
      if (removedRanges.length && insideAny(path.node, removedRanges)) return;
      if (isReferencePosition(path)) used.add(path.node.name);
    },
    JSXIdentifier(path) {
      if (removedRanges.length && insideAny(path.node, removedRanges)) return;
      // Lowercase tags (`<div>`) count too: overcounting is safe, and `<motion.div>` must keep `motion`.
      if (jsxReferenceKind(path)) used.add(path.node.name);
    },
  });
  return { used, hasJsx };
}
