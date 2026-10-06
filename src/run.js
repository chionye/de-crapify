import fs from 'node:fs/promises';
import path from 'node:path';
import { aiCleanupFile } from './ai/cleanup.js';
import { createOllamaClient } from './ai/ollama.js';
import { createProjectContext, describeContext } from './context/index.js';
import { contentSkipReason, discoverFiles, SKIP_REASONS } from './discover.js';
import { EXIT } from './errors.js';
import { ineffectiveOptionWarnings } from './options.js';
import { parseCode } from './parse.js';
import { runDeterministicRules } from './rules/index.js';
import { formatDiff, formatReasons } from './output/diff.js';
import { formatReports } from './output/reports.js';
import { createStats, formatSummary, recordAiRejection, reportCounts } from './output/summary.js';
import { loadProjectTypeScript, typecheckChanges } from './typecheck.js';

/**
 * @typedef {object} RunIO
 * @property {(text: string) => void} out   Normal output (diffs, summary).
 * @property {(text: string) => void} err   Warnings and verbose logs.
 * @property {import('chalk').ChalkInstance} chalk
 * @property {string} cwd
 */

/**
 * @typedef {object} FileResult
 * @property {string} file
 * @property {string} before         Content on disk.
 * @property {string} stage1         After the deterministic rules.
 * @property {string} after          Final content (after AI cleanup and any typecheck reverts).
 * @property {string[]} stage1Reasons
 * @property {string[]} aiReasons
 * @property {string | null} tsconfigPath
 */

/**
 * @typedef {object} RunDeps  Injectable for tests.
 * @property {(fromDir: string) => any} [loadTypeScript]
 * @property {typeof globalThis.fetch} [fetch]   Used for Ollama.
 */

/**
 * Run `de-crapify clean` with validated options. Returns the process exit code.
 * Setup problems are thrown as SetupError and turned into exit code 2 by the caller.
 *
 * @param {import('./options.js').Options} options
 * @param {RunIO} io
 * @param {RunDeps} [deps]
 * @returns {Promise<number>}
 */
export async function runClean(options, io, deps = {}) {
  const { chalk } = io;
  const verbose = (/** @type {string} */ msg) => {
    if (options.verbose) io.err(chalk.dim(msg));
  };

  for (const warning of ineffectiveOptionWarnings(options)) io.err(chalk.yellow(warning));
  if (options.write) {
    io.err(chalk.yellow('--write is not implemented yet in this build; nothing will be written.'));
  }

  const stats = createStats();
  stats.aiStatus = 'off (--no-ai)';

  const discovery = await discoverFiles(path.resolve(io.cwd, options.targetPath), { maxFileSizeBytes: options.maxFileSizeBytes });
  stats.skipped.push(...discovery.skipped);
  verbose(`Found ${discovery.files.length} candidate file(s) under ${displayPath(discovery.root, io.cwd)}`);
  if (discovery.gitRoot) verbose(`Git root: ${discovery.gitRoot}`);

  /** @type {import('./ai/ollama.js').OllamaClient | null} */
  let client = null;
  if (options.ai) {
    client = createOllamaClient({ baseUrl: options.ollamaUrl, model: options.model, numCtx: options.numCtx, fetch: deps.fetch });
    await client.preflight(); // throws SetupError (exit 2) if Ollama or the model isn't there
    verbose(`Ollama: ${options.ollamaUrl}, model ${options.model}, num_ctx ${options.numCtx}`);
  }
  const aiTotals = { chunks: 0, failures: 0 };

  const context = createProjectContext({ stopDir: discovery.gitRoot });
  const describedContexts = new Set();

  /** @type {FileResult[]} */
  const results = [];
  for (const file of discovery.files) {
    const ctx = await context.forFile(file);
    const contextKey = `${ctx.packages.nearest?.path}|${ctx.tsconfig?.path}`;
    if (options.verbose && !describedContexts.has(contextKey)) {
      describedContexts.add(contextKey);
      verbose(`Project context for ${displayPath(ctx.dir, io.cwd)}:`);
      for (const line of describeContext(ctx, io.cwd)) verbose(`  ${line}`);
    }
    const result = await processFile(file, { stats, verbose, ctx, files: context.files, options, client, aiTotals, io });
    if (result && result.after !== result.before) results.push(result);
  }

  if (client) {
    const failed = aiTotals.failures ? `, ${aiTotals.failures} request(s) failed or timed out` : '';
    stats.aiStatus = `${options.model} (${aiTotals.chunks} chunk(s) sent${failed})`;
  }

  typecheck(results, { options, io, stats, verbose, loadTypeScript: deps.loadTypeScript });

  for (const result of results) {
    if (result.after === result.before) continue;
    stats.filesChanged++;
    stats.deterministicFixes += result.stage1Reasons.length;
    stats.aiAccepted += result.aiReasons.length;
    io.out(formatDiff(displayPath(result.file, io.cwd), result.before, result.after, { chalk }));
    io.out(formatReasons(currentReasons(result), { chalk }));
    io.out('');
  }

  const reports = formatReports(stats.reports, { chalk, cwd: io.cwd });
  if (reports) {
    io.out(reports);
    io.out('');
  }

  io.out(formatSummary(stats, { chalk, cwd: io.cwd, verbose: options.verbose, write: options.write }));

  if (options.check) {
    const foundSomething = stats.filesChanged > 0 || reportCounts(stats).hallucinatedImport > 0;
    return foundSomething ? EXIT.CLEANUPS_FOUND : EXIT.OK;
  }
  return EXIT.OK;
}

/**
 * Read, filter, parse and clean one file. Returns null when the file is skipped.
 *
 * @param {string} file
 * @param {object} deps
 * @param {import('./output/summary.js').Stats} deps.stats
 * @param {(msg: string) => void} deps.verbose
 * @param {import('./context/index.js').DirContext} deps.ctx
 * @param {import('./context/files.js').FileCache} deps.files
 * @param {import('./options.js').Options} deps.options
 * @param {import('./ai/ollama.js').OllamaClient | null} deps.client
 * @param {{ chunks: number, failures: number }} deps.aiTotals
 * @param {RunIO} deps.io
 * @returns {Promise<FileResult | null>}
 */
async function processFile(file, { stats, verbose, ctx, files, options, client, aiTotals, io }) {
  const source = await fs.readFile(file, 'utf8');
  const skipReason = contentSkipReason(source);
  if (skipReason) {
    stats.skipped.push({ file, reason: skipReason });
    verbose(`skip ${file}: ${skipReason}`);
    return null;
  }

  const parsed = parseCode(source, file);
  if (!parsed.ok) {
    stats.skipped.push({ file, reason: SKIP_REASONS.UNPARSEABLE });
    verbose(`skip ${file}: ${parsed.error.message}`);
    return null;
  }

  stats.filesScanned++;
  verbose(`scanned ${file}`);

  const stage1 = await runDeterministicRules({ source, ast: parsed.ast, filePath: file, ctx, files, options });
  for (const note of stage1.notes) verbose(`  ${note}`);
  stats.reports.push(...stage1.reports.map((r) => ({ ...r, file })));

  let after = stage1.output;
  /** @type {string[]} */
  let aiReasons = [];
  if (client) {
    const shown = displayPath(file, io.cwd);
    const ai = await aiCleanupFile({
      source: stage1.output,
      filePath: file,
      displayPath: shown,
      ctx,
      client,
      numCtx: options.numCtx,
      log: verbose,
      progress: (name, index, total) => {
        if (!options.verbose) io.err(io.chalk.dim(`AI ${shown} › ${name} (${index}/${total})`));
      },
    });
    after = ai.output;
    aiReasons = ai.reasons;
    aiTotals.chunks += ai.chunks;
    aiTotals.failures += ai.failures.length;
    for (const rejection of ai.rejected) recordAiRejection(stats, rejection.label);
  }

  return {
    file,
    before: source,
    stage1: stage1.output,
    after,
    stage1Reasons: stage1.reasons,
    aiReasons,
    tsconfigPath: ctx.typescript.tsconfigPath,
  };
}

/**
 * The project-level typecheck: changed files that introduce new type errors are changed back
 * (AI changes first, then everything). Updates results and stats in place.
 *
 * @param {FileResult[]} results
 * @param {object} env
 * @param {import('./options.js').Options} env.options
 * @param {RunIO} env.io
 * @param {import('./output/summary.js').Stats} env.stats
 * @param {(msg: string) => void} env.verbose
 * @param {(fromDir: string) => any} [env.loadTypeScript]
 */
function typecheck(results, { options, io, stats, verbose, loadTypeScript = loadProjectTypeScript }) {
  if (options.typecheck === false) {
    stats.typecheckStatus = 'off (--no-typecheck)';
    return;
  }
  let outcome;
  try {
    outcome = typecheckChanges({ files: results, loadTypeScript, cwd: io.cwd });
  } catch (error) {
    stats.typecheckStatus = `failed (${/** @type {Error} */ (error).message})`;
    io.err(io.chalk.yellow(`Typecheck failed to run: ${/** @type {Error} */ (error).message}`));
    return;
  }
  stats.typecheckStatus = outcome.status;
  if (options.typecheck === true && !outcome.ran) io.err(io.chalk.yellow(`--typecheck: ${outcome.status}`));
  for (const revert of outcome.reverts) {
    const result = results.find((r) => r.file === revert.file);
    if (!result) continue;
    result.after = revert.revertedTo === 'stage1' ? result.stage1 : result.before;
    if (revert.revertedTo === 'stage1') result.aiReasons = [];
    const what = revert.revertedTo === 'stage1' ? 'dropped the AI changes' : 'left the file unchanged';
    stats.reverted.push({ file: result.file, reason: `new type errors, ${what} (${revert.errors[0] ?? 'see tsc'})` });
    verbose(`typecheck: ${result.file}: ${revert.errors.join('; ')}`);
  }
}

/** @param {FileResult} result */
function currentReasons(result) {
  if (result.after === result.before) return [];
  return [...result.stage1Reasons, ...result.aiReasons.map((r) => `AI: ${r}`)];
}

/** @param {string} file @param {string} cwd */
function displayPath(file, cwd) {
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : file;
}
