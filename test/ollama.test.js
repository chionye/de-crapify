import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createOllamaClient, isModelInstalled, OllamaRequestError } from '../src/ai/ollama.js';
import { SetupError } from '../src/errors.js';

const BASE = 'http://localhost:11434';

/** A fetch built from a handler; records each call. */
function fetchFrom(handler) {
  const calls = [];
  /** @type {typeof globalThis.fetch} */
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return handler(String(url), init);
  };
  return { fetch, calls };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** A fetch that never answers until aborted (like a hung server). */
const hangingFetch = async (_url, init = {}) =>
  new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
  });

const connectionRefused = async () => {
  throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }) });
};

function client(fetch, extra = {}) {
  return createOllamaClient({ baseUrl: BASE, model: 'qwen2.5-coder:7b', numCtx: 8192, fetch, ...extra });
}

/** Run preflight and return the SetupError it throws. */
async function preflightError(fetch, extra) {
  try {
    await client(fetch, extra).preflight();
  } catch (error) {
    assert.ok(error instanceof SetupError, `expected SetupError, got ${error}`);
    return error;
  }
  assert.fail('preflight should have thrown');
}

describe('preflight: success', () => {
  it('calls GET /api/tags and accepts an installed model', async () => {
    const { fetch, calls } = fetchFrom(() => json({ models: [{ name: 'qwen2.5-coder:7b' }, { name: 'llama3:8b' }] }));
    assert.deepEqual(await client(fetch).preflight(), ['qwen2.5-coder:7b', 'llama3:8b']);
    assert.equal(calls[0].url, `${BASE}/api/tags`);
    assert.equal(calls[0].init.method, 'GET');
  });

  it('treats a model name without a tag as :latest', () => {
    assert.ok(isModelInstalled('llama3', ['llama3:latest']));
    assert.ok(isModelInstalled('llama3:latest', ['llama3:latest']));
    assert.ok(!isModelInstalled('llama3', ['llama3:8b']), 'never matches a different tag');
    assert.ok(!isModelInstalled('qwen2.5-coder:7b', ['qwen2.5-coder:14b']));
  });
});

describe('preflight: Ollama not reachable (exit 2, yellow, suggests ollama serve and --no-ai)', () => {
  it('connection refused', async () => {
    const error = await preflightError(connectionRefused);
    assert.equal(error.warning, true, 'printed in yellow');
    assert.match(error.message, /doesn't seem to be running at http:\/\/localhost:11434/);
    assert.match(error.message, /ECONNREFUSED/);
    assert.match(error.hint ?? '', /ollama serve/);
    assert.match(error.hint ?? '', /--no-ai/);
  });

  it('no answer before the timeout', async () => {
    const error = await preflightError(hangingFetch, { preflightTimeoutMs: 20 });
    assert.match(error.message, /no answer within/);
  });

  it('an HTTP error, or something that is not Ollama on that port', async () => {
    assert.match((await preflightError(fetchFrom(() => new Response('oops', { status: 500 })).fetch)).message, /HTTP 500/);
    assert.match((await preflightError(fetchFrom(() => new Response('<html>', { status: 200 })).fetch)).message, /not JSON/);
  });
});

describe('preflight: model missing (exit 2, exact pull command, installed list, no fallback)', () => {
  it('prints the pull command and the installed models', async () => {
    const { fetch } = fetchFrom(() => json({ models: [{ name: 'qwen2.5-coder:14b' }, { name: 'llama3:8b' }] }));
    const error = await preflightError(fetch);
    assert.equal(error.warning, false);
    assert.equal(error.message, 'The model "qwen2.5-coder:7b" is not installed in Ollama.');
    assert.match(error.hint ?? '', /^ {2}ollama pull qwen2\.5-coder:7b$/m);
    assert.match(error.hint ?? '', /Installed models: qwen2\.5-coder:14b, llama3:8b/);
  });

  it('says so when no models are installed', async () => {
    const error = await preflightError(fetchFrom(() => json({ models: [] })).fetch);
    assert.match(error.hint ?? '', /No models are installed yet/);
  });
});

describe('chat', () => {
  it('sends a non-streaming chat request with temperature 0 and num_ctx', async () => {
    const { fetch, calls } = fetchFrom(() => json({ message: { role: 'assistant', content: 'const a = 1;' }, done: true, done_reason: 'stop' }));
    const reply = await client(fetch, { numCtx: 16384 }).chat({ system: 'SYS', user: 'USER' });
    assert.deepEqual(reply, { content: 'const a = 1;', doneReason: 'stop' });
    const { url, init, body } = calls[0];
    assert.equal(url, `${BASE}/api/chat`);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(body, {
      model: 'qwen2.5-coder:7b',
      stream: false,
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'USER' },
      ],
      options: { temperature: 0, num_ctx: 16384 },
    });
  });

  it('passes done_reason through (e.g. "length" when cut off)', async () => {
    const { fetch } = fetchFrom(() => json({ message: { content: 'const a' }, done_reason: 'length' }));
    assert.equal((await client(fetch).chat({ system: '', user: '' })).doneReason, 'length');
  });

  it('times out with OllamaRequestError', async () => {
    await assert.rejects(client(hangingFetch, { chatTimeoutMs: 20 }).chat({ system: '', user: '' }), (e) => e instanceof OllamaRequestError && /timed out/.test(e.message));
  });

  it('turns network failures, HTTP errors and bad bodies into OllamaRequestError', async () => {
    const cases = [
      [connectionRefused, /request failed: fetch failed: ECONNREFUSED/],
      [fetchFrom(() => json({ error: 'model requires more system memory' }, 500)).fetch, /HTTP 500: model requires more system memory/],
      [fetchFrom(() => new Response('gateway', { status: 502 })).fetch, /HTTP 502 with a body that is not JSON/],
      [fetchFrom(() => json({ done: true })).fetch, /no message content/],
    ];
    for (const [fetch, pattern] of cases) {
      await assert.rejects(client(fetch).chat({ system: '', user: '' }), (e) => e instanceof OllamaRequestError && pattern.test(e.message), String(pattern));
    }
  });
});
