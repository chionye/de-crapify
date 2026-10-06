import { isBuiltin } from 'node:module';
import path from 'node:path';
import { matchesSubpathImport } from '../context/packages.js';
import { packageNameOf, resolveFile, stripLoaderAndQuery, typesPackageFor } from '../resolve.js';
import { traverse } from './shared.js';

/**
 * @typedef {object} ImportRef
 * @property {string} specifier
 * @property {number} line
 * @property {boolean} typeOnly   Only types are imported (`@types/x` is enough).
 * @property {boolean} inTry      A require()/import() inside a `try` block (optional dependency).
 * @property {import('@babel/types').Node} node
 */

/**
 * Every module specifier in a file: static imports, re-exports, `import x = require()`, and
 * `require()` / `import()` calls with a literal string.
 *
 * @param {import('@babel/types').File} ast
 * @returns {ImportRef[]}
 */
export function collectImports(ast) {
  /** @type {ImportRef[]} */
  const refs = [];
  const add = (/** @type {any} */ node, /** @type {string} */ specifier, typeOnly = false, inTry = false) =>
    refs.push({ specifier, line: node.loc?.start.line ?? 0, typeOnly, inTry, node });

  traverse(ast, {
    ImportDeclaration(p) {
      const n = p.node;
      const typeOnly = n.importKind === 'type' || (n.specifiers.length > 0 && n.specifiers.every((s) => s.type === 'ImportSpecifier' && s.importKind === 'type'));
      add(n, n.source.value, typeOnly);
    },
    ExportNamedDeclaration(p) {
      if (p.node.source) add(p.node, p.node.source.value, p.node.exportKind === 'type');
    },
    ExportAllDeclaration(p) {
      add(p.node, p.node.source.value, p.node.exportKind === 'type');
    },
    TSImportEqualsDeclaration(p) {
      const ref = p.node.moduleReference;
      if (ref.type === 'TSExternalModuleReference') add(p.node, ref.expression.value, p.node.importKind === 'type');
    },
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      const isDynamicImport = callee.type === 'Import';
      const isRequire = callee.type === 'Identifier' && callee.name === 'require' && !p.scope.hasBinding('require', true);
      if (!isDynamicImport && !isRequire) return;
      const specifier = literalString(args[0]);
      if (specifier !== null) add(p.node, specifier, false, isInsideTry(p));
    },
    ImportExpression(p) {
      const specifier = literalString(/** @type {any} */ (p.node).source);
      if (specifier !== null) add(p.node, specifier, false, isInsideTry(p));
    },
  });
  return refs;
}

/**
 * Rule 3 (report only): imports that don't resolve. "Likely hallucinated" when we're confident the
 * target doesn't exist; "could not verify" when config we can't read might make it valid.
 *
 * @param {object} input
 * @param {import('@babel/types').File} input.ast
 * @param {string} input.filePath
 * @param {import('../context/index.js').DirContext} input.ctx
 * @param {import('../context/files.js').FileCache} input.files
 * @param {Set<import('@babel/types').Node>} [input.ignoreNodes]  Imports being removed by another rule.
 * @returns {Promise<{ reports: import('./shared.js').RuleReport[] }>}
 */
export async function unresolvableImportsRule({ ast, filePath, ctx, files, ignoreNodes = new Set() }) {
  /** @type {import('./shared.js').RuleReport[]} */
  const reports = [];
  const seen = new Set();
  for (const ref of collectImports(ast)) {
    if (ignoreNodes.has(ref.node) || seen.has(ref.specifier)) continue;
    seen.add(ref.specifier);
    const verdict = await checkImport(ref, { filePath, ctx, files });
    if (verdict) reports.push({ type: verdict.type, line: ref.line, message: verdict.message });
  }
  return { reports };
}

/**
 * @param {ImportRef} ref
 * @param {{ filePath: string, ctx: import('../context/index.js').DirContext, files: import('../context/files.js').FileCache }} env
 * @returns {Promise<{ type: 'hallucinatedImport' | 'unverifiedImport', message: string } | null>}
 */
export async function checkImport(ref, { filePath, ctx, files }) {
  const raw = ref.specifier;
  const spec = stripLoaderAndQuery(raw);
  if (spec === '') return null;
  const quoted = `'${raw}'`;
  const resolveOpts = { files, moduleSuffixes: ctx.moduleSuffixes };

  // Schemes: `node:fs` must be a real built-in; `virtual:x`, `astro:content`, `bun:test`... are never flagged.
  const scheme = spec.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (scheme && !/^[a-zA-Z]:[\\/]/.test(spec)) {
    if (scheme[1] !== 'node' || isBuiltin(spec)) return null;
    return { type: 'hallucinatedImport', message: `${quoted} is not a Node.js built-in module` };
  }
  if (isBuiltin(spec)) return null;

  // Relative imports must point at a file.
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
    if (await resolveFile(path.resolve(path.dirname(filePath), spec), resolveOpts)) return null;
    return { type: 'hallucinatedImport', message: `${quoted} does not resolve to a file` };
  }

  // Root-relative paths mean different things to different bundlers.
  if (spec.startsWith('/')) {
    if (await resolveFile(spec, resolveOpts)) return null;
    return { type: 'unverifiedImport', message: `${quoted} is a root-relative path; it depends on bundler configuration` };
  }

  if (spec.startsWith('#') && matchesSubpathImport(spec, ctx.packages.subpathImports)) return null;

  // tsconfig `paths`.
  /** @type {string | null} */
  let matchedAlias = null;
  for (const alias of ctx.pathAliases) {
    const captured = matchPathPattern(alias.pattern, spec);
    if (captured === null) continue;
    matchedAlias ??= alias.pattern;
    for (const target of alias.targets) {
      if (await resolveFile(target.replace('*', captured), resolveOpts)) return null;
    }
  }

  // Babel module-resolver aliases.
  for (const alias of ctx.babel.aliases) {
    const rewritten = applyBabelAlias(alias, spec);
    if (rewritten === null) continue;
    matchedAlias ??= alias.pattern;
    for (const target of rewritten) {
      if (path.isAbsolute(target)) {
        if (await resolveFile(target, resolveOpts)) return null;
      } else if (await isPackageAvailable(packageNameOf(target), ref.typeOnly, ctx)) {
        return null;
      }
    }
  }

  // baseUrl and module-resolver roots make bare paths like `components/Button` resolvable.
  for (const base of [...ctx.baseUrls, ...ctx.babel.roots]) {
    if (await resolveFile(path.join(base, spec), resolveOpts)) return null;
  }

  // TypeScript falls back to node_modules when `paths` don't resolve, so check packages either way.
  if (await isPackageAvailable(packageNameOf(spec), ref.typeOnly, ctx)) return null;

  // Unresolved. Decide how sure we are.
  if (ref.inTry) {
    return { type: 'unverifiedImport', message: `${quoted} is not installed, but it is loaded inside try/catch (likely an optional dependency)` };
  }
  const aliasLike = isAliasLike(spec) || matchedAlias !== null;
  if (aliasLike && ctx.aliasUncertainty.length > 0) {
    return {
      type: 'unverifiedImport',
      message: `${quoted} could not be resolved, but aliases may be defined elsewhere (${ctx.aliasUncertainty.join('; ')})`,
    };
  }
  if (matchedAlias) {
    return { type: 'hallucinatedImport', message: `${quoted} matches the alias '${matchedAlias}', but no file exists there` };
  }
  if (spec.startsWith('#')) {
    return { type: 'hallucinatedImport', message: `${quoted} is not defined in the "imports" field of package.json` };
  }
  return { type: 'hallucinatedImport', message: `${quoted} is not installed and not listed in package.json` };
}

/**
 * Is a package available: declared in a package.json up the tree, a workspace package, the
 * package itself, or installed in node_modules? For type-only imports, `@types/x` also counts.
 *
 * @param {string} name
 * @param {boolean} typeOnly
 * @param {import('../context/index.js').DirContext} ctx
 */
async function isPackageAvailable(name, typeOnly, ctx) {
  const names = typeOnly ? [name, typesPackageFor(name)] : [name];
  for (const n of names) {
    const { declared, workspaceNames, selfNames } = ctx.packages;
    if (declared.has(n) || workspaceNames.has(n) || selfNames.has(n)) return true;
    if (await ctx.isInstalled(n)) return true;
  }
  return false;
}

/**
 * Prefixes people use for aliases. A scoped `@x/...` only counts when that scope isn't a real
 * package (callers check installation before getting here).
 * @param {string} spec
 */
function isAliasLike(spec) {
  return spec.startsWith('@/') || spec.startsWith('~') || spec.startsWith('#') || /^@[^/]+\//.test(spec);
}

/**
 * Match a tsconfig `paths` pattern (at most one `*`). Returns the text captured by `*` ('' for
 * exact patterns), or null if it doesn't match.
 * @param {string} pattern
 * @param {string} spec
 */
export function matchPathPattern(pattern, spec) {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === spec ? '' : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (spec.length < prefix.length + suffix.length || !spec.startsWith(prefix) || !spec.endsWith(suffix)) return null;
  return spec.slice(prefix.length, spec.length - suffix.length);
}

/**
 * Apply a module-resolver alias to a specifier. Returns rewritten targets, or null if it doesn't match.
 * @param {import('../context/aliases.js').BabelAlias} alias
 * @param {string} spec
 * @returns {string[] | null}
 */
function applyBabelAlias(alias, spec) {
  if (alias.regex) {
    const match = spec.match(alias.regex);
    if (!match) return null;
    return alias.targets.map((t) => t.replace(/\\(\d)|\$(\d)/g, (_, a, b) => match[Number(a ?? b)] ?? ''));
  }
  if (spec === alias.pattern) return alias.targets;
  if (spec.startsWith(`${alias.pattern}/`)) {
    const rest = spec.slice(alias.pattern.length + 1);
    return alias.targets.map((t) => (path.isAbsolute(t) ? path.join(t, rest) : `${t}/${rest}`));
  }
  return null;
}

/** @param {any} node */
function literalString(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked ?? null;
  return null;
}

/**
 * Inside the `try { ... }` block of a try statement (not its catch/finally).
 * @param {import('@babel/traverse').NodePath} path
 */
function isInsideTry(path) {
  let current = path;
  while (current.parentPath) {
    const parent = current.parentPath;
    if (parent.isTryStatement() && parent.node.block === current.node) return true;
    if (parent.isFunction()) return false;
    current = parent;
  }
  return false;
}
