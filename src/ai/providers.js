import { SetupError } from '../errors.js';
import { createBuiltinClient, loadNodeLlamaCpp } from './builtin.js';
import { BUILTIN_MODEL, downloadModel, formatBytes, isModelReady, modelPath, modelsDir } from './model-files.js';
import { createOllamaClient } from './ollama.js';

/**
 * @typedef {object} AiClient
 * @property {string} model
 * @property {(messages: { system: string, user: string }) => Promise<{ content: string, doneReason: string | undefined }>} chat
 */

/**
 * @typedef {object} AiSelection
 * @property {AiClient | null} client      null when AI is off or unavailable.
 * @property {string} status               For the summary's AI line.
 * @property {() => Promise<void>} dispose Frees the built-in model's memory.
 */

/**
 * @typedef {object} ProviderDeps  All injectable for tests.
 * @property {typeof globalThis.fetch} [fetch]           Used for Ollama and for the model download.
 * @property {() => Promise<any>} [loadLibrary]          Loads node-llama-cpp.
 * @property {string} [modelsDir]
 * @property {(dir: string) => Promise<number | null>} [freeBytes]
 * @property {import('./model-files.js').ModelInfo} [model]
 */

const noop = async () => {};

/**
 * Pick the AI provider for this run.
 *
 * - `auto`: Ollama if it's running with the model; otherwise the built-in model, downloaded once
 *   (asking first in a terminal, or with `--yes`). If AI can't be used, say so in one line and
 *   continue with the deterministic rules only.
 * - `ollama` (or `--model` / `--ollama-url` given): Ollama or a setup error, never a fallback.
 * - `builtin`: the built-in model or a setup error.
 *
 * @param {object} input
 * @param {import('../options.js').Options} input.options
 * @param {import('../run.js').RunIO} input.io
 * @param {(msg: string) => void} input.verbose
 * @param {ProviderDeps} [input.deps]
 * @returns {Promise<AiSelection>}
 */
export async function selectAiProvider({ options, io, verbose, deps = {} }) {
  if (!options.ai) return { client: null, status: 'off (--no-ai)', dispose: noop };

  const ollamaRequired = options.aiProvider === 'ollama' || (options.aiProvider === 'auto' && options.ollamaExplicit);
  if (options.aiProvider !== 'builtin') {
    const ollama = createOllamaClient({ baseUrl: options.ollamaUrl, model: options.model, numCtx: options.numCtx, fetch: deps.fetch });
    try {
      await ollama.preflight();
      verbose(`AI: Ollama at ${options.ollamaUrl}, model ${options.model}`);
      return { client: ollama, status: `Ollama ${options.model}`, dispose: noop };
    } catch (error) {
      if (ollamaRequired) throw error;
      verbose(`AI: not using Ollama (${/** @type {Error} */ (error).message}); using the built-in model`);
    }
  }
  return selectBuiltin({ options, io, verbose, deps, required: options.aiProvider === 'builtin' });
}

/**
 * @param {object} input
 * @param {import('../options.js').Options} input.options
 * @param {import('../run.js').RunIO} input.io
 * @param {(msg: string) => void} input.verbose
 * @param {ProviderDeps} input.deps
 * @param {boolean} input.required  Explicitly requested: failures are setup errors, not notices.
 * @returns {Promise<AiSelection>}
 */
async function selectBuiltin({ options, io, verbose, deps, required }) {
  const model = deps.model ?? BUILTIN_MODEL;
  const dir = deps.modelsDir ?? modelsDir();

  /** AI can't be used: a setup error if it was asked for explicitly, otherwise a one-line notice. */
  const unavailable = (/** @type {string} */ reason, /** @type {string} */ hint) => {
    if (required) throw new SetupError(`The built-in AI can't be used: ${reason}.`, { hint });
    io.err(io.chalk.yellow(`AI cleanup skipped: ${reason}.`));
    io.err(io.chalk.dim(hint));
    return { client: null, status: `skipped (${reason})`, dispose: noop };
  };

  let lib;
  try {
    lib = await (deps.loadLibrary ?? loadNodeLlamaCpp)();
  } catch (error) {
    verbose(`AI: node-llama-cpp could not be loaded: ${/** @type {Error} */ (error).message}`);
    return unavailable('the built-in AI is not available on this machine', 'Install Ollama (https://ollama.com) and run `ollama pull qwen2.5-coder:7b` to enable AI, or use --no-ai to hide this message.');
  }

  if (!(await isModelReady(model, dir))) {
    let allowed = options.yes;
    if (!allowed) {
      if (!io.interactive || options.check) {
        return unavailable(
          'the AI model has not been downloaded yet',
          `Run de-crapify once in a terminal to download it (${formatBytes(model.size)}), or pass --yes to download it now.`,
        );
      }
      const answer = await io.ask(
        [
          'de-crapify can also clean up code with a small AI model that runs on your machine (your code never leaves it).',
          `This needs a one-time download: ${model.name}, ${formatBytes(model.size)}, saved to ${dir}.`,
          'Download it now? [Y/n] ',
        ].join('\n'),
      );
      allowed = /^(y|yes)?$/i.test(answer.trim());
      if (!allowed) return unavailable('the AI model download was declined', 'Run again and answer yes, or pass --yes. Use --no-ai to skip AI without being asked.');
    }
    try {
      await downloadModel({ model, dir, fetch: deps.fetch, freeBytes: deps.freeBytes, onProgress: progressReporter(io, model.size) });
      io.statusLine?.(null);
      io.err(io.chalk.dim(`Downloaded ${model.name} to ${dir}.`));
    } catch (error) {
      io.statusLine?.(null);
      return unavailable(`the AI model could not be downloaded: ${/** @type {Error} */ (error).message}`, 'Check your connection and run again (the download resumes), or use --no-ai.');
    }
  }

  try {
    const client = await createBuiltinClient({ modelPath: modelPath(model, dir), modelName: model.name, numCtx: options.numCtx, loadLibrary: async () => lib });
    const where = client.gpu ? client.gpu : 'CPU';
    verbose(`AI: built-in ${model.name} on ${where}`);
    return { client, status: `built-in ${model.name} (${where})`, dispose: () => client.dispose() };
  } catch (error) {
    return unavailable(
      `the AI model could not be loaded (${/** @type {Error} */ (error).message})`,
      'This usually means there is not enough free memory. Close some apps and run again, install Ollama, or use --no-ai.',
    );
  }
}

/**
 * Download progress: a live status line in a terminal, otherwise a line every 10%.
 * @param {import('../run.js').RunIO} io
 * @param {number} total
 */
function progressReporter(io, total) {
  let lastTenth = -1;
  return (/** @type {number} */ received) => {
    const tenth = Math.floor((received / total) * 10);
    const text = `Downloading the AI model: ${formatBytes(received)} / ${formatBytes(total)} (${Math.floor((received / total) * 100)}%)`;
    if (io.statusLine) io.statusLine(text);
    else if (tenth > lastTenth) {
      lastTenth = tenth;
      io.err(io.chalk.dim(text));
    }
  };
}
