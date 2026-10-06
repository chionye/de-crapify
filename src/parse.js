import path from 'node:path';
import { parse } from '@babel/parser';

/** Extensions de-crapify processes in v1. */
export const SUPPORTED_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

const DECLARATION_FILE = /\.d\.(c|m)?ts$/;

/**
 * Whether a file path is one we should try to process (supported extension, not a declaration file).
 * @param {string} filePath
 */
export function isSupportedFile(filePath) {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath)) && !DECLARATION_FILE.test(filePath);
}

/** @param {string} filePath */
export function isTypeScriptFile(filePath) {
  return ['.ts', '.tsx', '.mts', '.cts'].includes(path.extname(filePath));
}

const COMMON_PLUGINS = ['classProperties', 'topLevelAwait', 'importAttributes'];

// TS parameter decorators (`@Body() dto`, NestJS) only parse with `decorators-legacy`, which in turn
// rejects `export @dec class`. Try the likelier one first and fall back to the other.
const DECORATORS_MODERN = /** @type {const} */ (['decorators', {}]);
const DECORATORS_LEGACY = 'decorators-legacy';

/**
 * The ordered list of Babel parser option sets to try for a file. The first one that parses wins.
 * @param {string} filePath
 * @returns {import('@babel/parser').ParserOptions[]}
 */
export function parserAttemptsFor(filePath) {
  const ext = path.extname(filePath);
  /** @type {any[]} */
  let base;
  /** @type {any[]} */
  let decoratorOrder;
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') {
    // No `jsx` here: with it, generic arrows like `<T>(x: T) => x` fail to parse.
    base = ['typescript'];
    decoratorOrder = [DECORATORS_LEGACY, DECORATORS_MODERN];
  } else if (ext === '.tsx') {
    base = ['typescript', 'jsx'];
    decoratorOrder = [DECORATORS_LEGACY, DECORATORS_MODERN];
  } else {
    // React Native and many React projects put JSX in plain `.js` files.
    base = ['jsx'];
    decoratorOrder = [DECORATORS_MODERN, DECORATORS_LEGACY];
  }

  const sourceTypes = ext === '.cjs' || ext === '.cts' ? ['script', 'module'] : ['module', 'script'];

  const attempts = [];
  for (const sourceType of sourceTypes) {
    for (const decorators of decoratorOrder) {
      attempts.push({
        sourceType,
        plugins: [...base, decorators, ...COMMON_PLUGINS],
        allowReturnOutsideFunction: sourceType === 'script',
        errorRecovery: false,
      });
    }
  }
  return /** @type {any} */ (attempts);
}

/**
 * Parse source code with the settings for its file type.
 * Returns the AST together with the parser options that worked, so later steps (e.g. validating an
 * AI-rewritten chunk) can reuse exactly the same settings.
 *
 * @param {string} code
 * @param {string} filePath
 * @returns {{ ok: true, ast: import('@babel/types').File, parserOptions: import('@babel/parser').ParserOptions } | { ok: false, error: Error }}
 */
export function parseCode(code, filePath) {
  /** @type {Error | undefined} */
  let firstError;
  for (const parserOptions of parserAttemptsFor(filePath)) {
    try {
      const ast = parse(code, parserOptions);
      return { ok: true, ast, parserOptions };
    } catch (error) {
      firstError ??= /** @type {Error} */ (error);
    }
  }
  return { ok: false, error: /** @type {Error} */ (firstError) };
}
