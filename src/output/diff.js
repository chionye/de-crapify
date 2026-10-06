import { structuredPatch } from 'diff';

export const DEFAULT_CONTEXT_LINES = 3;

/**
 * Render a Git-style colored diff for one file. Returns an empty string when nothing changed.
 *
 * @param {string} displayPath  Path shown in the header (usually relative to cwd).
 * @param {string} before
 * @param {string} after
 * @param {{ chalk: import('chalk').ChalkInstance, context?: number }} options
 * @returns {string}
 */
export function formatDiff(displayPath, before, after, { chalk, context = DEFAULT_CONTEXT_LINES }) {
  if (before === after) return '';
  const patch = structuredPatch(`a/${displayPath}`, `b/${displayPath}`, before, after, '', '', { context });
  if (patch.hunks.length === 0) return '';

  const out = [
    chalk.bold(`diff --git a/${displayPath} b/${displayPath}`),
    chalk.bold(`--- a/${displayPath}`),
    chalk.bold(`+++ b/${displayPath}`),
  ];
  for (const hunk of patch.hunks) {
    out.push(chalk.cyan(`@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`));
    for (const line of hunk.lines) {
      if (line.startsWith('+')) out.push(chalk.green(line));
      else if (line.startsWith('-')) out.push(chalk.red(line));
      else if (line.startsWith('\\')) out.push(chalk.dim(line));
      else out.push(chalk.gray(line));
    }
  }
  return out.join('\n');
}

/**
 * The bulleted list of reasons printed under a file's diff.
 * @param {string[]} reasons
 * @param {{ chalk: import('chalk').ChalkInstance }} options
 */
export function formatReasons(reasons, { chalk }) {
  return reasons.map((reason) => `  ${chalk.yellow('•')} ${reason}`).join('\n');
}

/** Unified-diff range: "start,count", with Git's convention of start-1 for empty ranges. */
function range(start, count) {
  if (count === 0) return `${start === 0 ? 0 : start - 1},0`;
  return count === 1 ? `${start}` : `${start},${count}`;
}
