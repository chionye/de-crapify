import { isReferencePosition, jsxReferenceKind, traverse } from '../rules/shared.js';

/**
 * @typedef {object} TopLevelDecl
 * @property {string[]} names        Names this statement declares at top level.
 * @property {string} name           The primary name (first declared).
 * @property {'function' | 'class' | 'variable' | 'type'} kind
 * @property {import('@babel/types').Statement} node  The outer statement (including any `export`).
 * @property {number} startLine
 * @property {number} endLine
 * @property {number} lines
 * @property {boolean} exported
 * @property {boolean} defaultExport
 * @property {boolean} isComponent   Capitalized function/class/arrow that renders JSX or is used as a JSX tag.
 * @property {Set<string>} refs      Primary names of other top-level declarations this one references.
 */

/**
 * Top-level declarations of a file and which ones reference each other. Imports and plain
 * statements (`app.listen()`) are not declarations. This is the analysis behind the god-file rule,
 * kept separate so a future `split` command can reuse it.
 *
 * @param {import('@babel/types').File} ast
 * @returns {TopLevelDecl[]}
 */
export function analyzeTopLevel(ast) {
  /** @type {TopLevelDecl[]} */
  const decls = [];
  for (const statement of ast.program.body) {
    const decl = describeStatement(statement);
    if (decl) decls.push(decl);
  }

  /** @type {Map<string, TopLevelDecl>} */
  const byName = new Map();
  for (const decl of decls) for (const name of decl.names) byName.set(name, decl);

  const jsxTags = new Set();
  /** @type {Set<TopLevelDecl>} */
  const containsJsx = new Set();
  const ownerOf = (/** @type {import('@babel/types').Node} */ node) =>
    decls.find((d) => /** @type {number} */ (node.start) >= /** @type {number} */ (d.node.start) && /** @type {number} */ (node.end) <= /** @type {number} */ (d.node.end));

  const addRef = (/** @type {import('@babel/types').Node} */ node, /** @type {string} */ name) => {
    const target = byName.get(name);
    if (!target) return;
    const owner = ownerOf(node);
    if (owner && owner !== target) owner.refs.add(target.name);
  };

  traverse(ast, {
    noScope: true,
    ImportDeclaration(path) {
      path.skip();
    },
    Identifier(path) {
      if (isReferencePosition(path)) addRef(path.node, path.node.name);
    },
    JSXIdentifier(path) {
      const kind = jsxReferenceKind(path);
      if (!kind) return;
      if (kind === 'tag') jsxTags.add(path.node.name);
      addRef(path.node, path.node.name);
    },
    'JSXElement|JSXFragment'(path) {
      const owner = ownerOf(path.node);
      if (owner) containsJsx.add(owner);
    },
  });

  for (const decl of decls) {
    decl.isComponent =
      /^[A-Z]/.test(decl.name) &&
      decl.kind !== 'type' &&
      (containsJsx.has(decl) || jsxTags.has(decl.name)) &&
      (decl.kind !== 'variable' || isFunctionLikeInit(decl.node));
  }
  return decls;
}

/**
 * Groups of declarations connected by references (in either direction).
 * @param {TopLevelDecl[]} decls
 * @returns {TopLevelDecl[][]}
 */
export function connectedGroups(decls) {
  const byName = new Map(decls.map((d) => [d.name, d]));
  /** @type {Map<TopLevelDecl, Set<TopLevelDecl>>} */
  const neighbors = new Map(decls.map((d) => [d, new Set()]));
  for (const decl of decls) {
    for (const ref of decl.refs) {
      const other = byName.get(ref);
      if (!other) continue;
      neighbors.get(decl)?.add(other);
      neighbors.get(other)?.add(decl);
    }
  }
  const seen = new Set();
  const groups = [];
  for (const decl of decls) {
    if (seen.has(decl)) continue;
    const group = [];
    const stack = [decl];
    seen.add(decl);
    while (stack.length) {
      const current = /** @type {TopLevelDecl} */ (stack.pop());
      group.push(current);
      for (const next of neighbors.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    groups.push(group.sort((a, b) => a.startLine - b.startLine));
  }
  return groups;
}

/**
 * Assign helper declarations to the "main" declaration that exclusively uses them (directly or
 * through other helpers it owns). Declarations used by several mains, or by none, stay unowned.
 *
 * @param {TopLevelDecl[]} decls
 * @param {TopLevelDecl[]} mains
 * @returns {Map<TopLevelDecl, TopLevelDecl>}  declaration → owning main (mains own themselves)
 */
export function assignOwners(decls, mains) {
  const byName = new Map(decls.map((d) => [d.name, d]));
  /** @type {Map<TopLevelDecl, Set<TopLevelDecl>>} */
  const usedBy = new Map(decls.map((d) => [d, new Set()]));
  for (const decl of decls) {
    for (const ref of decl.refs) {
      const target = byName.get(ref);
      if (target) usedBy.get(target)?.add(decl);
    }
  }

  /** @type {Map<TopLevelDecl, TopLevelDecl>} */
  const owner = new Map(mains.map((m) => [m, m]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const decl of decls) {
      if (owner.has(decl)) continue;
      const users = usedBy.get(decl) ?? new Set();
      if (users.size === 0) continue;
      const owners = new Set();
      let allOwned = true;
      for (const user of users) {
        const o = owner.get(user);
        if (o) owners.add(o);
        else allOwned = false;
      }
      if (allOwned && owners.size === 1) {
        owner.set(decl, /** @type {TopLevelDecl} */ ([...owners][0]));
        changed = true;
      }
    }
  }
  return owner;
}

/**
 * @param {import('@babel/types').Statement} statement
 * @returns {TopLevelDecl | null}
 */
function describeStatement(statement) {
  let node = /** @type {import('@babel/types').Node} */ (statement);
  let exported = false;
  let defaultExport = false;
  if (node.type === 'ExportNamedDeclaration' && node.declaration) {
    exported = true;
    node = node.declaration;
  } else if (node.type === 'ExportDefaultDeclaration') {
    exported = true;
    defaultExport = true;
    node = /** @type {any} */ (node.declaration);
  }

  /** @type {string[]} */
  let names = [];
  /** @type {TopLevelDecl['kind'] | null} */
  let kind = null;
  switch (node.type) {
    case 'FunctionDeclaration':
    case 'TSDeclareFunction':
      kind = 'function';
      names = node.id ? [node.id.name] : defaultExport ? ['default'] : [];
      break;
    case 'ClassDeclaration':
      kind = 'class';
      names = node.id ? [node.id.name] : defaultExport ? ['default'] : [];
      break;
    case 'VariableDeclaration':
      kind = 'variable';
      for (const d of node.declarations) names.push(...patternNames(d.id));
      break;
    case 'TSInterfaceDeclaration':
    case 'TSTypeAliasDeclaration':
    case 'TSEnumDeclaration':
      kind = node.type === 'TSEnumDeclaration' ? 'variable' : 'type';
      names = [node.id.name];
      break;
    default:
      return null;
  }
  if (names.length === 0) return null;

  const startLine = statement.loc?.start.line ?? 0;
  const endLine = statement.loc?.end.line ?? startLine;
  return {
    names,
    name: names[0],
    kind,
    node: statement,
    startLine,
    endLine,
    lines: endLine - startLine + 1,
    exported,
    defaultExport,
    isComponent: false,
    refs: new Set(),
  };
}

/** @param {import('@babel/types').Node} pattern @returns {string[]} */
function patternNames(pattern) {
  switch (pattern.type) {
    case 'Identifier':
      return [pattern.name];
    case 'ObjectPattern':
      return pattern.properties.flatMap((p) => (p.type === 'RestElement' ? patternNames(p.argument) : patternNames(p.value)));
    case 'ArrayPattern':
      return pattern.elements.flatMap((e) => (e ? patternNames(e) : []));
    case 'AssignmentPattern':
      return patternNames(pattern.left);
    case 'RestElement':
      return patternNames(pattern.argument);
    default:
      return [];
  }
}

/**
 * `const X = () => ...`, `function`, `class`, or a wrapper call like `memo(() => ...)` /
 * `forwardRef(function ...)`.
 * @param {import('@babel/types').Statement} statement
 */
function isFunctionLikeInit(statement) {
  const decl = /** @type {any} */ (statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement);
  const init = decl?.declarations?.[0]?.init;
  if (!init) return false;
  const isFn = (/** @type {any} */ n) => n && ['ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression'].includes(n.type);
  if (isFn(init)) return true;
  if (init.type === 'CallExpression') return init.arguments.some((a) => isFn(a) || (a.type === 'CallExpression' && a.arguments.some(isFn)));
  return false;
}
