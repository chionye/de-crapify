import { AiRequestError } from './ollama.js';

/** Per-chunk timeout for the built-in model. It may run on CPU only, so it's longer than Ollama's. */
export const BUILTIN_CHAT_TIMEOUT_MS = 300_000;

/**
 * Load `node-llama-cpp`. It's an optional dependency: if it failed to install on this machine,
 * this throws and the caller reports that AI isn't available.
 * @returns {Promise<any>}
 */
export async function loadNodeLlamaCpp() {
  return import('node-llama-cpp');
}

/**
 * The built-in AI: a GGUF model run in-process with node-llama-cpp. Same `chat()` interface as the
 * Ollama client. Never builds or downloads llama.cpp itself (only the prebuilt binaries are used).
 *
 * @param {object} input
 * @param {string} input.modelPath
 * @param {string} input.modelName
 * @param {number} input.numCtx
 * @param {() => Promise<any>} [input.loadLibrary]   Injectable for tests.
 * @param {number} [input.chatTimeoutMs]
 */
export async function createBuiltinClient({ modelPath, modelName, numCtx, loadLibrary = loadNodeLlamaCpp, chatTimeoutMs = BUILTIN_CHAT_TIMEOUT_MS }) {
  const lib = await loadLibrary();
  const llama = await lib.getLlama({
    build: 'never',
    skipDownload: true,
    progressLogs: false,
    logLevel: lib.LlamaLogLevel?.error ?? 'error',
  });
  const model = await llama.loadModel({ modelPath });
  const contextSize = Math.min(numCtx, model.trainContextSize ?? numCtx);
  const context = await model.createContext({ contextSize });
  const gpu = typeof llama.gpu === 'string' ? llama.gpu : null;

  return {
    model: modelName,
    /** e.g. "metal", "cuda", "vulkan", or null for CPU only. */
    gpu,

    /**
     * @param {{ system: string, user: string }} messages
     * @returns {Promise<{ content: string, doneReason: string | undefined }>}
     */
    async chat({ system, user }) {
      const sequence = context.getSequence();
      const session = new lib.LlamaChatSession({ contextSequence: sequence, systemPrompt: system });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), chatTimeoutMs);
      try {
        const result = await session.promptWithMeta(user, { temperature: 0, signal: controller.signal, stopOnAbortSignal: false });
        return { content: result.responseText, doneReason: doneReasonOf(result.stopReason) };
      } catch (error) {
        if (controller.signal.aborted) throw new AiRequestError(`timed out after ${Math.round(chatTimeoutMs / 1000)}s`);
        throw new AiRequestError(`the built-in model failed: ${/** @type {Error} */ (error).message}`);
      } finally {
        clearTimeout(timer);
        session.dispose?.();
        sequence.dispose?.();
      }
    },

    async dispose() {
      await context.dispose?.();
      await model.dispose?.();
      await llama.dispose?.();
    },
  };
}

/**
 * Map node-llama-cpp's stop reasons onto Ollama's `done_reason` vocabulary, which validation checks.
 * @param {string} stopReason
 */
export function doneReasonOf(stopReason) {
  if (stopReason === 'eogToken' || stopReason === 'stopGenerationTrigger') return 'stop';
  if (stopReason === 'maxTokens') return 'length';
  return stopReason;
}
