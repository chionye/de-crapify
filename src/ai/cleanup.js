import { parse } from '@babel/parser';
import { analyzeTopLevel } from '../analysis/dep-graph.js';
import { findKeepRanges } from '../keep.js';
import { parseCode } from '../parse.js';
import { traverse } from '../rules/shared.js';
import { CHECKS, validateRewrite } from '../validate/index.js';
import { estimateTokens, findChunks } from './chunk.js';
import { OllamaRequestError } from './ollama.js';
import { buildUserMessage, languageLabel, SYSTEM_PROMPT } from './prompt.js';

/**
 * @typedef {object} AiFileResult
 * @property {string} output                       The file after accepted rewrites.
 * @property {string[]} reasons                    One per accepted rewrite (without the "AI: " prefix).
 * @property {{ name: string, check: import('../validate/index.js').CheckId, label: string, reason: string }[]} rejected
 * @property {{ name: string, message: string }[]} failures  Requests that failed or timed out.
 * @property {number} chunks                       Chunks sent to the model.
 */

/**
 * Stage 2 + 3 for one file: send each chunk to the model, one at a time, validate every reply, and
 * apply the ones that pass. Chunks are processed from the end of the file to the start, so applying
 * a rewrite never shifts the chunks still to come.
 *
 * @param {object} input
 * @param {string} input.source            The file after Stage 1.
 * @param {string} input.filePath
 * @param {string} input.displayPath
 * @param {import('../context/index.js').DirContext} input.ctx
 * @param {import('./ollama.js').OllamaClient} input.client
 * @param {number} input.numCtx
 * @param {(msg: string) => void} [input.log]  Verbose log.
 * @param {(name: string, index: number, total: number) => void} [input.progress]  Called before each model call.
 * @returns {Promise<AiFileResult>}
 */
export async function aiCleanupFile({ source, filePath, displayPath, ctx, client, numCtx, log = () => {}, progress = () => {} }) {
  /** @type {AiFileResult} */
  const result = { output: source, reasons: [], rejected: [], failures: [], chunks: 0 };
  const parsed = parseCode(source, filePath);
  if (!parsed.ok) return result; // Stage 1 output always parses; this is just a guard.

  const { ast, parserOptions } = parsed;
  const imports = ast.program.body.filter((s) => s.type === 'ImportDeclaration').map((s) => source.slice(s.start ?? 0, s.end ?? 0));
  const allNames = analyzeTopLevel(ast).flatMap((d) => d.names);
  const hasJsx = /<[A-Za-z>]/.test(source) && containsJsx(ast);
  const framework = ctx.packages.declared.has('react-native') || ctx.packages.declared.has('expo') ? 'react-native' : ctx.packages.declared.has('react') || hasJsx ? 'react' : null;
  const language = languageLabel(filePath, hasJsx);

  const contextTokens = estimateTokens(SYSTEM_PROMPT) + estimateTokens(imports.join('\n')) + estimateTokens(allNames.join(', ')) + 100;
  const { chunks, skipped } = findChunks({ ast, source, keepRanges: findKeepRanges(ast, source), numCtx, promptTokens: contextTokens });
  for (const s of skipped) log(`  AI skip ${s.name}: ${s.reason}`);

  let current = source;
  const accepted = [];
  for (const chunk of [...chunks].reverse()) {
    result.chunks++;
    const code = current.slice(chunk.start, chunk.end);
    const ownNames = new Set(chunk.name.split(', '));
    const user = buildUserMessage({
      code,
      displayPath,
      language,
      framework,
      imports,
      otherDeclarations: allNames.filter((n) => !ownNames.has(n)),
    });

    let reply;
    try {
      progress(chunk.name, result.chunks, chunks.length);
      log(`  AI ${chunk.name} (${chunk.lines} lines)…`);
      reply = await client.chat({ system: SYSTEM_PROMPT, user });
    } catch (error) {
      const message = error instanceof OllamaRequestError ? error.message : `unexpected error: ${/** @type {Error} */ (error).message}`;
      result.failures.push({ name: chunk.name, message });
      log(`  AI ${chunk.name}: skipped, ${message}`);
      continue;
    }

    const verdict = validateRewrite({ fileSource: current, chunk, reply: reply.content, doneReason: reply.doneReason, parserOptions });
    if (!verdict.ok) {
      result.rejected.push({ name: chunk.name, check: verdict.check, label: CHECKS[verdict.check], reason: verdict.reason });
      log(`  AI ${chunk.name}: rejected (${CHECKS[verdict.check]}): ${verdict.reason}`);
      continue;
    }
    if (!verdict.changed) {
      log(`  AI ${chunk.name}: no change`);
      continue;
    }
    const description = describeChange(code, verdict.code, parserOptions);
    log(`  AI ${chunk.name}: accepted (${description})`);
    accepted.push({ start: chunk.start, text: `${description} in \`${chunk.name}\`` });
    current = verdict.fileSource;
  }

  result.output = current;
  result.reasons = accepted.sort((a, b) => a.start - b.start).map((a) => a.text);
  return result;
}

/**
 * A short description of what a rewrite did, e.g. "removed 6 comments, flattened nested conditionals".
 * @param {string} before
 * @param {string} after
 * @param {import('@babel/parser').ParserOptions} parserOptions
 */
export function describeChange(before, after, parserOptions) {
  const a = parse(before, parserOptions);
  const b = parse(after, parserOptions);
  const parts = [];
  const removedComments = (a.comments?.length ?? 0) - (b.comments?.length ?? 0);
  if (removedComments > 0) parts.push(`removed ${removedComments} comment${removedComments === 1 ? '' : 's'}`);
  if (maxIfDepth(b) < maxIfDepth(a)) parts.push('flattened nested conditionals');
  const removedVars = countDeclarators(a) - countDeclarators(b);
  if (removedVars > 0) parts.push(`removed ${removedVars} redundant variable${removedVars === 1 ? '' : 's'}`);
  if (parts.length === 0) parts.push('simplified code');
  return parts.join(', ');
}

/** @param {import('@babel/types').File} ast */
function maxIfDepth(ast) {
  let max = 0;
  traverse(ast, {
    noScope: true,
    IfStatement(path) {
      let depth = 1;
      for (let p = path.parentPath; p; p = p.parentPath) if (p.isIfStatement()) depth++;
      max = Math.max(max, depth);
    },
  });
  return max;
}

/** @param {import('@babel/types').File} ast */
function countDeclarators(ast) {
  let count = 0;
  traverse(ast, {
    noScope: true,
    VariableDeclarator() {
      count++;
    },
  });
  return count;
}

/** @param {import('@babel/types').File} ast */
function containsJsx(ast) {
  let found = false;
  traverse(ast, {
    noScope: true,
    'JSXElement|JSXFragment'(path) {
      found = true;
      path.stop();
    },
  });
  return found;
}

