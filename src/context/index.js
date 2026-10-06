import path from 'node:path';
import { findJsConfigFiles, loadBabelAliases } from './aliases.js';
import { ancestorDirs, createFileCache } from './files.js';
import { detectProjectJsxRuntime } from './jsx-runtime.js';
import { createInstalledCheck, loadPackages, minMajorVersion } from './packages.js';
import { findNearestConfig, loadTsconfig } from './tsconfig.js';

/**
 * @typedef {object} DirContext
 * @property {string} dir
 * @property {import('./packages.js').PackagesInfo} packages
 * @property {(name: string) => Promise<boolean>} isInstalled  Resolvable through node_modules from `dir`.
 * @property {import('./tsconfig.js').TsconfigInfo | null} tsconfig  Nearest tsconfig.json or jsconfig.json.
 * @property {import('./tsconfig.js').TsconfigInfo[]} tsconfigReferences  Configs listed in its `references`.
 * @property {import('./tsconfig.js').PathAlias[]} pathAliases  tsconfig `paths` from the config and its references.
 * @property {string[]} baseUrls        Absolute `baseUrl`s from the config and its references.
 * @property {import('./aliases.js').BabelAliasInfo} babel
 * @property {string[]} jsConfigFiles    JS configs that may define aliases we can't read.
 * @property {string[]} aliasUncertainty Why aliases may be incomplete (empty = we know them all).
 * @property {number | null} reactMajor
 * @property {import('./jsx-runtime.js').JsxRuntimeDecision} jsxRuntime  Project-level; apply the file pragma on top.
 * @property {{ tsconfigPath: string | null, installed: boolean, version: string | null }} typescript
 * @property {string[]} moduleSuffixes   From tsconfig, e.g. ['.ios', '.native', ''].
 */

/**
 * Create the project context for a run. Context is computed per directory (files in a monorepo can
 * belong to different packages and tsconfigs) and cached, so every config file is read once.
 *
 * @param {{ stopDir: string | null }} options  Usually the git root; null walks to the filesystem root.
 */
export function createProjectContext({ stopDir }) {
  const files = createFileCache();
  const installed = createInstalledCheck(files);
  /** @type {Map<string, Promise<DirContext>>} */
  const cache = new Map();

  /** @param {string} dir */
  function forDirectory(dir) {
    const key = path.resolve(dir);
    let p = cache.get(key);
    if (!p) {
      p = buildDirContext(key, stopDir, files, installed);
      cache.set(key, p);
    }
    return p;
  }

  return {
    files,
    forDirectory,
    /** @param {string} file */
    forFile: (file) => forDirectory(path.dirname(path.resolve(file))),
  };
}

/** @typedef {ReturnType<typeof createProjectContext>} ProjectContext */

/**
 * @param {string} dir
 * @param {string | null} stopDir
 * @param {import('./files.js').FileCache} files
 * @param {ReturnType<typeof createInstalledCheck>} installed
 * @returns {Promise<DirContext>}
 */
async function buildDirContext(dir, stopDir, files, installed) {
  const dirs = ancestorDirs(dir, stopDir);
  const packages = await loadPackages(dir, stopDir, files);

  const configRef = await findNearestConfig(dir, stopDir, files);
  const tsconfig = configRef ? await loadTsconfig(configRef.path, configRef.kind, files) : null;
  // Solution-style configs (Vite's template) keep `jsx` and `paths` in the referenced configs.
  const tsconfigReferences = [];
  for (const ref of tsconfig?.references ?? []) {
    const refPath = (await files.isDirectory(ref.path)) ? path.join(ref.path, 'tsconfig.json') : ref.path;
    tsconfigReferences.push(await loadTsconfig(refPath, 'tsconfig', files));
  }
  const allConfigs = tsconfig ? [tsconfig, ...tsconfigReferences] : [];

  const babel = await loadBabelAliases(dirs, files);
  const jsConfigFiles = await findJsConfigFiles(dirs, files);

  const aliasUncertainty = [];
  for (const file of jsConfigFiles) aliasUncertainty.push(`${path.basename(file)} may define aliases (not executed)`);
  for (const file of babel.unreadable) aliasUncertainty.push(`${path.basename(file)} could not be parsed`);
  for (const config of allConfigs) {
    if (config.error) aliasUncertainty.push(config.error);
    for (const spec of config.unresolvedExtends) {
      aliasUncertainty.push(`${path.basename(config.path)} extends "${spec}", which could not be found`);
    }
  }

  const installedReact = await installed.installedPackageJson('react', dir);
  const reactMajor =
    installedReact && typeof installedReact.version === 'string'
      ? minMajorVersion(installedReact.version)
      : minMajorVersion(packages.declared.get('react'));

  const jsxRuntime = detectProjectJsxRuntime({
    tsconfigJsx: tsconfig?.jsx ?? unanimous(tsconfigReferences.map((c) => c.jsx)),
    declared: packages.declared,
    reactMajor,
  });

  const tsRef = configRef?.kind === 'tsconfig' ? configRef : await findNearestConfig(dir, stopDir, files, { tsconfigOnly: true });
  const tsPkg = await installed.installedPackageJson('typescript', tsRef ? path.dirname(tsRef.path) : dir);

  return {
    dir,
    packages,
    isInstalled: (name) => installed.isInstalled(name, dir),
    tsconfig,
    tsconfigReferences,
    pathAliases: allConfigs.flatMap((c) => c.paths),
    baseUrls: [...new Set(allConfigs.map((c) => c.baseUrl).filter((b) => b !== null))],
    babel,
    jsConfigFiles,
    aliasUncertainty,
    reactMajor,
    jsxRuntime,
    typescript: {
      tsconfigPath: tsRef?.path ?? null,
      installed: tsPkg !== null,
      version: typeof tsPkg?.version === 'string' ? tsPkg.version : null,
    },
    moduleSuffixes: tsconfig?.moduleSuffixes ?? unanimousList(tsconfigReferences.map((c) => c.moduleSuffixes)) ?? [],
  };
}

/**
 * The single non-null value shared by every config that sets it, or null if none set it or they disagree.
 * @param {(string | null)[]} values
 */
function unanimous(values) {
  const set = new Set(values.filter((v) => v !== null));
  return set.size === 1 ? /** @type {string} */ ([...set][0]) : null;
}

/** @param {(string[] | null)[]} lists */
function unanimousList(lists) {
  const value = unanimous(lists.map((l) => (l ? JSON.stringify(l) : null)));
  return value ? /** @type {string[]} */ (JSON.parse(value)) : null;
}

/**
 * Human-readable description of a directory context, for --verbose.
 * @param {DirContext} ctx
 * @param {string} cwd
 * @returns {string[]}
 */
export function describeContext(ctx, cwd) {
  const rel = (/** @type {string} */ p) => path.relative(cwd, p) || '.';
  const lines = [];
  lines.push(`package: ${ctx.packages.nearest ? rel(ctx.packages.nearest.path) : 'none'} (${ctx.packages.declared.size} declared deps, ${ctx.packages.workspaceNames.size} workspace packages)`);
  if (ctx.tsconfig) {
    const refs = ctx.tsconfigReferences.map((c) => rel(c.path));
    lines.push(`${ctx.tsconfig.kind}: ${rel(ctx.tsconfig.path)}${refs.length ? ` (references ${refs.join(', ')})` : ''}`);
  }
  const aliases = [...new Set([...ctx.pathAliases.map((p) => p.pattern), ...ctx.babel.aliases.map((a) => a.pattern)])];
  if (aliases.length) lines.push(`aliases: ${aliases.join(' ')}`);
  for (const reason of ctx.aliasUncertainty) lines.push(`aliases may be incomplete: ${reason}`);
  lines.push(`JSX runtime: ${ctx.jsxRuntime.runtime} (${ctx.jsxRuntime.reason})`);
  lines.push(
    `TypeScript: ${ctx.typescript.tsconfigPath ? rel(ctx.typescript.tsconfigPath) : 'no tsconfig.json'}, ${ctx.typescript.installed ? `typescript ${ctx.typescript.version}` : 'typescript not installed'}`,
  );
  return lines;
}
