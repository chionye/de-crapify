import _traverse from '@babel/traverse';

/** @babel/traverse is CommonJS; under ESM its function is on `.default`. */
export const traverse = /** @type {typeof import('@babel/traverse').default} */ (
  /** @type {any} */ (_traverse).default ?? _traverse
);

/**
 * @typedef {{ start: number, end: number }} Range
 * @typedef {{ start: number, end: number }} Edit  A range of the original source to remove.
 * @typedef {import('../output/summary.js').ReportType} ReportType
 * @typedef {{ type: ReportType, line: number, message: string }} RuleReport
 */

/**
 * Widen a removal range to whole lines when the removed code is alone on its line(s), so removing
 * a statement doesn't leave a blank, indented line behind. Otherwise, when the code is at the end
 * of a line, also drop the whitespace before it.
 *
 * @param {string} source
 * @param {number} start
 * @param {number} end
 * @returns {Range}
 */
export function lineAwareRange(source, start, end) {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = source.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = source.length;
  const before = source.slice(lineStart, start);
  const after = source.slice(end, lineEnd);
  const aloneBefore = /^[ \t]*$/.test(before);
  const aloneAfter = /^[ \t]*\r?$/.test(after);

  if (aloneBefore && aloneAfter) {
    let removeEnd = lineEnd < source.length ? lineEnd + 1 : lineEnd;
    // Don't leave two blank lines where the removed code used to separate them.
    const prevLineStart = source.lastIndexOf('\n', lineStart - 2) + 1;
    const prevBlank = lineStart > 0 && /^[ \t]*\r?$/.test(source.slice(prevLineStart, lineStart - 1));
    const nextLineEnd = source.indexOf('\n', removeEnd);
    const nextBlank = removeEnd < source.length && nextLineEnd !== -1 && /^[ \t]*\r?$/.test(source.slice(removeEnd, nextLineEnd));
    if (prevBlank && nextBlank) removeEnd = nextLineEnd + 1;
    return { start: lineStart, end: removeEnd };
  }
  if (aloneAfter) {
    // `foo(); console.log(x);` → `foo();`
    let s = start;
    while (s > lineStart && /[ \t]/.test(source[s - 1])) s--;
    return { start: s, end: end + (after.endsWith('\r') ? after.length - 1 : after.length) };
  }
  // Something follows on the same line: also eat the whitespace after the removed code.
  let e = end;
  while (e < lineEnd && /[ \t]/.test(source[e])) e++;
  return { start, end: e };
}

/** @param {Range} a @param {Range} b */
export function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

/** @param {Range} inner @param {Range[]} ranges */
export function insideAny(inner, ranges) {
  return ranges.some((r) => inner.start >= r.start && inner.end <= r.end);
}

/**
 * Short single-line preview of a code snippet for messages: `console.log('render', n)`.
 * @param {string} code
 * @param {number} [max]
 */
export function preview(code, max = 60) {
  const oneLine = code.replace(/\s*\n\s*/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Whether an Identifier is in a position that can refer to a binding. Deliberately generous: only
 * positions that clearly can't (property names, keys, labels) are excluded.
 *
 * @param {import('@babel/traverse').NodePath<import('@babel/types').Identifier>} path
 */
export function isReferencePosition(path) {
  const { node, parent } = path;
  switch (parent.type) {
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return parent.object === node || parent.computed;
    case 'ObjectProperty':
      return parent.value === node || parent.computed;
    case 'ObjectMethod':
    case 'ClassMethod':
    case 'ClassPrivateMethod':
    case 'ClassProperty':
    case 'ClassAccessorProperty':
    case 'TSPropertySignature':
    case 'TSMethodSignature':
    case 'TSDeclareMethod':
    case 'TSAbstractMethodDefinition':
      return parent.key !== node || Boolean(/** @type {any} */ (parent).computed);
    case 'TSQualifiedName':
      return parent.left === node;
    case 'TSEnumMember':
      return parent.id !== node;
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return false;
    case 'MetaProperty':
      return false;
    case 'ExportSpecifier':
      // `export { x as y } from 'mod'` re-exports; `export { x }` uses the local `x`.
      return path.parentPath?.parent.type === 'ExportNamedDeclaration' && !path.parentPath.parent.source && parent.local === node;
    default:
      return true;
  }
}

/**
 * How a JSXIdentifier refers to a binding: as an element name (`<Button>`), as the object of a
 * member tag (`<Foo.Bar>`, `<motion.div>`), or not at all (attribute names, member properties).
 *
 * @param {import('@babel/traverse').NodePath<import('@babel/types').JSXIdentifier>} path
 * @returns {'tag' | 'member' | null}
 */
export function jsxReferenceKind(path) {
  const { node, parent } = path;
  if ((parent.type === 'JSXOpeningElement' || parent.type === 'JSXClosingElement') && parent.name === node) return 'tag';
  if (parent.type === 'JSXMemberExpression' && parent.object === node) return 'member';
  return null;
}
