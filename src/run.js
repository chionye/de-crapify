import fs from 'node:fs/promises';
import path from 'node:path';
import { aiCleanupFile } from './ai/cleanup.js';
import { selectAiProvider } from './ai/providers.js';
import { createProjectContext, describeContext } from './context/index.js';
import { contentSkipReason, discoverFiles, SKIP_REASONS } from './discover.js';
import { EXIT, SetupError } from './errors.js';
import { assertSafeToWrite, gitState } from './git.js';
import { ineffectiveOptionWarnings } from './options.js';
import { parseCode } from './parse.js';
import { runDeterministicRules } from './rules/index.js';
import { formatDiff, formatReasons } from './output/diff.js';
import { formatReports } from './output/reports.js';
import { createStats, formatSummary, recordAiRejection, reportCounts } from './output/summary.js';
import { outputTail, runTestCommand } from './test-cmd.js';
import { loadProjectTypeScript, typecheckChanges } from './typecheck.js';
import { writeChanges, writeFileAtomic } from './write.js';

/**
 * @typedef {object} RunIO
 * @property {(text: string) => void} out   Normal output (diffs, summary).
 * @property {(text: string) => void} err   Warnings and verbose logs.
 * @property {import('chalk').ChalkInstance} chalk
 * @property {string} cwd
 * @property {boolean} [interactive]  A person is at a terminal (we may ask questions).
 * @property {(question: string) => Promise<string>} [ask]
 * @property {(text: string | null) => void} [statusLine]  A live, overwritten line on stderr (null ends it).
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
 * @property {(fromDir: string) => string | null} [resolveTsc]
 * @property {(args: string[], cwd: string) => Promise<string>} [runGit]
 * @property {typeof globalThis.fetch} [fetch]   Used for Ollama and the model download.
 * @property {import('./ai/providers.js').ProviderDeps} [ai]
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

  const stats = createStats();

  const discovery = await discoverFiles(path.resolve(io.cwd, options.targetPath), { maxFileSizeBytes: options.maxFileSizeBytes });
  stats.skipped.push(...discovery.skipped);
  verbose(`Found ${discovery.files.length} candidate file(s) under ${displayPath(discovery.root, io.cwd)}`);
  if (discovery.gitRoot) verbose(`Git root: ${discovery.gitRoot}`);

  // Write mode: refuse early if the changes couldn't be undone, and check the tests pass before we
  // change anything (otherwise every file would look like it broke them).
  if (options.write) {
    assertSafeToWrite(await gitState(discovery.root, discovery.gitRoot, deps.runGit), { force: options.force, cwd: io.cwd });
    if (options.testCmd) {
      verbose(`Running the test command before any change: ${options.testCmd}`);
      const baseline = await runTestCommand(options.testCmd, { cwd: io.cwd, onOutput: options.verbose ? (t) => io.err(chalk.dim(t.trimEnd())) : undefined });
      if (!baseline.ok) {
        throw new SetupError(`--test-cmd fails before de-crapify changes anything (exit code ${baseline.code}), so it can't tell whether a change breaks your tests.`, {
          hint: `Fix the tests first, or run without --test-cmd.${baseline.output ? `\nLast output: ${outputTail(baseline.output)}` : ''}`,
        });
      }
    }
  }

  const ai = await selectAiProvider({ options, io, verbose, deps: { fetch: deps.fetch, ...deps.ai } });
  try {
    return await cleanFiles({ options, io, deps, stats, discovery, verbose, client: ai.client, aiStatus: ai.status });
  } finally {
    await ai.dispose();
  }
}

/**
 * Everything after setup: per-file processing, typecheck, output, exit code.
 * @param {object} env
 * @param {import('./options.js').Options} env.options
 * @param {RunIO} env.io
 * @param {RunDeps} env.deps
 * @param {import('./output/summary.js').Stats} env.stats
 * @param {import('./discover.js').Discovery} env.discovery
 * @param {(msg: string) => void} env.verbose
 * @param {import('./ai/providers.js').AiClient | null} env.client
 * @param {string} env.aiStatus
 */
async function cleanFiles({ options, io, deps, stats, discovery, verbose, client, aiStatus }) {
  const { chalk } = io;
  stats.aiStatus = aiStatus;
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
    stats.aiStatus = `${aiStatus} (${aiTotals.chunks} chunk(s) sent${failed})`;
  }

  typecheck(results, { options, io, stats, verbose, loadTypeScript: deps.loadTypeScript, resolveTsc: deps.resolveTsc });

  if (options.write) await writeAndVerify(results, { options, io, stats, verbose });

  for (const result of results) {
    if (result.after === result.before) continue;
    stats.filesChanged++;
    stats.deterministicFixes += result.stage1Reasons.length;
    stats.aiAccepted += result.aiReasons.length;
    const shown = displayPath(result.file, io.cwd);
    if (options.write) {
      const counts = [`${result.stage1Reasons.length} deterministic`, result.aiReasons.length ? `${result.aiReasons.length} AI` : ''].filter(Boolean);
      const total = result.stage1Reasons.length + result.aiReasons.length;
      io.out(`${chalk.green('✔')} wrote ${shown} (${total} fix${total === 1 ? '' : 'es'}: ${counts.join(', ')})`);
      if (options.verbose) {
        io.out(formatDiff(shown, result.before, result.after, { chalk }));
        io.out(formatReasons(currentReasons(result), { chalk }));
      }
      continue;
    }
    io.out(formatDiff(shown, result.before, result.after, { chalk }));
    io.out(formatReasons(currentReasons(result), { chalk }));
    io.out('');
  }
  if (options.write && stats.filesChanged > 0) io.out('');

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
 * @param {import('./ai/providers.js').AiClient | null} deps.client
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
 * @param {(fromDir: string) => string | null} [env.resolveTsc]
 */
function typecheck(results, { options, io, stats, verbose, loadTypeScript = loadProjectTypeScript, resolveTsc }) {
  if (options.typecheck === false) {
    stats.typecheckStatus = 'off (--no-typecheck)';
    return;
  }
  let outcome;
  try {
    outcome = typecheckChanges({ files: results, loadTypeScript, resolveTsc, cwd: io.cwd, mode: options.write ? 'write' : 'dry-run' });
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

/**
 * Write mode: write every changed file, then (with --test-cmd) run the tests once. If they fail,
 * put everything back and re-apply the files one at a time, testing after each; a file that breaks
 * the tests first loses its AI changes, then all of them. The files left on disk at the end are
 * always a state the tests passed on. Ctrl-C during this puts every file back.
 *
 * @param {FileResult[]} results
 * @param {object} env
 * @param {import('./options.js').Options} env.options
 * @param {RunIO} env.io
 * @param {import('./output/summary.js').Stats} env.stats
 * @param {(msg: string) => void} env.verbose
 */
async function writeAndVerify(results, { options, io, stats, verbose }) {
  const changed = results.filter((r) => r.after !== r.before);
  const { written, skipped } = await writeChanges(changed);
  for (const s of skipped) {
    const result = results.find((r) => r.file === s.file);
    if (result) result.after = result.before;
    stats.reverted.push(s);
  }
  if (!options.testCmd || written.length === 0) return;

  const writtenResults = written.map((w) => /** @type {FileResult} */ (results.find((r) => r.file === w.file)));
  const restoreAll = async () => {
    for (const r of writtenResults) await writeFileAtomic(r.file, r.before);
  };
  const onInterrupt = () => {
    io.err(io.chalk.yellow('\nInterrupted: putting every file back the way it was.'));
    restoreAll().finally(() => process.exit(130));
  };
  process.once('SIGINT', onInterrupt);
  const test = async () => {
    verbose(`Running the test command: ${options.testCmd}`);
    return runTestCommand(/** @type {string} */ (options.testCmd), { cwd: io.cwd, onOutput: options.verbose ? (t) => io.err(io.chalk.dim(t.trimEnd())) : undefined });
  };

  try {
    if ((await test()).ok) return;
    io.err(io.chalk.yellow('The tests fail with the changes applied; checking the files one at a time…'));
    await restoreAll();
    for (const r of writtenResults) {
      await writeFileAtomic(r.file, r.after);
      let run = await test();
      if (run.ok) continue;
      if (r.aiReasons.length > 0 && r.stage1 !== r.before && r.stage1 !== r.after) {
        await writeFileAtomic(r.file, r.stage1);
        const firstFailure = run;
        run = await test();
        if (run.ok) {
          r.after = r.stage1;
          r.aiReasons = [];
          stats.reverted.push({ file: r.file, reason: `tests failed with the AI changes, kept the deterministic fixes (${outputTail(firstFailure.output) || `exit code ${firstFailure.code}`})` });
          continue;
        }
      }
      await writeFileAtomic(r.file, r.before);
      r.after = r.before;
      stats.reverted.push({ file: r.file, reason: `tests failed with this file's changes, left it unchanged (${outputTail(run.output) || `exit code ${run.code}`})` });
    }
  } finally {
    process.removeListener('SIGINT', onInterrupt);
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
