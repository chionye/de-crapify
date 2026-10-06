import path from 'node:path';
import { ancestorDirs, isParseError } from './files.js';

/**
 * @typedef {object} PathAlias
 * @property {string} pattern    e.g. `@/*` or `~utils`
 * @property {string[]} targets  Absolute target patterns, e.g. `/proj/src/*`
 */

/**
 * @typedef {object} TsconfigInfo
 * @property {string} path
 * @property {'tsconfig' | 'jsconfig'} kind
 * @property {Record<string, any>} compilerOptions  Merged across the `extends` chain.
 * @property {string | null} baseUrl                Absolute.
 * @property {PathAlias[]} paths                    Targets resolved against baseUrl, or the defining config's dir.
 * @property {string | null} jsx                    Lowercased `compilerOptions.jsx`.
 * @property {string[] | null} moduleSuffixes
 * @property {string[] | undefined} files           Top-level (inherited) `files`.
 * @property {string[] | undefined} include         Top-level (inherited) `include`.
 * @property {{ path: string }[]} references        Own `references` (never inherited).
 * @property {string[]} unresolvedExtends           `extends` entries that couldn't be found.
 * @property {string | null} error                  Set when the config itself couldn't be read/parsed.
 */

/**
 * Find the nearest tsconfig.json / jsconfig.json from `dir` up to `stopDir`.
 * In the same directory, tsconfig.json wins.
 *
 * @param {string} dir
 * @param {string | null} stopDir
 * @param {import('./files.js').FileCache} files
 * @param {{ tsconfigOnly?: boolean }} [options]
 * @returns {Promise<{ path: string, kind: 'tsconfig' | 'jsconfig' } | null>}
 */
export async function findNearestConfig(dir, stopDir, files, { tsconfigOnly = false } = {}) {
  for (const d of ancestorDirs(dir, stopDir)) {
    const ts = path.join(d, 'tsconfig.json');
    if (await files.isFile(ts)) return { path: ts, kind: 'tsconfig' };
    if (!tsconfigOnly) {
      const js = path.join(d, 'jsconfig.json');
      if (await files.isFile(js)) return { path: js, kind: 'jsconfig' };
    }
  }
  return null;
}

/**
 * Load a tsconfig/jsconfig, following `extends` (string or array; relative paths or packages in
 * node_modules). Unresolvable `extends` entries are recorded and skipped, never fatal.
 *
 * @param {string} configPath
 * @param {'tsconfig' | 'jsconfig'} kind
 * @param {import('./files.js').FileCache} files
 * @returns {Promise<TsconfigInfo>}
 */
export async function loadTsconfig(configPath, kind, files) {
  /** @type {string[]} */
  const unresolvedExtends = [];
  const loaded = await loadChain(configPath, files, new Set(), unresolvedExtends);

  const compilerOptions = loaded.compilerOptions;
  const baseUrl = loaded.baseUrl;
  /** @type {PathAlias[]} */
  const paths = [];
  if (loaded.paths && typeof loaded.paths.value === 'object') {
    const base = baseUrl ?? loaded.paths.dir;
    for (const [pattern, targets] of Object.entries(loaded.paths.value)) {
      if (!Array.isArray(targets)) continue;
      paths.push({
        pattern,
        targets: targets.filter((t) => typeof t === 'string').map((t) => path.resolve(base, t)),
      });
    }
  }

  const ownJson = loaded.ownJson;
  const references = Array.isArray(ownJson?.references)
    ? ownJson.references
        .filter((r) => r && typeof r.path === 'string')
        .map((r) => ({ path: path.resolve(path.dirname(configPath), r.path) }))
    : [];

  return {
    path: configPath,
    kind,
    compilerOptions,
    baseUrl,
    paths,
    jsx: typeof compilerOptions.jsx === 'string' ? compilerOptions.jsx.toLowerCase() : null,
    moduleSuffixes: Array.isArray(compilerOptions.moduleSuffixes) ? compilerOptions.moduleSuffixes : null,
    files: loaded.files,
    include: loaded.include,
    references,
    unresolvedExtends,
    error: loaded.error,
  };
}

/**
 * @typedef {object} LoadedChain
 * @property {Record<string, any>} compilerOptions
 * @property {string | null} baseUrl
 * @property {{ value: Record<string, any>, dir: string } | null} paths
 * @property {string[] | undefined} files
 * @property {string[] | undefined} include
 * @property {any} ownJson
 * @property {string | null} error
 */

/**
 * @param {string} file
 * @param {import('./files.js').FileCache} files
 * @param {Set<string>} visiting
 * @param {string[]} unresolved
 * @returns {Promise<LoadedChain>}
 */
async function loadChain(file, files, visiting, unresolved) {
  /** @type {LoadedChain} */
  const result = { compilerOptions: {}, baseUrl: null, paths: null, files: undefined, include: undefined, ownJson: null, error: null };
  const json = await files.readJson(file);
  if (json === null) {
    result.error = `cannot read ${file}`;
    return result;
  }
  if (isParseError(json) || typeof json !== 'object') {
    result.error = `cannot parse ${file}: ${json.__parseError ?? 'not an object'}`;
    return result;
  }
  result.ownJson = json;
  visiting.add(file);
  const dir = path.dirname(file);

  const parents = Array.isArray(json.extends) ? json.extends : typeof json.extends === 'string' ? [json.extends] : [];
  for (const spec of parents) {
    if (typeof spec !== 'string') continue;
    const parentFile = await resolveExtends(spec, dir, files);
    if (!parentFile) {
      unresolved.push(spec);
      continue;
    }
    if (visiting.has(parentFile)) continue; // cycle
    const parent = await loadChain(parentFile, files, visiting, unresolved);
    if (parent.error) {
      unresolved.push(spec);
      continue;
    }
    // Later entries in an `extends` array override earlier ones.
    Object.assign(result.compilerOptions, parent.compilerOptions);
    if (parent.baseUrl) result.baseUrl = parent.baseUrl;
    if (parent.paths) result.paths = parent.paths;
    if (parent.files) result.files = parent.files;
    if (parent.include) result.include = parent.include;
  }

  const own = json.compilerOptions && typeof json.compilerOptions === 'object' ? json.compilerOptions : {};
  Object.assign(result.compilerOptions, own);
  if (typeof own.baseUrl === 'string') result.baseUrl = path.resolve(dir, own.baseUrl);
  if (own.paths && typeof own.paths === 'object') result.paths = { value: own.paths, dir };
  if (Array.isArray(json.files)) result.files = json.files;
  if (Array.isArray(json.include)) result.include = json.include;
  if (result.baseUrl) result.compilerOptions.baseUrl = result.baseUrl;

  visiting.delete(file);
  return result;
}

/**
 * Resolve an `extends` value to a config file path, or null.
 *
 * @param {string} spec
 * @param {string} fromDir
 * @param {import('./files.js').FileCache} files
 */
async function resolveExtends(spec, fromDir, files) {
  if (spec.startsWith('.') || path.isAbsolute(spec)) {
    return firstFile(candidatesFor(path.resolve(fromDir, spec)), files);
  }
  for (const d of ancestorDirs(fromDir, null)) {
    const found = await firstFile(candidatesFor(path.join(d, 'node_modules', spec)), files);
    if (found) return found;
  }
  return null;
}

/** @param {string} base */
function candidatesFor(base) {
  return base.endsWith('.json') ? [base] : [base, `${base}.json`, path.join(base, 'tsconfig.json')];
}

/** @param {string[]} candidates @param {import('./files.js').FileCache} files */
async function firstFile(candidates, files) {
  for (const c of candidates) {
    if (await files.isFile(c)) return c;
  }
  return null;
}
