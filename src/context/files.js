import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Parse JSON that may contain comments and trailing commas (tsconfig.json, jsconfig.json, .babelrc).
 * Throws on anything else that isn't valid JSON.
 *
 * @param {string} text
 * @returns {any}
 */
export function parseJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      // Copy the string literal verbatim, honoring escapes.
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  // Second pass (string-aware) to drop trailing commas before } or ].
  return JSON.parse(removeTrailingCommas(out));
}

/** @param {string} text */
function removeTrailingCommas(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Small async file helpers with a shared cache, so a run reads each config file at most once.
 */
export function createFileCache() {
  /** @type {Map<string, Promise<string | null>>} */
  const texts = new Map();
  /** @type {Map<string, Promise<'file' | 'dir' | 'other' | null>>} */
  const kinds = new Map();

  /** @param {string} file */
  function statKind(file) {
    let p = kinds.get(file);
    if (!p) {
      p = fs.stat(file).then(
        (st) => (st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other'),
        () => null,
      );
      kinds.set(file, p);
    }
    return p;
  }

  /** @param {string} file */
  function readText(file) {
    let p = texts.get(file);
    if (!p) {
      p = fs.readFile(file, 'utf8').catch(() => null);
      texts.set(file, p);
    }
    return p;
  }

  return {
    readText,

    /**
     * Read and parse a JSON/JSONC file. Returns null if missing; `{ error }` if unparseable.
     * @param {string} file
     * @returns {Promise<any>}
     */
    async readJson(file) {
      const text = await readText(file);
      if (text === null) return null;
      try {
        return parseJsonc(text);
      } catch (error) {
        return { __parseError: /** @type {Error} */ (error).message };
      }
    },

    /** @param {string} file */
    exists(file) {
      return statKind(file).then((kind) => kind !== null);
    },

    /** @param {string} file */
    isFile(file) {
      return statKind(file).then((kind) => kind === 'file');
    },

    /** @param {string} dir */
    isDirectory(dir) {
      return statKind(dir).then((kind) => kind === 'dir');
    },
  };
}

/** @typedef {ReturnType<typeof createFileCache>} FileCache */

/**
 * Directories from `startDir` up to and including `stopDir` (or the filesystem root).
 * If `startDir` isn't inside `stopDir`, walks to the filesystem root.
 *
 * @param {string} startDir
 * @param {string | null} stopDir
 * @returns {string[]}
 */
export function ancestorDirs(startDir, stopDir) {
  const dirs = [];
  let dir = path.resolve(startDir);
  const stop = stopDir ? path.resolve(stopDir) : null;
  const insideStop = stop !== null && (dir === stop || dir.startsWith(stop + path.sep));
  while (true) {
    dirs.push(dir);
    if (insideStop && dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/** Whether a parsed JSON value is the parse-error marker from readJson. */
export function isParseError(value) {
  return value !== null && typeof value === 'object' && '__parseError' in value;
}
