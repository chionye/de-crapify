import path from 'node:path';

/** Report-only finding types, in the order they're printed. */
export const REPORT_TYPES = Object.freeze({
  hallucinatedImport: 'likely hallucinated imports',
  unverifiedImport: 'imports that could not be verified',
  unsafeConsole: 'console calls not safe to remove',
  godFile: 'god files',
});

/**
 * @typedef {keyof typeof REPORT_TYPES} ReportType
 * @typedef {{ type: ReportType, file: string, line: number, message: string }} Report
 * @typedef {object} Stats
 * @property {number} filesScanned
 * @property {number} filesChanged
 * @property {number} deterministicFixes
 * @property {number} aiAccepted
 * @property {Map<string, number>} aiRejected  Rejection reason → count.
 * @property {Report[]} reports
 * @property {{ file: string, reason: string }[]} skipped
 * @property {{ file: string, reason: string }[]} reverted  Files written then restored (typecheck / test failure).
 * @property {string} aiStatus        One-line description of whether/how AI ran.
 * @property {string} typecheckStatus One-line description of whether/how the typecheck ran.
 */

/** @returns {Stats} */
export function createStats() {
  return {
    filesScanned: 0,
    filesChanged: 0,
    deterministicFixes: 0,
    aiAccepted: 0,
    aiRejected: new Map(),
    reports: [],
    skipped: [],
    reverted: [],
    aiStatus: 'off',
    typecheckStatus: 'not run',
  };
}

/**
 * @param {Stats} stats
 * @param {string} reason
 */
export function recordAiRejection(stats, reason) {
  stats.aiRejected.set(reason, (stats.aiRejected.get(reason) ?? 0) + 1);
}

/** @param {Stats} stats */
export function totalAiRejected(stats) {
  let total = 0;
  for (const count of stats.aiRejected.values()) total += count;
  return total;
}

/**
 * @param {Stats} stats
 * @returns {Record<ReportType, number>}
 */
export function reportCounts(stats) {
  const counts = /** @type {Record<ReportType, number>} */ (
    Object.fromEntries(Object.keys(REPORT_TYPES).map((type) => [type, 0]))
  );
  for (const report of stats.reports) counts[report.type]++;
  return counts;
}

const MAX_SKIPPED_LISTED = 5;

/**
 * The summary printed at the end of every run.
 *
 * @param {Stats} stats
 * @param {{ chalk: import('chalk').ChalkInstance, cwd?: string, verbose?: boolean, write?: boolean }} options
 * @returns {string}
 */
export function formatSummary(stats, { chalk, cwd = process.cwd(), verbose = false, write = false }) {
  const rel = (/** @type {string} */ file) => {
    const relative = path.relative(cwd, file);
    if (!relative) return path.basename(file);
    return relative.startsWith('..') ? file : relative.split(path.sep).join('/');
  };
  const lines = [chalk.bold('Summary')];
  const labelWidth = Math.max(...Object.values(REPORT_TYPES).map((label) => label.length)) + 2;

  const row = (/** @type {string} */ label, /** @type {string | number} */ value) =>
    lines.push(`  ${label.padEnd(labelWidth)}${value}`);

  row('Files scanned', stats.filesScanned);
  row(write ? 'Files changed' : 'Files with changes', stats.filesChanged);
  row('Deterministic fixes', stats.deterministicFixes);
  row('AI fixes accepted', stats.aiAccepted);
  row('AI suggestions rejected', totalAiRejected(stats));
  for (const [reason, count] of [...stats.aiRejected].sort((a, b) => b[1] - a[1])) {
    lines.push(chalk.dim(`      ${count} × ${reason}`));
  }

  const counts = reportCounts(stats);
  for (const [type, label] of Object.entries(REPORT_TYPES)) {
    const count = counts[/** @type {ReportType} */ (type)];
    const text = capitalize(label);
    row(text, count > 0 && type === 'hallucinatedImport' ? chalk.red(String(count)) : count);
  }

  row('Files skipped', stats.skipped.length);
  for (const [reason, files] of groupBy(stats.skipped, (s) => s.reason)) {
    const shown = verbose ? files : files.slice(0, MAX_SKIPPED_LISTED);
    const more = files.length - shown.length;
    const list = shown.map((s) => rel(s.file)).join(', ') + (more > 0 ? `, and ${more} more` : '');
    lines.push(chalk.dim(`      ${files.length} ${reason}: ${list}`));
  }

  if (stats.reverted.length > 0) {
    row('Files reverted', chalk.yellow(String(stats.reverted.length)));
    for (const { file, reason } of stats.reverted) {
      lines.push(chalk.dim(`      ${rel(file)}: ${reason}`));
    }
  }

  row('AI', stats.aiStatus);
  row('Typecheck', stats.typecheckStatus);
  return lines.join('\n');
}

/**
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} key
 * @returns {Map<string, T[]>}
 */
function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const k = key(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }
  return groups;
}

/** @param {string} s */
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
