import path from 'node:path';
import { isParseError } from './files.js';

/** JSON Babel configs we can read. */
const BABEL_JSON_CONFIGS = ['.babelrc', '.babelrc.json', 'babel.config.json'];

/**
 * JS/TS config files that can define import aliases. de-crapify never executes them, so when one
 * exists, alias-looking imports it can't resolve are reported as "could not verify" instead of
 * "likely hallucinated".
 */
export const JS_CONFIG_FILES = [
  ...['js', 'cjs', 'mjs', 'cts', 'mts', 'ts'].map((ext) => `babel.config.${ext}`),
  ...['js', 'cjs', 'mjs'].map((ext) => `.babelrc.${ext}`),
  ...['js', 'cjs', 'mjs', 'ts'].map((ext) => `metro.config.${ext}`),
  ...['js', 'cjs', 'mjs', 'ts', 'cts', 'mts'].map((ext) => `vite.config.${ext}`),
  ...['js', 'cjs', 'mjs', 'ts'].map((ext) => `webpack.config.${ext}`),
];

const MODULE_RESOLVER_NAMES = new Set(['module-resolver', 'babel-plugin-module-resolver']);

/**
 * @typedef {object} BabelAlias
 * @property {string} pattern      The alias key as written (`~`, `@components`, `^@(.+)`).
 * @property {RegExp | null} regex Set for regex-style keys (starting with `^`).
 * @property {string[]} targets    Absolute paths (or `$1`-style templates, absolute) to try.
 */

/**
 * @typedef {object} BabelAliasInfo
 * @property {BabelAlias[]} aliases
 * @property {string[]} roots         module-resolver `root` dirs (absolute): bare imports may resolve there.
 * @property {string[]} configs       JSON configs that were read.
 * @property {string[]} unreadable    JSON configs that exist but couldn't be parsed (aliases unknown).
 */

/**
 * Read module-resolver aliases from JSON Babel configs in `dirs` (nearest first).
 *
 * @param {string[]} dirs
 * @param {import('./files.js').FileCache} files
 * @returns {Promise<BabelAliasInfo>}
 */
export async function loadBabelAliases(dirs, files) {
  /** @type {BabelAliasInfo} */
  const info = { aliases: [], roots: [], configs: [], unreadable: [] };
  for (const dir of dirs) {
    for (const name of BABEL_JSON_CONFIGS) {
      const file = path.join(dir, name);
      const json = await files.readJson(file);
      if (json === null) continue;
      if (isParseError(json) || typeof json !== 'object') {
        info.unreadable.push(file);
        continue;
      }
      info.configs.push(file);
      for (const options of moduleResolverOptions(json)) addResolverOptions(info, options, dir);
    }
  }
  return info;
}

/**
 * JS config files (that may define aliases) present in any of `dirs`.
 * @param {string[]} dirs
 * @param {import('./files.js').FileCache} files
 */
export async function findJsConfigFiles(dirs, files) {
  const found = [];
  for (const dir of dirs) {
    for (const name of JS_CONFIG_FILES) {
      const file = path.join(dir, name);
      if (await files.isFile(file)) found.push(file);
    }
  }
  return found;
}

/**
 * All module-resolver option objects in a Babel config, including `env.*` and `overrides[]`.
 * @param {any} config
 * @returns {any[]}
 */
function moduleResolverOptions(config) {
  const found = [];
  const scan = (/** @type {any} */ cfg) => {
    if (!cfg || typeof cfg !== 'object') return;
    for (const plugin of Array.isArray(cfg.plugins) ? cfg.plugins : []) {
      const [name, options] = Array.isArray(plugin) ? plugin : [plugin, undefined];
      if (typeof name === 'string' && MODULE_RESOLVER_NAMES.has(name)) found.push(options ?? {});
    }
  };
  scan(config);
  if (config.env && typeof config.env === 'object') Object.values(config.env).forEach(scan);
  if (Array.isArray(config.overrides)) config.overrides.forEach(scan);
  return found;
}

/**
 * @param {BabelAliasInfo} info
 * @param {any} options
 * @param {string} dir
 */
function addResolverOptions(info, options, dir) {
  if (!options || typeof options !== 'object') return;
  const roots = Array.isArray(options.root) ? options.root : typeof options.root === 'string' ? [options.root] : [];
  for (const root of roots) {
    // Globs in `root` (e.g. `./src/**`) can't be resolved exactly; use the static prefix.
    if (typeof root === 'string') info.roots.push(path.resolve(dir, root.split('*')[0]));
  }
  const alias = options.alias && typeof options.alias === 'object' ? options.alias : {};
  for (const [pattern, target] of Object.entries(alias)) {
    const targets = (Array.isArray(target) ? target : [target]).filter((t) => typeof t === 'string');
    let regex = null;
    if (pattern.startsWith('^')) {
      try {
        regex = new RegExp(pattern);
      } catch {
        continue;
      }
    }
    info.aliases.push({
      pattern,
      regex,
      // Targets that are package names (no leading ./ or /) stay as-is.
      targets: targets.map((t) => (t.startsWith('.') || path.isAbsolute(t) ? path.resolve(dir, t) : t)),
    });
  }
}
