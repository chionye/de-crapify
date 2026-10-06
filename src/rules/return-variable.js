import { ownLineIndent, preview, STATEMENT_LIST_PARENTS, traverse } from './shared.js';

/**
 * Rule 8: `const x = expr; return x;` → `return expr;`
 *
 * Only for adjacent statements, a single declarator without a type annotation, `x` used nowhere
 * else and never reassigned, and no comments between the two. The declaration's own leading comments
 * stay where they are. One atomic edit per occurrence.
 *
 * @param {{ ast: import('@babel/types').File, source: string, keepRanges: import('./shared.js').Range[] }} input
 * @returns {import('./shared.js').Edit[]}
 */
export function returnVariableRule({ ast, source }) {
  /** @type {import('./shared.js').Edit[]} */
  const edits = [];
  const comments = ast.comments ?? [];

  traverse(ast, {
    VariableDeclaration(path) {
      const decl = path.node;
      if (decl.kind !== 'const' && decl.kind !== 'let') return;
      if (decl.declarations.length !== 1) return;
      const [declarator] = decl.declarations;
      if (declarator.id.type !== 'Identifier' || declarator.id.typeAnnotation || !declarator.init) return;
      if (!path.parentPath || !STATEMENT_LIST_PARENTS.has(path.parentPath.node.type)) return;

      const next = path.getSibling(/** @type {number} */ (path.key) + 1).node;
      if (!next || next.type !== 'ReturnStatement' || next.argument?.type !== 'Identifier') return;
      const name = declarator.id.name;
      if (next.argument.name !== name) return;

      const binding = path.scope.getBinding(name);
      if (!binding || binding.constantViolations.length > 0) return;
      if (binding.referencePaths.length !== 1 || binding.referencePaths[0].node !== next.argument) return;

      const declStart = /** @type {number} */ (decl.start);
      const retEnd = /** @type {number} */ (next.end);
      if (comments.some((c) => /** @type {number} */ (c.start) > declStart && /** @type {number} */ (c.end) < retEnd)) return;
      const indent = ownLineIndent(source, declStart);
      if (indent === null) return;

      const value = initText(declarator.init, source);
      const semicolon = source.slice(/** @type {number} */ (next.argument.end), retEnd);
      edits.push({
        start: declStart,
        end: retEnd,
        text: `return ${value}${semicolon}`,
        reason: `returned \`${preview(value, 40)}\` directly instead of through \`${name}\``,
      });
    },
  });
  return edits;
}

/**
 * The initializer's source, keeping its parentheses if it had them (multi-line JSX usually does).
 * @param {import('@babel/types').Expression} init
 * @param {string} source
 */
function initText(init, source) {
  const start = /** @type {number} */ (init.start);
  const end = /** @type {number} */ (init.end);
  const parenStart = /** @type {any} */ (init.extra)?.parenthesized ? /** @type {any} */ (init.extra).parenStart : undefined;
  if (typeof parenStart === 'number') {
    let close = end;
    while (close < source.length && /\s/.test(source[close])) close++;
    if (source[close] === ')') return source.slice(parenStart, close + 1);
  }
  return source.slice(start, end);
}
