import fs from 'node:fs/promises';
import path from 'node:path';
import { createProjectContext, describeContext } from './context/index.js';
import { contentSkipReason, discoverFiles, SKIP_REASONS } from './discover.js';
import { EXIT } from './errors.js';
import { ineffectiveOptionWarnings } from './options.js';
import { parseCode } from './parse.js';
import { runDeterministicRules } from './rules/index.js';
import { formatDiff, formatReasons } from './output/diff.js';
import { formatReports } from './output/reports.js';
import { createStats, formatSummary, reportCounts } from './output/summary.js';

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
 * @property {string} before
 * @property {string} after
 * @property {string[]} reasons
 */

/**
 * Run `de-crapify clean` with validated options. Returns the process exit code.
 * Setup problems are thrown as SetupError and turned into exit code 2 by the caller.
 *
 * @param {import('./options.js').Options} options
 * @param {RunIO} io
 * @returns {Promise<number>}
 */
export async function runClean(options, io) {
  const { chalk } = io;
  const verbose = (/** @type {string} */ msg) => {
    if (options.verbose) io.err(chalk.dim(msg));
  };

  for (const warning of ineffectiveOptionWarnings(options)) io.err(chalk.yellow(warning));
  if (options.write) {
    io.err(chalk.yellow('--write is not implemented yet in this build; nothing will be written.'));
  }

  const stats = createStats();
  stats.aiStatus = options.ai ? 'not available yet in this build' : 'off (--no-ai)';
  stats.typecheckStatus = 'not available yet in this build';

  const discovery = await discoverFiles(path.resolve(io.cwd, options.targetPath), { maxFileSizeBytes: options.maxFileSizeBytes });
  stats.skipped.push(...discovery.skipped);
  verbose(`Found ${discovery.files.length} candidate file(s) under ${displayPath(discovery.root, io.cwd)}`);
  if (discovery.gitRoot) verbose(`Git root: ${discovery.gitRoot}`);

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
    const result = await processFile(file, { stats, verbose, ctx, files: context.files, options });
    if (result && result.after !== result.before) results.push(result);
  }

  for (const result of results) {
    stats.filesChanged++;
    io.out(formatDiff(displayPath(result.file, io.cwd), result.before, result.after, { chalk }));
    io.out(formatReasons(result.reasons, { chalk }));
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
 * @returns {Promise<FileResult | null>}
 */
async function processFile(file, { stats, verbose, ctx, files, options }) {
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
  stats.deterministicFixes += stage1.reasons.length;
  stats.reports.push(...stage1.reports.map((r) => ({ ...r, file })));

  return { file, before: source, after: stage1.output, reasons: stage1.reasons };
}

/** @param {string} file @param {string} cwd */
function displayPath(file, cwd) {
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : file;
}
