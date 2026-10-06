import { insideAny, lineAwareRange, preview, STATEMENT_LIST_PARENTS, traverse } from './shared.js';

/** Console methods treated as debug output. Anything else (error, warn, group, time...) is never touched. */
export const DEBUG_CONSOLE_METHODS = ['log', 'debug', 'info', 'trace', 'dir', 'table'];


/**
 * Rule 2: remove standalone debug console calls; report the ones that aren't safe to remove.
 *
 * @param {{ ast: import('@babel/types').File, source: string, keepConsole: Set<string>, keepRanges: import('./shared.js').Range[] }} input
 * @returns {{ edits: import('./shared.js').Edit[], reasons: string[], reports: import('./shared.js').RuleReport[] }}
 */
export function consoleCallsRule({ ast, source, keepConsole, keepRanges }) {
  const removable = new Set(DEBUG_CONSOLE_METHODS.filter((m) => !keepConsole.has(m)));
  /** @type {import('./shared.js').Edit[]} */
  const edits = [];
  const reasons = [];
  /** @type {import('./shared.js').RuleReport[]} */
  const reports = [];
  /** Statements this rule removes (console calls, then `if`s they leave empty). */
  const removed = new Set();

  traverse(ast, {
    CallExpression(path) {
      const method = consoleMethod(path);
      if (!method || !removable.has(method)) return;
      const node = path.node;
      const range = { start: /** @type {number} */ (node.start), end: /** @type {number} */ (node.end) };
      if (insideAny(range, keepRanges)) return;

      const code = source.slice(range.start, range.end);
      const line = node.loc?.start.line ?? 0;
      const report = (/** @type {string} */ why) =>
        reports.push({ type: 'unsafeConsole', line, message: `\`${preview(code)}\` ${why}` });

      const statement = path.parentPath;
      if (!statement?.isExpressionStatement() || statement.node.expression !== node) {
        if (path.parentPath?.isArrowFunctionExpression() && path.parentPath.node.body === node) {
          report('is the body of an arrow function without braces; removing it would break the syntax');
        } else {
          report('is part of a larger expression; removing it could change behavior');
        }
        return;
      }

      const container = statement.parentPath;
      if (!container || !STATEMENT_LIST_PARENTS.has(container.node.type)) {
        report(`is the only body of a brace-less \`${keywordOf(container?.node.type)}\`; removing it would make the next statement conditional`);
        return;
      }

      if (!node.arguments.every(isSideEffectFree)) {
        report('has arguments that may have side effects (calls, assignments, await...); remove it by hand if it is safe');
        return;
      }

      const stmt = statement.node;
      removed.add(stmt);
      edits.push(lineAwareRange(source, /** @type {number} */ (stmt.start), /** @type {number} */ (stmt.end)));
      reasons.push(`removed \`${preview(code)}\``);
    },
  });

  if (removed.size > 0) removeEmptiedIfs({ ast, source, keepRanges, removed, edits, reasons });
  return { edits, reasons, reports };
}

/**
 * Remove `if (cond) { ...only removed console calls... }` blocks that our removals leave empty, e.g.
 * `if (__DEV__) { console.log('x'); }`. Only when the condition has no side effects, there's no
 * `else`, and the `if` sits directly in a statement list. Runs bottom-up so nested ifs collapse too.
 * The new edit replaces the inner edits it covers.
 *
 * @param {object} input
 * @param {import('@babel/types').File} input.ast
 * @param {string} input.source
 * @param {import('./shared.js').Range[]} input.keepRanges
 * @param {Set<import('@babel/types').Node>} input.removed
 * @param {import('./shared.js').Edit[]} input.edits
 * @param {string[]} input.reasons
 */
function removeEmptiedIfs({ ast, source, keepRanges, removed, edits, reasons }) {
  traverse(ast, {
    IfStatement: {
      exit(path) {
        const { node } = path;
        if (node.alternate || node.consequent.type !== 'BlockStatement') return;
        const body = node.consequent.body;
        if (body.length === 0 || !body.every((s) => removed.has(s))) return;
        if (!isSideEffectFree(node.test)) return;
        if (!path.parentPath || !STATEMENT_LIST_PARENTS.has(path.parentPath.node.type)) return;
        const range = { start: /** @type {number} */ (node.start), end: /** @type {number} */ (node.end) };
        if (keepRanges.some((r) => r.start < range.end && range.start < r.end)) return;

        removed.add(node);
        const edit = lineAwareRange(source, range.start, range.end);
        for (let i = edits.length - 1; i >= 0; i--) {
          if (edits[i].start >= edit.start && edits[i].end <= edit.end) edits.splice(i, 1);
        }
        edits.push(edit);
        const test = source.slice(/** @type {number} */ (node.test.start), /** @type {number} */ (node.test.end));
        reasons.push(`removed \`if (${preview(test, 40)})\`, which only contained debug logging`);
      },
    },
  });
}

/**
 * The method name if this is a call to the global `console.<method>(...)`, otherwise null.
 * @param {import('@babel/traverse').NodePath<import('@babel/types').CallExpression>} path
 */
function consoleMethod(path) {
  const callee = path.node.callee;
  if (callee.type !== 'MemberExpression') return null;
  if (callee.object.type !== 'Identifier' || callee.object.name !== 'console') return null;
  let name = null;
  if (!callee.computed && callee.property.type === 'Identifier') name = callee.property.name;
  else if (callee.computed && callee.property.type === 'StringLiteral') name = callee.property.value;
  if (!name) return null;
  // A local `console` (parameter, import, variable) is not the global one.
  if (path.scope.hasBinding('console', true)) return null;
  return name;
}

/** @param {string | undefined} type */
function keywordOf(type) {
  switch (type) {
    case 'IfStatement':
      return 'if/else';
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
      return 'for';
    case 'WhileStatement':
      return 'while';
    case 'DoWhileStatement':
      return 'do';
    case 'LabeledStatement':
      return 'label';
    case 'WithStatement':
      return 'with';
    default:
      return 'statement';
  }
}

/**
 * Whether evaluating an expression can't have side effects worth keeping: literals, identifiers,
 * member access, and templates/arrays/objects/spreads/operators built only from those.
 * Calls, `new`, `await`, `yield`, assignments, updates, `delete`, tagged templates, functions and
 * classes are not.
 *
 * @param {import('@babel/types').Node} node
 * @returns {boolean}
 */
export function isSideEffectFree(node) {
  switch (node.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'BigIntLiteral':
    case 'RegExpLiteral':
    case 'Identifier':
    case 'ThisExpression':
      return true;
    case 'TemplateLiteral':
      return node.expressions.every(isSideEffectFree);
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return isSideEffectFree(node.object) && (!node.computed || isSideEffectFree(node.property));
    case 'SpreadElement':
      return isSideEffectFree(node.argument);
    case 'ArrayExpression':
      return node.elements.every((el) => el === null || isSideEffectFree(el));
    case 'ObjectExpression':
      return node.properties.every(
        (prop) =>
          (prop.type === 'SpreadElement' && isSideEffectFree(prop.argument)) ||
          (prop.type === 'ObjectProperty' && (!prop.computed || isSideEffectFree(prop.key)) && isSideEffectFree(prop.value)),
      );
    case 'UnaryExpression':
      return node.operator !== 'delete' && isSideEffectFree(node.argument);
    case 'BinaryExpression':
    case 'LogicalExpression':
      return node.left.type !== 'PrivateName' && isSideEffectFree(node.left) && isSideEffectFree(node.right);
    case 'ConditionalExpression':
      return isSideEffectFree(node.test) && isSideEffectFree(node.consequent) && isSideEffectFree(node.alternate);
    case 'ParenthesizedExpression':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
    case 'TSTypeAssertion':
      return isSideEffectFree(node.expression);
    default:
      return false;
  }
}
