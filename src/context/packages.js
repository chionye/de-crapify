import fs from 'node:fs/promises';
import path from 'node:path';
import { ancestorDirs, isParseError } from './files.js';

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/** How deep a `**` in a workspace pattern may descend. */
const MAX_GLOBSTAR_DEPTH = 6;

/**
 * @typedef {object} PackageJsonRef
 * @property {string} path
 * @property {string} dir
 * @property {any} json
 */

/**
 * @typedef {object} PackagesInfo
 * @property {PackageJsonRef | null} nearest   The closest package.json (the file's own package).
 * @property {PackageJsonRef[]} chain          Every package.json from nearest up to the stop dir.
 * @property {Map<string, string>} declared    Declared dependency name → version range (closest wins).
 * @property {Set<string>} selfNames           `name` of every package.json in the chain.
 * @property {Set<string>} workspaceNames      Names of workspace packages of any workspace root in the chain.
 * @property {string[]} subpathImports         Keys of the nearest package.json `imports` field (`#x`, `#x/*`).
 */

/**
 * Collect package information for files in `dir`.
 *
 * @param {string} dir
 * @param {string | null} stopDir  Git root, or null to walk to the filesystem root.
 * @param {import('./files.js').FileCache} files
 * @returns {Promise<PackagesInfo>}
 */
export async function loadPackages(dir, stopDir, files) {
  /** @type {PackageJsonRef[]} */
  const chain = [];
  for (const d of ancestorDirs(dir, stopDir)) {
    const file = path.join(d, 'package.json');
    const json = await files.readJson(file);
    if (json && !isParseError(json) && typeof json === 'object') chain.push({ path: file, dir: d, json });
  }

  /** @type {Map<string, string>} */
  const declared = new Map();
  const selfNames = new Set();
  const workspaceNames = new Set();
  for (const { dir: pkgDir, json } of chain) {
    for (const field of DEPENDENCY_FIELDS) {
      const deps = json[field];
      if (!deps || typeof deps !== 'object') continue;
      for (const [name, range] of Object.entries(deps)) {
        if (!declared.has(name)) declared.set(name, String(range));
      }
    }
    if (typeof json.name === 'string') selfNames.add(json.name);

    const patterns = [...workspacePatternsFromPackageJson(json), ...(await pnpmWorkspacePatterns(pkgDir, files))];
    if (patterns.length > 0) {
      for (const wsDir of await expandWorkspacePatterns(pkgDir, patterns)) {
        const wsJson = await files.readJson(path.join(wsDir, 'package.json'));
        if (wsJson && !isParseError(wsJson) && typeof wsJson.name === 'string') workspaceNames.add(wsJson.name);
      }
    }
  }

  const nearest = chain[0] ?? null;
  const imports = nearest?.json.imports;
  const subpathImports = imports && typeof imports === 'object' ? Object.keys(imports).filter((k) => k.startsWith('#')) : [];

  return { nearest, chain, declared, selfNames, workspaceNames, subpathImports };
}

/**
 * Whether a `#specifier` matches one of the package.json `imports` keys (exact or `*` pattern).
 * @param {string} specifier
 * @param {string[]} keys
 */
export function matchesSubpathImport(specifier, keys) {
  for (const key of keys) {
    if (key === specifier) return true;
    const star = key.indexOf('*');
    if (star !== -1) {
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Creates a cached lookup: is package `name` resolvable from `fromDir` through a node_modules folder
 * in `fromDir` or any parent (the way Node resolves bare specifiers)?
 *
 * @param {import('./files.js').FileCache} files
 */
export function createInstalledCheck(files) {
  /** @type {Map<string, Promise<string | null>>} */
  const cache = new Map();

  /**
   * Returns the directory of the installed package, or null.
   * @param {string} name
   * @param {string} fromDir
   */
  function findInstalled(name, fromDir) {
    const key = `${fromDir}\0${name}`;
    let p = cache.get(key);
    if (!p) {
      p = (async () => {
        for (const d of ancestorDirs(fromDir, null)) {
          const candidate = path.join(d, 'node_modules', name);
          if (await files.isDirectory(candidate)) return candidate;
        }
        return null;
      })();
      cache.set(key, p);
    }
    return p;
  }

  return {
    findInstalled,
    /** @param {string} name @param {string} fromDir */
    async isInstalled(name, fromDir) {
      return (await findInstalled(name, fromDir)) !== null;
    },
    /**
     * The installed package's package.json, or null.
     * @param {string} name @param {string} fromDir
     */
    async installedPackageJson(name, fromDir) {
      const dir = await findInstalled(name, fromDir);
      if (!dir) return null;
      const json = await files.readJson(path.join(dir, 'package.json'));
      return json && !isParseError(json) ? json : null;
    },
  };
}

/**
 * The lowest major version a semver range allows, or null if it can't be determined
 * (`*`, `latest`, `workspace:*`, git URLs, upper-bound-only ranges...).
 * For `a || b` ranges, the lowest major across the alternatives.
 *
 * @param {string | undefined} range
 * @returns {number | null}
 */
export function minMajorVersion(range) {
  if (typeof range !== 'string') return null;
  let spec = range.trim();
  const npmAlias = spec.match(/^npm:(?:@[^/]+\/)?[^@]+@(.+)$/);
  if (npmAlias) spec = npmAlias[1];

  let min = null;
  for (const alternative of spec.split('||')) {
    const part = alternative.trim();
    if (part === '' || part.startsWith('<')) return null;
    const match = part.match(/^(?:[\^~=v]|>=?)?\s*v?(\d+)(?:\.|$|\s|-|x|X|\*)/);
    if (!match) return null;
    const major = Number(match[1]);
    min = min === null ? major : Math.min(min, major);
  }
  return min;
}

/** @param {any} json */
function workspacePatternsFromPackageJson(json) {
  const ws = json.workspaces;
  if (Array.isArray(ws)) return ws.filter((p) => typeof p === 'string');
  if (ws && Array.isArray(ws.packages)) return ws.packages.filter((p) => typeof p === 'string');
  return [];
}

/**
 * Read the `packages:` list from pnpm-workspace.yaml with a minimal line parser
 * (the file is almost always a flat list; anything fancier is ignored).
 *
 * @param {string} dir
 * @param {import('./files.js').FileCache} files
 */
async function pnpmWorkspacePatterns(dir, files) {
  const text = await files.readText(path.join(dir, 'pnpm-workspace.yaml'));
  return text ? parsePnpmWorkspaceYaml(text) : [];
}

/** @param {string} text */
export function parsePnpmWorkspaceYaml(text) {
  const patterns = [];
  let inPackages = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '');
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = line.match(/^\s+-\s*(.+?)\s*$/);
    if (item) {
      patterns.push(item[1].replace(/^(['"])(.*)\1$/, '$2'));
    } else if (/^\S/.test(line)) {
      inPackages = false; // next top-level key
    }
  }
  return patterns;
}

/**
 * Expand workspace glob patterns (`packages/*`, `apps/**`, `tools/cli`, `!**\/test`) relative to
 * `rootDir` into the directories that contain a package.json.
 *
 * @param {string} rootDir
 * @param {string[]} patterns
 * @returns {Promise<string[]>}
 */
export async function expandWorkspacePatterns(rootDir, patterns) {
  const included = new Set();
  const excluded = [];
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    const pattern = (negated ? raw.slice(1) : raw).replace(/^\.\//, '').replace(/\/+$/, '');
    if (negated) {
      excluded.push(globToRegExp(pattern));
      continue;
    }
    for (const dir of await expandSegments(rootDir, pattern.split('/').filter(Boolean), 0)) included.add(dir);
  }

  const result = [];
  for (const dir of included) {
    const rel = path.relative(rootDir, dir).split(path.sep).join('/');
    if (excluded.some((re) => re.test(rel))) continue;
    try {
      await fs.access(path.join(dir, 'package.json'));
      result.push(dir);
    } catch {
      // not a package
    }
  }
  return result.sort();
}

/**
 * @param {string} base
 * @param {string[]} segments
 * @param {number} depth  Directories already consumed by `**`.
 * @returns {Promise<string[]>}
 */
async function expandSegments(base, segments, depth) {
  if (segments.length === 0) return [base];
  const [segment, ...rest] = segments;

  if (segment === '**') {
    const results = await expandSegments(base, rest, depth);
    if (depth < MAX_GLOBSTAR_DEPTH) {
      for (const sub of await subdirectories(base)) results.push(...(await expandSegments(sub, segments, depth + 1)));
    }
    return results;
  }

  if (segment.includes('*')) {
    const re = globToRegExp(segment);
    const results = [];
    for (const sub of await subdirectories(base)) {
      if (re.test(path.basename(sub))) results.push(...(await expandSegments(sub, rest, depth)));
    }
    return results;
  }

  const next = path.join(base, segment);
  try {
    if ((await fs.stat(next)).isDirectory()) return expandSegments(next, rest, depth);
  } catch {
    // missing
  }
  return [];
}

/** @param {string} dir */
async function subdirectories(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** Glob (with `*` and `**`) to an anchored RegExp over forward-slash paths. @param {string} glob */
function globToRegExp(glob) {
  let re = '';
  const parts = glob.split('/');
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    if (part === '**') {
      re += last ? '.*' : '(?:.*/)?';
    } else {
      re += part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + (last ? '' : '/');
    }
  });
  return new RegExp(`^${re}$`);
}
