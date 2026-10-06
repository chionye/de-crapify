import { jsxReferenceKind, traverse } from '../rules/shared.js';

/** AST keys that don't affect meaning: positions, comments, raw text (quote style, number spelling). */
const NOISE_KEYS = new Set(['start', 'end', 'loc', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens']);

/**
 * A string that is equal for two AST nodes exactly when they mean the same code, regardless of
 * formatting, comments, or quote style.
 * @param {unknown} node
 */
export function canonical(node) {
  return JSON.stringify(node, (key, value) => (NOISE_KEYS.has(key) ? undefined : typeof value === 'bigint' ? `${value}n` : value));
}

/**
 * Length of the code without comments and whitespace (used by the size check).
 * @param {string} code
 * @param {import('@babel/types').File} ast
 */
export function strippedLength(code, ast) {
  let text = '';
  let pos = 0;
  for (const c of [...(ast.comments ?? [])].sort((a, b) => /** @type {number} */ (a.start) - /** @type {number} */ (b.start))) {
    text += code.slice(pos, c.start);
    pos = /** @type {number} */ (c.end);
  }
  text += code.slice(pos);
  return text.replace(/\s+/g, '').length;
}

/**
 * String-ish and numeric literal values, as a multiset (value → count). Strings, template text and
 * JSX text share one namespace so `'a' + b` → `` `a${b}` `` isn't treated as a new literal.
 * @param {import('@babel/types').File} ast
 * @returns {Map<string, number>}
 */
export function literalValues(ast) {
  /** @type {Map<string, number>} */
  const values = new Map();
  const add = (/** @type {string} */ key) => {
    values.set(key, (values.get(key) ?? 0) + 1);
  };
  traverse(ast, {
    noScope: true,
    StringLiteral(p) {
      add(`string ${JSON.stringify(p.node.value)}`);
    },
    DirectiveLiteral(p) {
      add(`string ${JSON.stringify(p.node.value)}`);
    },
    TemplateElement(p) {
      const cooked = p.node.value.cooked ?? p.node.value.raw;
      if (cooked !== '') add(`string ${JSON.stringify(cooked)}`);
    },
    JSXText(p) {
      const text = p.node.value.replace(/\s+/g, ' ').trim();
      if (text) add(`string ${JSON.stringify(text)}`);
    },
    NumericLiteral(p) {
      add(`number ${p.node.value}`);
    },
    BigIntLiteral(p) {
      add(`bigint ${p.node.value}`);
    },
    RegExpLiteral(p) {
      add(`regex /${p.node.pattern}/${p.node.flags}`);
    },
  });
  return values;
}

/** Names that are never "invented": they can't be shadowed meaningfully and have no side effects. */
const ALWAYS_AVAILABLE = new Set(['undefined', 'NaN', 'Infinity']);

/**
 * Identifiers the code references but doesn't declare itself (value and type positions, JSX
 * component tags). Scope-aware for values; name-based for types, which Babel's scope doesn't track.
 * @param {import('@babel/types').File} ast
 * @returns {Set<string>}
 */
export function freeIdentifiers(ast) {
  const typeNames = new Set();
  traverse(ast, {
    noScope: true,
    'TSTypeParameter|TSInterfaceDeclaration|TSTypeAliasDeclaration|TSEnumDeclaration|TSModuleDeclaration|ClassDeclaration|ClassExpression'(p) {
      const node = /** @type {any} */ (p.node);
      const name = typeof node.name === 'string' ? node.name : node.name?.name ?? node.id?.name;
      if (name) typeNames.add(name);
    },
  });

  const free = new Set();
  const consider = (/** @type {import('@babel/traverse').NodePath} */ path, /** @type {string} */ name) => {
    if (ALWAYS_AVAILABLE.has(name) || typeNames.has(name)) return;
    if (!path.scope.hasBinding(name, true)) free.add(name);
  };

  traverse(ast, {
    Identifier(path) {
      if (isTypeReferenceName(path)) {
        if (!typeNames.has(path.node.name) && !path.scope.hasBinding(path.node.name, true)) free.add(path.node.name);
        return;
      }
      if (path.isReferencedIdentifier()) consider(path, path.node.name);
    },
    JSXIdentifier(path) {
      const kind = jsxReferenceKind(path);
      if (!kind) return;
      // `<div>` is an intrinsic element, not a reference; `<motion.div>` references `motion`.
      if (kind === 'tag' && /^[a-z]/.test(path.node.name)) return;
      consider(path, path.node.name);
    },
  });
  return free;
}

/** @param {import('@babel/traverse').NodePath<import('@babel/types').Identifier>} path */
function isTypeReferenceName(path) {
  const parent = path.parent;
  if (parent.type === 'TSTypeReference' && parent.typeName === path.node) return true;
  if (parent.type === 'TSQualifiedName' && parent.left === path.node) return true;
  if ((parent.type === 'TSExpressionWithTypeArguments' || parent.type === 'TSClassImplements' || parent.type === 'TSInterfaceHeritage') && /** @type {any} */ (parent).expression === path.node) {
    return true;
  }
  return false;
}

/** Hooks with a dependency array, and the argument index it's at. */
export const DEPENDENCY_ARG_INDEX = Object.freeze({
  useEffect: 1,
  useLayoutEffect: 1,
  useInsertionEffect: 1,
  useMemo: 1,
  useCallback: 1,
  useImperativeHandle: 2,
});

/**
 * @typedef {object} HookCall
 * @property {string} name        As written: `useState` or `React.useState`.
 * @property {string | null} deps Canonical form of the dependency array argument (null if absent / not applicable).
 * @property {string | null} violation  Why this call breaks the rules of hooks, or null.
 */

/**
 * Every hook call (`use`, `useX`, `React.useX`) in source order, with rules-of-hooks violations.
 * @param {import('@babel/types').File} ast
 * @returns {HookCall[]}
 */
export function hookCalls(ast) {
  /** @type {(HookCall & { start: number })[]} */
  const calls = [];
  traverse(ast, {
    CallExpression(path) {
      const name = hookName(path.node.callee);
      if (!name) return;
      const base = name.split('.').pop() ?? name;
      const depsIndex = /** @type {Record<string, number>} */ (DEPENDENCY_ARG_INDEX)[base];
      const depsArg = depsIndex === undefined ? undefined : path.node.arguments[depsIndex];
      calls.push({
        name,
        deps: depsIndex === undefined ? null : depsArg ? canonical(depsArg) : 'none',
        violation: hookViolation(path),
        start: /** @type {number} */ (path.node.start),
      });
    },
  });
  return calls.sort((a, b) => a.start - b.start).map(({ start, ...call }) => call);
}

/** @param {import('@babel/types').Node} callee */
function hookName(callee) {
  const isHook = (/** @type {string} */ n) => n === 'use' || /^use[A-Z0-9]/.test(n);
  if (callee.type === 'Identifier' && isHook(callee.name)) return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && isHook(callee.property.name)) {
    return callee.object.type === 'Identifier' ? `${callee.object.name}.${callee.property.name}` : callee.property.name;
  }
  return null;
}

const CONDITIONAL_TYPES = new Set([
  'IfStatement',
  'ConditionalExpression',
  'LogicalExpression',
  'SwitchStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'TryStatement',
  'OptionalCallExpression',
  'OptionalMemberExpression',
]);

/**
 * @param {import('@babel/traverse').NodePath<import('@babel/types').CallExpression>} path
 * @returns {string | null}
 */
function hookViolation(path) {
  const fn = path.getFunctionParent();
  if (!fn) return 'outside any component or hook';
  if (fn.getFunctionParent()) return 'inside a nested function';
  for (let p = path.parentPath; p && p !== fn; p = p.parentPath) {
    if (CONDITIONAL_TYPES.has(p.node.type)) return 'inside a condition or loop';
  }
  const hookStart = /** @type {number} */ (path.node.start);
  let earlyReturn = false;
  fn.traverse({
    Function(inner) {
      inner.skip();
    },
    ReturnStatement(ret) {
      if (/** @type {number} */ (ret.node.start) < hookStart) earlyReturn = true;
    },
  });
  return earlyReturn ? 'after an early return' : null;
}

const DIRECTIVE_COMMENT = /^\s*(@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable(?:-next-line|-line)?)\b/;

/**
 * `@ts-ignore` / `@ts-expect-error` / `eslint-disable*` comments, each keyed by its own text and the
 * code it applies to (the next code line, or its own line for `-line` variants), whitespace-insensitive.
 * @param {string} code
 * @param {import('@babel/types').File} ast
 * @returns {string[]}
 */
export function directiveComments(code, ast) {
  const keys = [];
  for (const comment of ast.comments ?? []) {
    const match = comment.value.match(DIRECTIVE_COMMENT);
    if (!match) continue;
    const text = comment.value.replace(/\s+/g, ' ').trim();
    let anchor;
    if (match[1] === 'eslint-disable-line') {
      const lineStart = code.lastIndexOf('\n', /** @type {number} */ (comment.start) - 1) + 1;
      anchor = code.slice(lineStart, comment.start);
    } else {
      anchor = nextCodeLine(code, /** @type {number} */ (comment.end), ast.comments ?? []);
    }
    keys.push(`${text} → ${anchor.replace(/\s+/g, '')}`);
  }
  return keys.sort();
}

/**
 * @param {string} code
 * @param {number} from
 * @param {import('@babel/types').Comment[]} comments
 */
function nextCodeLine(code, from, comments) {
  let i = from;
  while (i < code.length) {
    if (/\s/.test(code[i])) {
      i++;
      continue;
    }
    const comment = comments.find((c) => c.start === i);
    if (comment) {
      i = /** @type {number} */ (comment.end);
      continue;
    }
    break;
  }
  const end = code.indexOf('\n', i);
  return code.slice(i, end === -1 ? undefined : end);
}

/**
 * Top-level names a file declares (including imports) and exports, sorted.
 * @param {import('@babel/types').File} ast
 */
export function topLevelNames(ast) {
  const declared = [];
  const exported = [];
  for (const statement of ast.program.body) {
    let node = /** @type {any} */ (statement);
    if (node.type === 'ImportDeclaration') {
      for (const s of node.specifiers) declared.push(s.local.name);
      continue;
    }
    if (node.type === 'ExportAllDeclaration') {
      exported.push(node.exported ? node.exported.name ?? node.exported.value : `* from ${node.source.value}`);
      continue;
    }
    if (node.type === 'ExportDefaultDeclaration') {
      exported.push('default');
      node = node.declaration;
    } else if (node.type === 'ExportNamedDeclaration') {
      for (const s of node.specifiers ?? []) exported.push(s.exported.name ?? s.exported.value);
      if (!node.declaration) continue;
      node = node.declaration;
      for (const name of declaredNames(node)) exported.push(name);
    }
    declared.push(...declaredNames(node));
  }
  return { declared: declared.sort(), exported: exported.sort() };
}

/** @param {any} node @returns {string[]} */
function declaredNames(node) {
  if (!node) return [];
  switch (node.type) {
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
    case 'TSDeclareFunction':
    case 'TSInterfaceDeclaration':
    case 'TSTypeAliasDeclaration':
    case 'TSEnumDeclaration':
      return node.id ? [node.id.name] : [];
    case 'TSModuleDeclaration':
      return node.id?.name ? [node.id.name] : [];
    case 'VariableDeclaration':
      return node.declarations.flatMap((/** @type {any} */ d) => patternNames(d.id));
    default:
      return [];
  }
}

/** @param {any} pattern @returns {string[]} */
function patternNames(pattern) {
  switch (pattern?.type) {
    case 'Identifier':
      return [pattern.name];
    case 'ObjectPattern':
      return pattern.properties.flatMap((/** @type {any} */ p) => patternNames(p.type === 'RestElement' ? p.argument : p.value));
    case 'ArrayPattern':
      return pattern.elements.flatMap((/** @type {any} */ e) => patternNames(e));
    case 'AssignmentPattern':
      return patternNames(pattern.left);
    case 'RestElement':
      return patternNames(pattern.argument);
    default:
      return [];
  }
}

/**
 * The parts of a chunk's main declaration that callers depend on, keyed by part, in canonical form.
 * Functions: name, params (incl. defaults and types), return type, type params, async/generator.
 * Classes: name, heritage, and every member's name and signature. Variables: names, kind, type, and
 * the function signature if the initializer is (or wraps) a function.
 * @param {import('@babel/types').File} ast
 * @returns {{ name: string, parts: Record<string, string> } | null}
 */
export function chunkSignature(ast) {
  const statement = ast.program.body[0];
  if (!statement) return null;
  let node = /** @type {any} */ (statement);
  const parts = {};
  if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
    parts.export = node.type;
    node = node.declaration;
  }
  if (!node) return null;

  if (node.type === 'FunctionDeclaration' || node.type === 'TSDeclareFunction') {
    Object.assign(parts, functionParts(node));
    return { name: node.id?.name ?? 'default', parts };
  }
  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    parts.heritage = canonical([node.superClass, node.superTypeParameters, node.implements, node.typeParameters, node.abstract]);
    parts.decorators = canonical(node.decorators ?? []);
    for (const member of node.body.body) {
      const key = member.key ? (member.computed ? `[${canonical(member.key)}]` : member.key.name ?? member.key.value ?? canonical(member.key)) : member.type;
      parts[`member ${member.static ? 'static ' : ''}${key}`] = canonical({
        kind: member.kind,
        type: member.type,
        accessibility: member.accessibility,
        readonly: member.readonly,
        optional: member.optional,
        typeAnnotation: member.typeAnnotation,
        decorators: member.decorators,
        ...(member.params ? functionParts(member) : {}),
      });
    }
    return { name: node.id?.name ?? 'default', parts };
  }
  if (node.type === 'VariableDeclaration') {
    parts.kind = node.kind;
    const names = [];
    for (const d of node.declarations) {
      names.push(...patternNames(d.id));
      parts[`binding ${patternNames(d.id).join(',')}`] = canonical(d.id);
      const fn = functionInit(d.init);
      if (fn) {
        Object.assign(parts, functionParts(fn));
        if (d.init !== fn) parts.wrapper = canonical(d.init.callee);
      }
    }
    return { name: names.join(', '), parts };
  }
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
    Object.assign(parts, functionParts(node));
    return { name: 'default', parts };
  }
  return { name: node.id?.name ?? node.type, parts: { ...parts, declaration: node.type } };
}

/** @param {any} fn */
function functionParts(fn) {
  return {
    params: canonical(fn.params),
    returnType: canonical(fn.returnType ?? null),
    typeParameters: canonical(fn.typeParameters ?? null),
    async: String(Boolean(fn.async)),
    generator: String(Boolean(fn.generator)),
  };
}

/** `() => {}`, `function () {}`, or a wrapper call like `memo(() => {})` / `forwardRef(function () {})`. */
function functionInit(/** @type {any} */ init) {
  if (!init) return null;
  if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') return init;
  if (init.type === 'CallExpression') {
    for (const arg of init.arguments) {
      const fn = functionInit(arg);
      if (fn) return fn;
    }
  }
  return null;
}
