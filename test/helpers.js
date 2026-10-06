import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Chalk } from 'chalk';

/** Chalk with colors off, for asserting on plain text. */
export const plainChalk = new Chalk({ level: 0 });
/** Chalk forced to basic ANSI colors, for asserting that colors are applied. */
export const colorChalk = new Chalk({ level: 1 });

/**
 * Create a temp directory populated from a `{ 'relative/path': 'content' }` map.
 * Returns the directory's real path (macOS /var → /private/var symlink resolved).
 *
 * @param {Record<string, string>} files
 */
export async function makeTempTree(files = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'de-crapify-test-')));
  await writeTree(dir, files);
  return dir;
}

/** @param {string} dir @param {Record<string, string>} files */
export async function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

/** @param {string} dir */
export async function removeTree(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

export const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** @param {string} dir */
export function gitInit(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
}

/** Collects output lines written through a RunIO. */
export function captureIO(cwd, chalk = plainChalk) {
  const out = [];
  const err = [];
  return {
    io: { out: (t) => out.push(t), err: (t) => err.push(t), chalk, cwd },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}
