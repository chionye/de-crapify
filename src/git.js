import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { SetupError } from './errors.js';
import { isSupportedFile } from './parse.js';

const execFileAsync = promisify(execFile);

/**
 * @typedef {object} GitState
 * @property {boolean} inRepo
 * @property {string[]} dirty  Source files under the target with uncommitted changes (modified, staged, or untracked).
 * @property {string | null} error  Set when git couldn't be run.
 */

/**
 * The git state of the target path: is it in a repo, and which source files under it have
 * uncommitted changes? Only source files de-crapify could change count, so untracked notes or build
 * output elsewhere don't get in the way.
 *
 * @param {string} targetPath  Absolute file or directory.
 * @param {string | null} gitRoot
 * @param {(args: string[], cwd: string) => Promise<string>} [runGit]
 * @returns {Promise<GitState>}
 */
export async function gitState(targetPath, gitRoot, runGit = defaultRunGit) {
  if (!gitRoot) return { inRepo: false, dirty: [], error: null };
  let output;
  try {
    output = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', path.relative(gitRoot, targetPath) || '.'], gitRoot);
  } catch (error) {
    return { inRepo: true, dirty: [], error: /** @type {Error} */ (error).message };
  }
  const dirty = [];
  const entries = output.split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (status[0] === 'R' || status[0] === 'C') i++; // renames/copies are followed by the original path
    if (isSupportedFile(file)) dirty.push(path.join(gitRoot, file));
  }
  return { inRepo: true, dirty, error: null };
}

/**
 * Refuse `--write` when its changes couldn't be undone with git, unless `--force` is given.
 * @param {GitState} state
 * @param {{ force: boolean, cwd: string }} options
 */
export function assertSafeToWrite(state, { force, cwd }) {
  if (force) return;
  const hint = 'Commit or stash your changes first so you can review and undo what de-crapify writes (git diff / git restore), or pass --force to write anyway.';
  if (!state.inRepo) {
    throw new SetupError('Refusing to --write outside a git repository: there would be no easy way to undo the changes.', {
      hint: 'Run it inside a git repository, run without --write to see the diff first, or pass --force to write anyway.',
    });
  }
  if (state.error) {
    throw new SetupError(`Refusing to --write: could not check for uncommitted changes (${state.error}).`, { hint });
  }
  if (state.dirty.length > 0) {
    const shown = state.dirty.slice(0, 10).map((f) => `  ${path.relative(cwd, f) || f}`);
    if (state.dirty.length > 10) shown.push(`  …and ${state.dirty.length - 10} more`);
    throw new SetupError(`Refusing to --write: ${state.dirty.length} source file(s) under the target have uncommitted changes:\n${shown.join('\n')}`, { hint });
  }
}

/** @param {string[]} args @param {string} cwd */
async function defaultRunGit(args, cwd) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
