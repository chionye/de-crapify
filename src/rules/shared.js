import _traverse from '@babel/traverse';

/** @babel/traverse is CommonJS; under ESM its function is on `.default`. */
export const traverse = /** @type {typeof import('@babel/traverse').default} */ (
  /** @type {any} */ (_traverse).default ?? _traverse
);

/**
 * @typedef {{ start: number, end: number }} Range
 * @typedef {{ start: number, end: number, text?: string, reason?: string }} Edit
 *   Replace `start..end` of the source with `text` (remove it when there's no text). Rules that can
 *   produce overlapping edits attach their `reason` to the edit, so it only counts if applied.
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

/** Statement-list parents: removing or adding statements in their lists is safe. */
export const STATEMENT_LIST_PARENTS = new Set(['BlockStatement', 'Program', 'SwitchCase', 'StaticBlock', 'TSModuleBlock']);

/**
 * The indentation of the line containing `pos`, or null if there's code before `pos` on that line
 * (the node doesn't start its own line).
 * @param {string} source
 * @param {number} pos
 * @returns {string | null}
 */
export function ownLineIndent(source, pos) {
  const lineStart = source.lastIndexOf('\n', pos - 1) + 1;
  const before = source.slice(lineStart, pos);
  return /^[ \t]*$/.test(before) ? before : null;
}

/**
 * Re-indent a block of text: every line after the first (or every line, with `includeFirst`) that
 * starts with `from` gets that prefix replaced by `to`. Returns null if a non-blank line doesn't
 * start with `from`, i.e. the text isn't indented the way we expect; callers then skip the change.
 * @param {string} text
 * @param {string} from
 * @param {string} to
 * @param {{ includeFirst?: boolean }} [options]
 */
export function reindent(text, from, to, { includeFirst = false } = {}) {
  const lines = text.split('\n');
  for (let i = includeFirst ? 0 : 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      lines[i] = line.replace(/^[ \t]+/, '');
      continue;
    }
    if (!line.startsWith(from)) return null;
    lines[i] = to + line.slice(from.length);
  }
  return lines.join('\n');
}

/**
 * Visit every AST node under `node` (no scope, no paths). Return false from `visit` to skip children.
 * @param {any} node
 * @param {(node: any) => boolean | void} visit
 */
export function walkNodes(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  if (visit(node) === false) return;
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'extra') continue;
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) walkNodes(child, visit);
    else if (value && typeof value.type === 'string') walkNodes(value, visit);
  }
}

/**
 * Whether code contains a string or template literal spanning several lines. Re-indenting such
 * code would change the string's contents, so re-indenting rules skip it.
 * @param {any} node
 */
export function hasMultilineLiteral(node) {
  let found = false;
  walkNodes(node, (n) => {
    if (found) return false;
    if ((n.type === 'TemplateLiteral' || n.type === 'StringLiteral') && n.loc && n.loc.start.line !== n.loc.end.line) found = true;
  });
  return found;
}

/**
 * Comments that lie inside `range` but outside all of `allowed` (e.g. the parts of an `if` chain
 * that a rewrite would drop).
 * @param {import('@babel/types').Comment[]} comments
 * @param {Range} range
 * @param {Range[]} allowed
 */
export function commentsOutside(comments, range, allowed) {
  return comments.filter(
    (c) =>
      /** @type {number} */ (c.start) >= range.start &&
      /** @type {number} */ (c.end) <= range.end &&
      !allowed.some((a) => /** @type {number} */ (c.start) >= a.start && /** @type {number} */ (c.end) <= a.end),
  );
}
