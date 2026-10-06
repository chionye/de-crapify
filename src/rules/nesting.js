import {
  commentsOutside,
  hasMultilineLiteral,
  ownLineIndent,
  preview,
  reindent,
  STATEMENT_LIST_PARENTS,
  traverse,
  walkNodes,
} from './shared.js';

/** Expression types that can be an `&&` operand without parentheses. */
const TIGHT_OPERANDS = new Set([
  'Identifier',
  'ThisExpression',
  'MemberExpression',
  'OptionalMemberExpression',
  'CallExpression',
  'OptionalCallExpression',
  'NewExpression',
  'UnaryExpression',
  'UpdateExpression',
  'AwaitExpression',
  'BinaryExpression',
  'StringLiteral',
  'NumericLiteral',
  'BooleanLiteral',
  'NullLiteral',
  'BigIntLiteral',
  'RegExpLiteral',
  'TemplateLiteral',
  'TSNonNullExpression',
]);

/**
 * Rules 6 and 7: needless nesting and unneeded `else`.
 *
 * - `if (a) { if (b) { … } }` (no elses, nothing else in the outer block) → `if (a && b) { … }`
 * - `else { if (c) … }` (only that `if` in the block) → `else if (c) …`
 * - `if (c) { …; return x; } else { … }` → `if (c) { …; return x; }` + the else body
 *
 * Each transform is one atomic edit. Anything unusual (comments in the parts that would be dropped,
 * code that doesn't start its own line, multi-line strings that re-indenting would change, a name
 * clash when un-nesting) means the code is left alone.
 *
 * @param {{ ast: import('@babel/types').File, source: string, keepRanges: import('./shared.js').Range[] }} input
 * @returns {import('./shared.js').Edit[]}
 */
export function nestingRules({ ast, source }) {
  /** @type {import('./shared.js').Edit[]} */
  const edits = [];
  const comments = ast.comments ?? [];

  traverse(ast, {
    IfStatement(path) {
      // Removing an else after return goes before collapsing `else { if }`: it flattens further.
      const edit = mergeNestedIfs(path.node, source, comments) ?? removeElseAfterReturn(path, source) ?? collapseElseIf(path.node, source, comments);
      if (edit) {
        edits.push(edit);
        path.skip(); // nested parts are handled in the next pass
      }
    },
  });
  return edits;
}

/**
 * @param {import('@babel/types').IfStatement} node
 * @param {string} source
 * @param {import('@babel/types').Comment[]} comments
 * @returns {import('./shared.js').Edit | null}
 */
function mergeNestedIfs(node, source, comments) {
  if (node.alternate) return null;
  const chain = [node];
  let current = node;
  while (
    current.consequent.type === 'BlockStatement' &&
    current.consequent.body.length === 1 &&
    current.consequent.body[0].type === 'IfStatement' &&
    !current.consequent.body[0].alternate
  ) {
    current = /** @type {import('@babel/types').IfStatement} */ (current.consequent.body[0]);
    chain.push(current);
  }
  if (chain.length < 2) return null;

  const outerIndent = ownLineIndent(source, pos(node.start));
  const innerIndent = ownLineIndent(source, pos(current.start));
  if (outerIndent === null || innerIndent === null) return null;
  if (chain.slice(1).some((n) => ownLineIndent(source, pos(n.start)) === null)) return null;

  const body = current.consequent;
  const kept = [range(body), ...chain.map((n) => range(n.test))];
  if (commentsOutside(comments, range(node), kept).length) return null;
  if (hasMultilineLiteral(body)) return null;

  const bodyText = reindent(source.slice(pos(body.start), pos(body.end)), innerIndent, outerIndent);
  if (bodyText === null) return null;
  const condition = chain.map((n) => operand(n.test, source)).join(' && ');
  return {
    start: pos(node.start),
    end: pos(node.end),
    text: `if (${condition}) ${bodyText}`,
    reason: `merged ${chain.length} nested \`if\`s into \`if (${preview(condition, 50)})\``,
  };
}

/**
 * @param {import('@babel/types').IfStatement} node
 * @param {string} source
 * @param {import('@babel/types').Comment[]} comments
 * @returns {import('./shared.js').Edit | null}
 */
function collapseElseIf(node, source, comments) {
  const alt = node.alternate;
  if (!alt || alt.type !== 'BlockStatement' || alt.body.length !== 1 || alt.body[0].type !== 'IfStatement') return null;
  const inner = alt.body[0];
  const outerIndent = ownLineIndent(source, pos(node.start));
  const innerIndent = ownLineIndent(source, pos(inner.start));
  if (outerIndent === null || innerIndent === null) return null;
  if (commentsOutside(comments, range(alt), [range(inner)]).length) return null;
  if (hasMultilineLiteral(inner)) return null;

  const text = reindent(source.slice(pos(inner.start), pos(inner.end)), innerIndent, outerIndent);
  if (text === null) return null;
  return { start: pos(alt.start), end: pos(alt.end), text, reason: 'collapsed `else { if … }` into `else if`' };
}

/**
 * @param {import('@babel/traverse').NodePath<import('@babel/types').IfStatement>} path
 * @param {string} source
 * @returns {import('./shared.js').Edit | null}
 */
function removeElseAfterReturn(path, source) {
  const { node } = path;
  const alt = node.alternate;
  if (!alt || !path.parentPath || !STATEMENT_LIST_PARENTS.has(path.parentPath.node.type)) return null;
  const exit = exitKeyword(node.consequent);
  if (!exit) return null;
  const indent = ownLineIndent(source, pos(node.start));
  if (indent === null) return null;
  // Only ` else ` between the branches: no comments that would be lost.
  if (!/^\s*else\s*$/.test(source.slice(pos(node.consequent.end), pos(alt.start)))) return null;
  const reason = `removed unneeded \`else\` after \`${exit}\``;

  if (alt.type === 'IfStatement') {
    // `} else if (b) {` → `}` + newline + `if (b) {`; the rest of the chain keeps its indentation.
    return { start: pos(node.consequent.end), end: pos(alt.start), text: `\n${indent}`, reason };
  }
  if (alt.type !== 'BlockStatement') return null;
  if (hasMultilineLiteral(alt)) return null;

  // Moving the else body up a level must not clash with, or shadow, names in the enclosing code.
  const lifted = [];
  for (const statement of alt.body) {
    if (statement.type === 'FunctionDeclaration') return null;
    if (statement.type === 'ClassDeclaration' && statement.id) lifted.push(statement.id.name);
    if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
      if (statement.declarations.some((d) => d.id.type !== 'Identifier')) return null;
      for (const d of statement.declarations) lifted.push(/** @type {import('@babel/types').Identifier} */ (d.id).name);
    }
  }
  if (lifted.length) {
    if (lifted.some((name) => path.scope.hasBinding(name, true))) return null;
    const used = namesUsedOutside(path.parentPath.node, range(alt));
    if (lifted.some((name) => used.has(name))) return null;
  }

  const inner = source.slice(pos(alt.start) + 1, pos(alt.end) - 1);
  if (inner.trim() === '') return { start: pos(node.consequent.end), end: pos(alt.end), text: '', reason };
  const firstNewline = inner.indexOf('\n');
  if (firstNewline === -1 || inner.slice(0, firstNewline).trim() !== '') {
    // Single-line else body: `else { a(); }`
    return { start: pos(node.consequent.end), end: pos(alt.end), text: `\n${indent}${inner.trim()}`, reason };
  }
  const body = inner.slice(firstNewline + 1).replace(/\s+$/, '');
  const bodyIndent = /^[ \t]*/.exec(body)?.[0] ?? '';
  if (bodyIndent.length <= indent.length || !bodyIndent.startsWith(indent)) return null;
  const text = reindent(body, bodyIndent, indent, { includeFirst: true });
  if (text === null) return null;
  return { start: pos(node.consequent.end), end: pos(alt.end), text: `\n${text}`, reason };
}

/**
 * `return` / `throw` if the branch always exits that way, else null.
 * @param {import('@babel/types').Statement} statement
 */
function exitKeyword(statement) {
  const last = statement.type === 'BlockStatement' ? statement.body[statement.body.length - 1] : statement;
  if (!last) return null;
  if (last.type === 'ReturnStatement') return 'return';
  if (last.type === 'ThrowStatement') return 'throw';
  return null;
}

/**
 * The source of a condition, parenthesized when it binds looser than `&&`.
 * @param {import('@babel/types').Expression} test
 * @param {string} source
 */
function operand(test, source) {
  const text = source.slice(pos(test.start), pos(test.end));
  if (TIGHT_OPERANDS.has(test.type) || (test.type === 'LogicalExpression' && test.operator === '&&')) return text;
  return `(${text})`;
}

/**
 * Every identifier name in `node` outside `exclude` (e.g. the enclosing block minus the else body).
 * @param {import('@babel/types').Node} node
 * @param {import('./shared.js').Range} exclude
 */
function namesUsedOutside(node, exclude) {
  const names = new Set();
  walkNodes(node, (n) => {
    if (n.start >= exclude.start && n.end <= exclude.end) return false;
    if (n.type === 'Identifier' || n.type === 'JSXIdentifier') names.add(n.name);
  });
  return names;
}

/** @param {number | null | undefined} n */
function pos(n) {
  return /** @type {number} */ (n);
}

/** @param {{ start?: number | null, end?: number | null }} node */
function range(node) {
  return { start: pos(node.start), end: pos(node.end) };
}
