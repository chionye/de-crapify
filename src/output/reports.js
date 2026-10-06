import path from 'node:path';
import { REPORT_TYPES } from './summary.js';

/**
 * Report-only findings grouped by type, each with file and line. Empty string when there are none.
 *
 * @param {import('./summary.js').Report[]} reports
 * @param {{ chalk: import('chalk').ChalkInstance, cwd: string }} options
 * @returns {string}
 */
export function formatReports(reports, { chalk, cwd }) {
  if (reports.length === 0) return '';
  const sections = [];
  for (const [type, label] of Object.entries(REPORT_TYPES)) {
    const items = reports
      .filter((r) => r.type === type)
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    if (items.length === 0) continue;

    const color = type === 'hallucinatedImport' ? chalk.red : chalk.yellow;
    const lines = [color.bold(`${capitalize(label)} (${items.length})`)];
    for (const item of items) {
      const [first, ...rest] = item.message.split('\n');
      lines.push(`  ${chalk.cyan(`${displayPath(item.file, cwd)}:${item.line}`)}  ${first}`);
      for (const extra of rest) lines.push(`    ${extra}`);
    }
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}

/** @param {string} file @param {string} cwd */
function displayPath(file, cwd) {
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : file;
}

/** @param {string} s */
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
