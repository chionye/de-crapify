import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Write a file atomically: write a temporary file next to it, copy the original's permissions, then
 * rename it over the original. A crash mid-write never leaves a half-written source file.
 * @param {string} file
 * @param {string} content
 */
export async function writeFileAtomic(file, content) {
  const stat = await fs.stat(file);
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.de-crapify-${process.pid}.tmp`);
  try {
    await fs.writeFile(temp, content, { mode: stat.mode });
    await fs.chmod(temp, stat.mode);
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/**
 * @typedef {object} WriteTarget
 * @property {string} file
 * @property {string} before   What was read (and must still be on disk).
 * @property {string} after
 */

/**
 * Write each file's new content, skipping files that changed on disk since they were read (someone
 * kept editing while de-crapify ran): overwriting those would lose work.
 *
 * @param {WriteTarget[]} targets
 * @returns {Promise<{ written: WriteTarget[], skipped: { file: string, reason: string }[] }>}
 */
export async function writeChanges(targets) {
  /** @type {WriteTarget[]} */
  const written = [];
  const skipped = [];
  for (const target of targets) {
    let current;
    try {
      current = await fs.readFile(target.file, 'utf8');
    } catch {
      skipped.push({ file: target.file, reason: 'deleted while de-crapify was running' });
      continue;
    }
    if (current !== target.before) {
      skipped.push({ file: target.file, reason: 'changed on disk while de-crapify was running; not overwritten' });
      continue;
    }
    await writeFileAtomic(target.file, target.after);
    written.push(target);
  }
  return { written, skipped };
}
