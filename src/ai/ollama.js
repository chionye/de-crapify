import { SetupError } from '../errors.js';

/** Per-request timeout for chat calls. Local models are slow; a stuck request shouldn't hang the run. */
export const CHAT_TIMEOUT_MS = 120_000;
/** Timeout for the preflight `GET /api/tags`: Ollama answers this instantly when it's up. */
export const PREFLIGHT_TIMEOUT_MS = 5_000;

/** A chat request that failed or timed out. The caller skips that chunk and carries on. */
export class OllamaRequestError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'OllamaRequestError';
  }
}

/**
 * A minimal Ollama client. `fetch` is injectable so tests never need Ollama running.
 *
 * @param {object} config
 * @param {string} config.baseUrl     e.g. http://localhost:11434 (no trailing slash)
 * @param {string} config.model
 * @param {number} config.numCtx
 * @param {typeof globalThis.fetch} [config.fetch]
 * @param {number} [config.chatTimeoutMs]
 * @param {number} [config.preflightTimeoutMs]
 */
export function createOllamaClient({
  baseUrl,
  model,
  numCtx,
  fetch = globalThis.fetch,
  chatTimeoutMs = CHAT_TIMEOUT_MS,
  preflightTimeoutMs = PREFLIGHT_TIMEOUT_MS,
}) {
  /**
   * @param {string} path
   * @param {RequestInit} init
   * @param {number} timeoutMs
   */
  async function request(path, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    model,

    /**
     * Check that Ollama is reachable and the model is installed. Throws SetupError (exit code 2)
     * with a message and hint otherwise. Never falls back to another model.
     * @returns {Promise<string[]>} the installed model names
     */
    async preflight() {
      const notRunning = (/** @type {string} */ detail) =>
        new SetupError(`Ollama doesn't seem to be running at ${baseUrl} (${detail}).`, {
          hint: 'Start it with `ollama serve`, or run with --no-ai to use only the deterministic rules.',
          warning: true,
        });

      let response;
      try {
        response = await request('/api/tags', { method: 'GET' }, preflightTimeoutMs);
      } catch (error) {
        throw notRunning(isAbort(error) ? `no answer within ${preflightTimeoutMs / 1000}s` : errorMessage(error));
      }
      if (!response.ok) throw notRunning(`HTTP ${response.status}`);

      let body;
      try {
        body = await response.json();
      } catch {
        throw notRunning('the answer was not JSON; is something else listening on that port?');
      }
      const installed = Array.isArray(body?.models)
        ? body.models.map((/** @type {any} */ m) => m?.name ?? m?.model).filter((/** @type {unknown} */ n) => typeof n === 'string')
        : [];

      if (!isModelInstalled(model, installed)) {
        throw new SetupError(`The model "${model}" is not installed in Ollama.`, {
          hint: [
            'Install it with:',
            `  ollama pull ${model}`,
            installed.length ? `Installed models: ${installed.join(', ')}` : 'No models are installed yet.',
            'Or pick an installed one with --model <name>.',
          ].join('\n'),
        });
      }
      return installed;
    },

    /**
     * One non-streaming chat completion.
     * @param {{ system: string, user: string }} messages
     * @returns {Promise<{ content: string, doneReason: string | undefined }>}
     */
    async chat({ system, user }) {
      let response;
      try {
        response = await request(
          '/api/chat',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              stream: false,
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
              options: { temperature: 0, num_ctx: numCtx },
            }),
          },
          chatTimeoutMs,
        );
      } catch (error) {
        if (isAbort(error)) throw new OllamaRequestError(`timed out after ${Math.round(chatTimeoutMs / 1000)}s`);
        throw new OllamaRequestError(`request failed: ${errorMessage(error)}`);
      }

      let body;
      try {
        body = await response.json();
      } catch {
        throw new OllamaRequestError(`HTTP ${response.status} with a body that is not JSON`);
      }
      if (!response.ok || body?.error) {
        throw new OllamaRequestError(`HTTP ${response.status}${body?.error ? `: ${body.error}` : ''}`);
      }
      const content = body?.message?.content;
      if (typeof content !== 'string') throw new OllamaRequestError('the response had no message content');
      return { content, doneReason: typeof body.done_reason === 'string' ? body.done_reason : undefined };
    },
  };
}

/** @typedef {ReturnType<typeof createOllamaClient>} OllamaClient */

/**
 * Whether `model` is among the installed names. A name without a tag means `:latest`, as in Ollama.
 * @param {string} model
 * @param {string[]} installed
 */
export function isModelInstalled(model, installed) {
  const wanted = model.includes(':') ? model : `${model}:latest`;
  return installed.some((name) => name === model || name === wanted);
}

/** @param {unknown} error */
function isAbort(error) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** @param {unknown} error */
function errorMessage(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = /** @type {any} */ (error).cause;
  return cause?.code ? `${error.message}: ${cause.code}` : error.message;
}
