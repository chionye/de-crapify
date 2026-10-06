import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {object} ModelInfo
 * @property {string} name      Human-readable name.
 * @property {string} url       Direct download URL.
 * @property {string} fileName
 * @property {number} size      Exact size in bytes.
 * @property {string} sha256    Expected SHA-256 (hex).
 */

/**
 * The built-in model: small enough (~1.1 GB) for ordinary laptops without a GPU, and a code model.
 * Size and checksum are the ones Hugging Face publishes for this file.
 * @type {ModelInfo}
 */
export const BUILTIN_MODEL = Object.freeze({
  name: 'Qwen2.5-Coder 1.5B Instruct (Q4_K_M)',
  url: 'https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
  fileName: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
  size: 1_117_320_768,
  sha256: 'cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046',
});

/** A download that failed; the message says why and is shown to the user. */
export class ModelDownloadError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ModelDownloadError';
  }
}

/**
 * Where downloaded models live: `$DE_CRAPIFY_CACHE_DIR/models` if set, otherwise the platform's
 * user cache directory.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 */
export function modelsDir(env = process.env, platform = process.platform) {
  if (env.DE_CRAPIFY_CACHE_DIR) return path.join(env.DE_CRAPIFY_CACHE_DIR, 'models');
  const home = os.homedir();
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'de-crapify', 'models');
  if (platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'de-crapify', 'Cache', 'models');
  return path.join(env.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'de-crapify', 'models');
}

/** @param {ModelInfo} model @param {string} dir */
export function modelPath(model, dir) {
  return path.join(dir, model.fileName);
}

/**
 * Whether the model is downloaded and was verified. A marker file next to it records the checksum
 * that was verified, so we don't re-hash 1 GB on every run.
 * @param {ModelInfo} model
 * @param {string} dir
 */
export async function isModelReady(model, dir) {
  const file = modelPath(model, dir);
  try {
    const [stat, marker] = await Promise.all([fs.stat(file), fs.readFile(`${file}.sha256`, 'utf8')]);
    return stat.size === model.size && marker.trim() === model.sha256;
  } catch {
    return false;
  }
}

/**
 * Download the model into `dir`, resuming a previous partial download when the server allows it,
 * then verify its size and SHA-256 before moving it into place. Throws ModelDownloadError.
 *
 * @param {object} input
 * @param {ModelInfo} input.model
 * @param {string} input.dir
 * @param {typeof globalThis.fetch} [input.fetch]
 * @param {(received: number, total: number) => void} [input.onProgress]
 * @param {(dir: string) => Promise<number | null>} [input.freeBytes]  Free disk space (null if unknown).
 * @returns {Promise<string>} the model's path
 */
export async function downloadModel({ model, dir, fetch = globalThis.fetch, onProgress = () => {}, freeBytes = defaultFreeBytes }) {
  const target = modelPath(model, dir);
  const partial = `${target}.partial`;
  await fs.mkdir(dir, { recursive: true });

  let existing = 0;
  try {
    existing = (await fs.stat(partial)).size;
  } catch {
    // no partial download
  }
  if (existing > model.size) {
    await fs.rm(partial, { force: true });
    existing = 0;
  }

  const free = await freeBytes(dir);
  const needed = model.size - existing;
  if (free !== null && free < needed + 50 * 1024 * 1024) {
    throw new ModelDownloadError(`not enough disk space in ${dir} (need ${formatBytes(needed)}, have ${formatBytes(free)})`);
  }

  let response;
  try {
    response = await fetch(model.url, { headers: existing > 0 ? { Range: `bytes=${existing}-` } : {}, redirect: 'follow' });
  } catch (error) {
    throw new ModelDownloadError(`could not reach ${new URL(model.url).host} (${/** @type {Error} */ (error).message})`);
  }
  if (response.status === 200) {
    existing = 0; // the server ignored the range: start over
  } else if (response.status !== 206) {
    throw new ModelDownloadError(`the download failed with HTTP ${response.status}`);
  }
  if (!response.body) throw new ModelDownloadError('the download returned no data');

  const hash = createHash('sha256');
  if (existing > 0) {
    for await (const chunk of createReadStream(partial)) hash.update(chunk);
  }
  const out = createWriteStream(partial, { flags: existing > 0 ? 'a' : 'w' });
  let received = existing;
  try {
    for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (/** @type {unknown} */ (response.body))) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      onProgress(received, model.size);
    }
  } catch (error) {
    await closeStream(out);
    throw new ModelDownloadError(`the download was interrupted (${/** @type {Error} */ (error).message}); run again to resume`);
  }
  await closeStream(out);

  if (received !== model.size) {
    if (received > model.size) await fs.rm(partial, { force: true });
    throw new ModelDownloadError(`the download is incomplete (${formatBytes(received)} of ${formatBytes(model.size)}); run again to resume`);
  }
  const digest = hash.digest('hex');
  if (digest !== model.sha256) {
    await fs.rm(partial, { force: true });
    throw new ModelDownloadError('the downloaded file is corrupted (checksum mismatch); it was deleted, run again to download it');
  }
  await fs.rename(partial, target);
  await fs.writeFile(`${target}.sha256`, `${model.sha256}\n`);
  return target;
}

/** "1.1 GB", "312 MB". @param {number} bytes */
export function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

/** @param {string} dir */
async function defaultFreeBytes(dir) {
  try {
    const stats = await fs.statfs(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/** @param {import('node:fs').WriteStream} stream */
function closeStream(stream) {
  return new Promise((resolve, reject) => {
    stream.end((/** @type {Error | undefined} */ error) => (error ? reject(error) : resolve(undefined)));
  });
}
