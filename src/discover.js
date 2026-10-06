import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import ignore from 'ignore';
import { SetupError } from './errors.js';
import { isSupportedFile } from './parse.js';

const execFileAsync = promisify(execFile);

/** Directory names that are never walked into, at any depth below the target. */
export const ALWAYS_SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.expo',
  '.turbo',
  '.cache',
]);

/** Native folders of a React Native project; skipped only next to a package.json that uses RN/Expo. */
const NATIVE_DIRS = new Set(['android', 'ios']);

export const MAX_LINE_LENGTH = 1000;

export const SKIP_REASONS = Object.freeze({
  TOO_LARGE: 'too large',
  MINIFIED: 'minified',
  GENERATED: 'generated (@generated)',
  IGNORED: 'ignored (de-crapify-ignore-file)',
  UNSUPPORTED: 'unsupported file type',
  SYMLINK: 'symlink',
  UNPARSEABLE: 'could not parse',
});

/**
 * @typedef {{ file: string, reason: string }} SkippedFile
 * @typedef {{ root: string, isDirectory: boolean, gitRoot: string | null, files: string[], skipped: SkippedFile[] }} Discovery
 */

/**
 * Find the files to process under `targetPath` (a file or a directory).
 * Returned paths are absolute and sorted.
 *
 * @param {string} targetPath
 * @param {{ maxFileSizeBytes: number, listGitFiles?: typeof gitListFiles }} options
 * @returns {Promise<Discovery>}
 */
export async function discoverFiles(targetPath, { maxFileSizeBytes, listGitFiles = gitListFiles }) {
  const root = path.resolve(targetPath);
  let stat;
  try {
    stat = await fs.lstat(root);
  } catch {
    throw new SetupError(`Path not found: ${targetPath}`);
  }

  /** @type {SkippedFile[]} */
  const skipped = [];

  if (stat.isSymbolicLink()) {
    throw new SetupError(`Path is a symlink; pass the real path instead: ${targetPath}`);
  }

  if (stat.isFile()) {
    const gitRoot = await findGitRoot(path.dirname(root));
    if (!isSupportedFile(root)) {
      skipped.push({ file: root, reason: SKIP_REASONS.UNSUPPORTED });
      return { root, isDirectory: false, gitRoot, files: [], skipped };
    }
    const files = [];
    await addIfSmallEnough(root, stat.size, maxFileSizeBytes, files, skipped);
    return { root, isDirectory: false, gitRoot, files, skipped };
  }

  if (!stat.isDirectory()) {
    throw new SetupError(`Not a file or directory: ${targetPath}`);
  }

  const gitRoot = await findGitRoot(root);
  /** @type {string[] | null} */
  let candidates = null;
  if (gitRoot) {
    candidates = await listGitFiles(root);
  }
  candidates ??= await walkWithGitignore(root);

  const isNativeDir = createNativeDirCheck();
  const files = [];
  for (const file of candidates) {
    const rel = path.relative(root, file);
    if (!isSupportedFile(file)) continue;
    if (await isExcludedPath(root, rel, isNativeDir)) continue;

    let fileStat;
    try {
      fileStat = await fs.lstat(file);
    } catch {
      continue; // Tracked by git but deleted from the working tree.
    }
    if (fileStat.isSymbolicLink()) {
      // Writing through a symlink could change a file outside the target.
      skipped.push({ file, reason: SKIP_REASONS.SYMLINK });
      continue;
    }
    if (!fileStat.isFile()) continue;
    await addIfSmallEnough(file, fileStat.size, maxFileSizeBytes, files, skipped);
  }

  files.sort();
  return { root, isDirectory: true, gitRoot, files, skipped };
}

/**
 * Decide whether a file must be skipped based on its contents.
 * Returns the skip reason, or null when the file should be processed.
 *
 * @param {string} source
 * @returns {string | null}
 */
export function contentSkipReason(source) {
  if (/(?:\/\/|\/\*)\s*de-crapify-ignore-file\b/.test(source)) return SKIP_REASONS.IGNORED;
  // Only count the generated marker when it sits on a comment line (`//`, `/*` or ` *`).
  if (/^[ \t]*(?:\/\/|\/\*|\*).*@generated\b/m.test(source)) return SKIP_REASONS.GENERATED;
  let lineStart = 0;
  while (lineStart <= source.length) {
    let lineEnd = source.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = source.length;
    if (lineEnd - lineStart > MAX_LINE_LENGTH) return SKIP_REASONS.MINIFIED;
    lineStart = lineEnd + 1;
  }
  return null;
}

/**
 * Walk up from `startDir` looking for a `.git` directory or file (worktrees/submodules use a file).
 * @param {string} startDir
 * @returns {Promise<string | null>}
 */
export async function findGitRoot(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    try {
      await fs.stat(path.join(dir, '.git'));
      return dir;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * List tracked and untracked-but-not-ignored files under `dir`, using git's own ignore semantics
 * (nested .gitignore files, .git/info/exclude, global excludes). Returns null if git isn't usable,
 * so the caller can fall back to walking the tree.
 *
 * @param {string} dir
 * @returns {Promise<string[] | null>}
 */
export async function gitListFiles(dir) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
      { cwd: dir, maxBuffer: 256 * 1024 * 1024 },
    );
    const seen = new Set();
    for (const rel of stdout.split('\0')) {
      if (rel) seen.add(path.resolve(dir, rel));
    }
    return [...seen];
  } catch {
    return null;
  }
}

/**
 * Recursively list files under `root` without git, applying every .gitignore found in the walked
 * directories plus the nearest one above `root`. Skipped directories aren't descended into.
 *
 * @param {string} root
 * @returns {Promise<string[]>}
 */
export async function walkWithGitignore(root) {
  /** @type {{ dir: string, ig: import('ignore').Ignore }[]} */
  const initial = [];
  const above = await nearestGitignoreAbove(root);
  if (above) initial.push(above);

  const isNativeDir = createNativeDirCheck();
  /** @type {string[]} */
  const files = [];

  /** @param {string} dir @param {typeof initial} matchers */
  async function walk(dir, matchers) {
    const own = await loadGitignore(dir);
    const active = own ? [...matchers, { dir, ig: own }] : matchers;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const isDir = entry.isDirectory();
      if (isGitignored(full, isDir, active)) continue;
      if (isDir) {
        const rel = path.relative(root, full);
        if (await isExcludedPath(root, rel, isNativeDir, { isDirectory: true })) continue;
        await walk(full, active);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(full);
      }
    }
  }

  await walk(root, initial);
  return files;
}

/**
 * Path-based exclusions, relative to the target root: always-skipped directories, anything
 * starting with a dot, and React Native native folders.
 *
 * @param {string} root
 * @param {string} rel  Path relative to root.
 * @param {(dir: string) => Promise<boolean>} isNativeDir
 * @param {{ isDirectory?: boolean }} [kind]  Whether `rel` itself is a directory.
 */
async function isExcludedPath(root, rel, isNativeDir, { isDirectory = false } = {}) {
  const segments = rel.split(path.sep).filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.startsWith('.')) return true;
    if (!isDirectory && i === segments.length - 1) break;
    if (ALWAYS_SKIP_DIRS.has(segment)) return true;
    if (NATIVE_DIRS.has(segment) && (await isNativeDir(path.join(root, ...segments.slice(0, i))))) {
      return true;
    }
  }
  return false;
}

/** Returns a cached check: does `dir/package.json` depend on react-native or expo? */
function createNativeDirCheck() {
  /** @type {Map<string, Promise<boolean>>} */
  const cache = new Map();
  return (/** @type {string} */ dir) => {
    let result = cache.get(dir);
    if (!result) {
      result = usesReactNative(dir);
      cache.set(dir, result);
    }
    return result;
  };
}

/** @param {string} dir */
async function usesReactNative(dir) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const deps = pkg[field] ?? {};
      if ('react-native' in deps || 'expo' in deps) return true;
    }
  } catch {
    // no or unreadable package.json
  }
  return false;
}

/**
 * @param {string} file
 * @param {number} size
 * @param {number} maxFileSizeBytes
 * @param {string[]} files
 * @param {SkippedFile[]} skipped
 */
async function addIfSmallEnough(file, size, maxFileSizeBytes, files, skipped) {
  if (/\.min\.[cm]?[jt]sx?$/.test(file)) {
    skipped.push({ file, reason: SKIP_REASONS.MINIFIED });
  } else if (size > maxFileSizeBytes) {
    skipped.push({ file, reason: SKIP_REASONS.TOO_LARGE });
  } else {
    files.push(file);
  }
}

/** @param {string} dir */
async function loadGitignore(dir) {
  try {
    const content = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
    return ignore().add(content);
  } catch {
    return null;
  }
}

/** @param {string} root */
async function nearestGitignoreAbove(root) {
  let dir = path.dirname(root);
  while (true) {
    const ig = await loadGitignore(dir);
    if (ig) return { dir, ig };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * @param {string} full
 * @param {boolean} isDir
 * @param {{ dir: string, ig: import('ignore').Ignore }[]} matchers
 */
function isGitignored(full, isDir, matchers) {
  for (const { dir, ig } of matchers) {
    let rel = path.relative(dir, full).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) continue;
    if (isDir) rel += '/';
    if (ig.ignores(rel)) return true;
  }
  return false;
}
