import { spawn } from 'node:child_process';

/** Keep this much of the end of a failing test run's output for the report. */
const OUTPUT_TAIL_CHARS = 4000;

/**
 * @typedef {{ ok: boolean, code: number | null, output: string }} TestRun
 */

/**
 * Run the user's `--test-cmd` through the shell (like `npm test` in a terminal) and report whether
 * it passed. Output is captured, not shown, unless `onOutput` is given (--verbose).
 *
 * @param {string} command
 * @param {{ cwd: string, onOutput?: (chunk: string) => void }} options
 * @returns {Promise<TestRun>}
 */
export function runTestCommand(command, { cwd, onOutput }) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: process.env.CI ?? 'true' } });
    const collect = (/** @type {Buffer} */ chunk) => {
      const text = chunk.toString();
      onOutput?.(text);
      output = (output + text).slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => resolve({ ok: false, code: null, output: `could not run the command: ${error.message}` }));
    child.on('close', (code) => resolve({ ok: code === 0, code, output }));
  });
}

/**
 * The last few non-empty lines of a test run's output, for a one-line report.
 * @param {string} output
 * @param {number} [lines]
 */
export function outputTail(output, lines = 3) {
  return output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(' | ');
}
