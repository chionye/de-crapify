import { SetupError } from './errors.js';

export const DEFAULTS = Object.freeze({
  model: 'qwen2.5-coder:7b',
  ollamaUrl: 'http://localhost:11434',
  numCtx: 8192,
  maxFileSize: 200,
  keepConsole: 'error,warn',
});

/**
 * @typedef {object} Options
 * @property {string} targetPath        The file or directory to clean, as given.
 * @property {boolean} write
 * @property {boolean} check
 * @property {boolean} force
 * @property {boolean} ai
 * @property {'auto' | 'builtin' | 'ollama'} aiProvider
 * @property {boolean} yes             Allow the one-time model download without asking.
 * @property {boolean} ollamaExplicit  --model or --ollama-url was given: the user wants Ollama.
 * @property {string} model
 * @property {string} ollamaUrl         Without a trailing slash.
 * @property {number} numCtx
 * @property {'auto' | boolean} typecheck
 * @property {string | undefined} testCmd
 * @property {number} maxFileSizeBytes
 * @property {Set<string>} keepConsole  Console methods that are never removed.
 * @property {boolean} verbose
 */

/**
 * Turn commander's raw option values into a validated {@link Options} object.
 * Throws {@link SetupError} on invalid or conflicting values.
 *
 * @param {string} targetPath
 * @param {Record<string, any>} raw
 * @returns {Options}
 */
export function normalizeOptions(targetPath, raw) {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new SetupError('Missing <path> to clean.');
  }

  const write = Boolean(raw.write);
  const check = Boolean(raw.check);
  if (write && check) {
    throw new SetupError('--check and --write cannot be used together.', {
      hint: '--check never writes; use it in CI, and --write locally.',
    });
  }

  const testCmd = typeof raw.testCmd === 'string' && raw.testCmd.trim() !== '' ? raw.testCmd : undefined;

  const aiProvider = raw.aiProvider ?? 'auto';
  if (!['auto', 'builtin', 'ollama'].includes(aiProvider)) {
    throw new SetupError(`--ai-provider must be auto, builtin or ollama, got "${aiProvider}".`);
  }

  return {
    targetPath,
    write,
    check,
    force: Boolean(raw.force),
    ai: raw.ai !== false,
    aiProvider,
    yes: Boolean(raw.yes),
    ollamaExplicit: raw.model !== undefined || raw.ollamaUrl !== undefined,
    model: nonEmptyString(raw.model ?? DEFAULTS.model, '--model'),
    ollamaUrl: parseUrl(raw.ollamaUrl ?? DEFAULTS.ollamaUrl),
    numCtx: positiveInteger(raw.numCtx ?? DEFAULTS.numCtx, '--num-ctx'),
    typecheck: raw.typecheck === undefined ? 'auto' : Boolean(raw.typecheck),
    testCmd,
    maxFileSizeBytes: Math.round(positiveNumber(raw.maxFileSize ?? DEFAULTS.maxFileSize, '--max-file-size') * 1024),
    keepConsole: parseList(raw.keepConsole ?? DEFAULTS.keepConsole),
    verbose: Boolean(raw.verbose),
  };
}

/**
 * Options that are accepted but have no effect in the chosen mode, so the CLI can say so
 * instead of silently ignoring them.
 * @param {Options} options
 * @returns {string[]}
 */
export function ineffectiveOptionWarnings(options) {
  const warnings = [];
  if (options.testCmd && !options.write) {
    warnings.push('--test-cmd only runs with --write; ignoring it for this run.');
  }
  if (options.force && !options.write) {
    warnings.push('--force only matters with --write; ignoring it for this run.');
  }
  return warnings;
}

/** @param {unknown} value @param {string} flag */
function nonEmptyString(value, flag) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SetupError(`${flag} needs a value.`);
  }
  return value.trim();
}

/** @param {unknown} value @param {string} flag */
function positiveInteger(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new SetupError(`${flag} must be a positive whole number, got "${value}".`);
  }
  return n;
}

/** @param {unknown} value @param {string} flag */
function positiveNumber(value, flag) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new SetupError(`${flag} must be a positive number, got "${value}".`);
  }
  return n;
}

/** @param {unknown} value */
function parseUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new SetupError(`--ollama-url is not a valid URL: "${value}".`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SetupError(`--ollama-url must be an http(s) URL, got "${value}".`);
  }
  return url.href.replace(/\/+$/, '');
}

/** @param {unknown} value */
function parseList(value) {
  return new Set(
    String(value)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
