import { overlaps } from '../rules/shared.js';

/** Chunks shorter than this aren't worth a model call. */
export const MIN_CHUNK_LINES = 5;

/** Rough characters-per-token for code, used to keep a chunk (and its rewrite) inside num_ctx. */
const CHARS_PER_TOKEN = 3.5;

/**
 * @typedef {object} Chunk
 * @property {string} name     The declared name(s), for messages.
 * @property {number} start    Start in the source (including attached `//` comments).
 * @property {number} end      End of the statement.
 * @property {number} lines
 */

/**
 * @typedef {object} SkippedChunk
 * @property {string} name
 * @property {string} reason
 */

/**
 * Split a file into chunks for the AI: each top-level function, class, function-valued variable
 * (arrow components, `memo(...)`/`forwardRef(...)` wrappers) or exported value. Everything else
 * (imports, plain statements, TypeScript types and interfaces) is left alone.
 *
 * A chunk includes the `//` line comments directly above it (no blank line in between), so
 * narrating comments there can be removed. Block comments and JSDoc above it stay outside the chunk,
 * so the model can't touch them.
 *
 * @param {object} input
 * @param {import('@babel/types').File} input.ast
 * @param {string} input.source
 * @param {import('../rules/shared.js').Range[]} input.keepRanges
 * @param {number} input.numCtx        The context window; chunks that wouldn't fit are skipped.
 * @param {number} input.promptTokens  Tokens taken by the system prompt and context.
 * @returns {{ chunks: Chunk[], skipped: SkippedChunk[] }}
 */
export function findChunks({ ast, source, keepRanges, numCtx, promptTokens }) {
  /** @type {Chunk[]} */
  const chunks = [];
  /** @type {SkippedChunk[]} */
  const skipped = [];
  const body = ast.program.body;

  for (let i = 0; i < body.length; i++) {
    const statement = body[i];
    const name = chunkName(statement);
    if (!name) continue;

    const end = /** @type {number} */ (statement.end);
    const start = attachedLineCommentsStart(statement, source, ast.comments ?? [], i > 0 ? /** @type {number} */ (body[i - 1].end) : 0);
    const lines = (statement.loc?.end.line ?? 0) - (statement.loc?.start.line ?? 0) + 1;

    if (keepRanges.some((r) => r.start <= /** @type {number} */ (statement.start) && r.end >= end)) {
      skipped.push({ name, reason: 'marked de-crapify-keep' });
      continue;
    }
    if (lines < MIN_CHUNK_LINES) {
      skipped.push({ name, reason: `only ${lines} line${lines === 1 ? '' : 's'}` });
      continue;
    }
    // The reply is about as long as the chunk, so both must fit next to the prompt.
    const chunkTokens = Math.ceil((end - start) / CHARS_PER_TOKEN);
    if (promptTokens + chunkTokens * 2 > numCtx) {
      skipped.push({ name, reason: `too large for --num-ctx ${numCtx} (~${chunkTokens} tokens)` });
      continue;
    }
    // A keep marker that covers the attached comments but not the statement: start after it.
    const chunk = { name, start, end, lines };
    const partialKeep = keepRanges.find((r) => overlaps(r, chunk) && r.start < /** @type {number} */ (statement.start));
    if (partialKeep) chunk.start = /** @type {number} */ (statement.start);
    chunks.push(chunk);
  }
  return { chunks, skipped };
}

/**
 * The name to show for a chunk-worthy statement, or null if the statement isn't a chunk.
 * @param {import('@babel/types').Statement} statement
 * @returns {string | null}
 */
export function chunkName(statement) {
  let node = /** @type {any} */ (statement);
  let exported = false;
  if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
    exported = true;
    node = node.declaration;
    if (!node) return null;
  }
  switch (node.type) {
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
      return node.id?.name ?? 'default export';
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
    case 'ClassExpression':
      return 'default export';
    case 'VariableDeclaration': {
      const names = node.declarations.map((/** @type {any} */ d) => (d.id.type === 'Identifier' ? d.id.name : null)).filter(Boolean);
      if (names.length === 0) return null;
      const functionLike = node.declarations.some((/** @type {any} */ d) => isFunctionLike(d.init));
      return functionLike || exported ? names.join(', ') : null;
    }
    default:
      // TS interfaces, types, enums and `declare`s are left alone: their members aren't covered by
      // the signature check, so a model could drop a field unnoticed.
      return null;
  }
}

/** @param {any} init */
function isFunctionLike(init) {
  if (!init) return false;
  if (['ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression'].includes(init.type)) return true;
  if (init.type === 'CallExpression') return init.arguments.some(isFunctionLike);
  return false;
}

/**
 * Where a statement's attached `//` comments start: consecutive line comments directly above it,
 * after the previous statement, with no blank line in between.
 *
 * @param {import('@babel/types').Statement} statement
 * @param {string} source
 * @param {import('@babel/types').Comment[]} comments
 * @param {number} previousEnd
 */
function attachedLineCommentsStart(statement, source, comments, previousEnd) {
  let start = /** @type {number} */ (statement.start);
  const candidates = comments
    .filter((c) => /** @type {number} */ (c.end) <= start && /** @type {number} */ (c.start) >= previousEnd)
    .sort((a, b) => /** @type {number} */ (b.start) - /** @type {number} */ (a.start));
  for (const comment of candidates) {
    if (comment.type !== 'CommentLine') break;
    const between = source.slice(/** @type {number} */ (comment.end), start);
    if (!/^[ \t]*\r?\n[ \t]*$/.test(between)) break; // must be the line directly above
    const lineStart = source.lastIndexOf('\n', /** @type {number} */ (comment.start) - 1) + 1;
    if (source.slice(lineStart, comment.start).trim() !== '') break; // a trailing comment of other code
    start = /** @type {number} */ (comment.start);
  }
  return start;
}

/** Rough token count of a text. @param {string} text */
export function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
