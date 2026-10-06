import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createBuiltinClient, doneReasonOf } from '../src/ai/builtin.js';
import { downloadModel, formatBytes, isModelReady, ModelDownloadError, modelPath, modelsDir } from '../src/ai/model-files.js';
import { AiRequestError } from '../src/ai/ollama.js';
import { selectAiProvider } from '../src/ai/providers.js';
import { SetupError } from '../src/errors.js';
import { normalizeOptions } from '../src/options.js';
import { runClean } from '../src/run.js';
import { captureIO, makeTempTree, removeNarratingComments, removeTree } from './helpers.js';

const dirs = [];
after(async () => {
  for (const dir of dirs) await removeTree(dir);
});
async function tempDir(files = {}) {
  const dir = await makeTempTree(files);
  dirs.push(dir);
  return dir;
}

/** A tiny stand-in "model file" and its metadata. */
const BYTES = Buffer.from('GGUF fake model weights '.repeat(400));
const FAKE_MODEL = Object.freeze({
  name: 'Fake Coder 0.1B',
  url: 'https://models.example/fake.gguf',
  fileName: 'fake.gguf',
  size: BYTES.length,
  sha256: createHash('sha256').update(BYTES).digest('hex'),
});

/**
 * A fetch serving the fake model (honoring Range) and answering Ollama as "not running".
 * @param {{ bytes?: Buffer, ignoreRange?: boolean, failAfter?: number, status?: number }} [opts]
 */
function modelServer({ bytes = BYTES, ignoreRange = false, failAfter, status } = {}) {
  const requests = [];
  /** @type {typeof globalThis.fetch} */
  const fetch = async (url, init = {}) => {
    const range = /** @type {any} */ (init.headers)?.Range;
    requests.push({ url: String(url), range });
    if (String(url).includes('11434')) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    if (status) return new Response('nope', { status });
    const from = range && !ignoreRange ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    const body = bytes.subarray(from);
    const half = Math.floor(body.length / 2);
    let reads = 0;
    // Erroring a stream discards queued chunks, so an "interrupted" download fails on a later read.
    const stream = new ReadableStream({
      pull(controller) {
        reads++;
        if (reads === 1) controller.enqueue(body.subarray(0, half));
        else if (failAfter !== undefined) controller.error(new Error('connection reset'));
        else if (reads === 2) controller.enqueue(body.subarray(half));
        else controller.close();
      },
    });
    return new Response(stream, { status: from > 0 ? 206 : 200 });
  };
  return { fetch, requests };
}

/** A fake node-llama-cpp: replies with `reply(user)`; records what it was given. */
function fakeLibrary({ reply = (user) => user, stopReason = 'eogToken', gpu = 'metal', loadError } = {}) {
  const calls = { loaded: [], prompts: [], disposed: 0, options: null };
  const lib = {
    LlamaLogLevel: { error: 'error' },
    async getLlama(options) {
      calls.options = options;
      return {
        gpu,
        async loadModel({ modelPath: p }) {
          if (loadError) throw new Error(loadError);
          calls.loaded.push(p);
          return {
            trainContextSize: 32768,
            async createContext({ contextSize }) {
              calls.contextSize = contextSize;
              return { getSequence: () => ({ dispose() {} }), async dispose() { calls.disposed++; } };
            },
            async dispose() {},
          };
        },
        async dispose() {},
      };
    },
    LlamaChatSession: class {
      constructor({ systemPrompt }) {
        this.systemPrompt = systemPrompt;
      }
      async promptWithMeta(user, options) {
        calls.prompts.push({ system: this.systemPrompt, user, options });
        if (options.signal?.aborted) throw new Error('aborted');
        const text = await reply(user, options);
        return { responseText: text, stopReason };
      }
      dispose() {}
    },
  };
  return { lib, calls };
}

function io(dir, { interactive = false, answer = 'y' } = {}) {
  const capture = captureIO(dir);
  const asked = [];
  capture.io.interactive = interactive;
  capture.io.ask = async (q) => {
    asked.push(q);
    return answer;
  };
  return { ...capture, asked };
}

/** Select a provider with the fake model, server and library. */
async function select(raw = {}, { interactive = false, answer = 'y', server = modelServer(), library = fakeLibrary(), modelsDirPath, freeBytes } = {}) {
  const dir = modelsDirPath ?? (await tempDir());
  const capture = io(dir, { interactive, answer });
  const options = normalizeOptions('.', raw);
  const selection = await selectAiProvider({
    options,
    io: capture.io,
    verbose: () => {},
    deps: { fetch: server.fetch, loadLibrary: async () => library.lib, modelsDir: dir, model: FAKE_MODEL, freeBytes: freeBytes ?? (async () => null) },
  });
  return { selection, ...capture, dir, server, library };
}

describe('model files', () => {
  it('uses the platform cache directory, or DE_CRAPIFY_CACHE_DIR', () => {
    assert.equal(modelsDir({ DE_CRAPIFY_CACHE_DIR: '/x' }, 'linux'), path.join('/x', 'models'));
    assert.match(modelsDir({}, 'darwin'), /Library\/Caches\/de-crapify\/models$/);
    assert.match(modelsDir({ XDG_CACHE_HOME: '/xdg' }, 'linux'), /^\/xdg\/de-crapify\/models$/);
    assert.match(modelsDir({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32'), /de-crapify.Cache.models$/);
  });

  it('downloads, verifies the checksum, and marks the model ready', async () => {
    const dir = await tempDir();
    const progress = [];
    assert.equal(await isModelReady(FAKE_MODEL, dir), false);
    await downloadModel({ model: FAKE_MODEL, dir, fetch: modelServer().fetch, onProgress: (r) => progress.push(r), freeBytes: async () => null });
    assert.equal(await isModelReady(FAKE_MODEL, dir), true);
    assert.deepEqual(await fs.readFile(modelPath(FAKE_MODEL, dir)), BYTES);
    assert.equal(progress.at(-1), BYTES.length);
    await assert.rejects(fs.stat(`${modelPath(FAKE_MODEL, dir)}.partial`), 'no partial file left');
  });

  it('resumes an interrupted download with a Range request', async () => {
    const dir = await tempDir();
    await assert.rejects(downloadModel({ model: FAKE_MODEL, dir, fetch: modelServer({ failAfter: 1 }).fetch, freeBytes: async () => null }), (e) => e instanceof ModelDownloadError && /interrupted.*resume/.test(e.message));
    const partialSize = (await fs.stat(`${modelPath(FAKE_MODEL, dir)}.partial`)).size;
    assert.ok(partialSize > 0 && partialSize < BYTES.length);
    const server = modelServer();
    await downloadModel({ model: FAKE_MODEL, dir, fetch: server.fetch, freeBytes: async () => null });
    assert.equal(server.requests[0].range, `bytes=${partialSize}-`);
    assert.equal(await isModelReady(FAKE_MODEL, dir), true);
  });

  it('starts over when the server ignores the range', async () => {
    const dir = await tempDir({ 'fake.gguf.partial': 'garbage' });
    await downloadModel({ model: FAKE_MODEL, dir, fetch: modelServer({ ignoreRange: true }).fetch, freeBytes: async () => null });
    assert.equal(await isModelReady(FAKE_MODEL, dir), true);
  });

  it('deletes a corrupted download and says so', async () => {
    const dir = await tempDir();
    const corrupted = Buffer.from(BYTES);
    corrupted[10] ^= 0xff;
    await assert.rejects(downloadModel({ model: FAKE_MODEL, dir, fetch: modelServer({ bytes: corrupted }).fetch, freeBytes: async () => null }), /checksum mismatch/);
    await assert.rejects(fs.stat(`${modelPath(FAKE_MODEL, dir)}.partial`));
    assert.equal(await isModelReady(FAKE_MODEL, dir), false);
  });

  it('refuses to start without enough disk space, and reports HTTP errors', async () => {
    const dir = await tempDir();
    await assert.rejects(downloadModel({ model: FAKE_MODEL, dir, fetch: modelServer().fetch, freeBytes: async () => 1000 }), /not enough disk space/);
    await assert.rejects(downloadModel({ model: FAKE_MODEL, dir, fetch: modelServer({ status: 404 }).fetch, freeBytes: async () => null }), /HTTP 404/);
  });

  it('is not "ready" if the marker is missing or the size is wrong', async () => {
    const dir = await tempDir({ 'fake.gguf': BYTES.toString() });
    assert.equal(await isModelReady(FAKE_MODEL, dir), false, 'no marker');
    await fs.writeFile(path.join(dir, 'fake.gguf.sha256'), FAKE_MODEL.sha256);
    await fs.writeFile(path.join(dir, 'fake.gguf'), 'short');
    assert.equal(await isModelReady(FAKE_MODEL, dir), false, 'wrong size');
  });

  it('formats sizes', () => {
    assert.equal(formatBytes(1_117_320_768), '1.1 GB');
    assert.equal(formatBytes(312_000_000), '312 MB');
  });
});

describe('built-in client', () => {
  it('never builds or downloads llama.cpp, runs at temperature 0, and maps stop reasons', async () => {
    const { lib, calls } = fakeLibrary({ reply: () => 'const a = 1;' });
    const client = await createBuiltinClient({ modelPath: '/m.gguf', modelName: 'M', numCtx: 8192, loadLibrary: async () => lib });
    assert.deepEqual({ build: calls.options.build, skipDownload: calls.options.skipDownload }, { build: 'never', skipDownload: true });
    assert.equal(calls.contextSize, 8192);
    assert.equal(client.gpu, 'metal');
    assert.deepEqual(await client.chat({ system: 'SYS', user: 'USER' }), { content: 'const a = 1;', doneReason: 'stop' });
    assert.equal(calls.prompts[0].system, 'SYS');
    assert.equal(calls.prompts[0].options.temperature, 0);
    await client.dispose();
    assert.equal(calls.disposed, 1);
  });

  it('maps stop reasons onto done_reason', () => {
    assert.equal(doneReasonOf('eogToken'), 'stop');
    assert.equal(doneReasonOf('stopGenerationTrigger'), 'stop');
    assert.equal(doneReasonOf('maxTokens'), 'length');
    assert.equal(doneReasonOf('abort'), 'abort');
  });

  it('times out a chunk with AiRequestError', async () => {
    const { lib } = fakeLibrary({ reply: (_user, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
    const client = await createBuiltinClient({ modelPath: '/m.gguf', modelName: 'M', numCtx: 8192, loadLibrary: async () => lib, chatTimeoutMs: 20 });
    await assert.rejects(client.chat({ system: '', user: '' }), (e) => e instanceof AiRequestError && /timed out/.test(e.message));
  });
});

describe('provider selection (auto)', () => {
  it('uses Ollama when it is running with the model', async () => {
    const ollamaUp = async (url) => new Response(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b' }] }), { status: String(url).endsWith('/api/tags') ? 200 : 404 });
    const { selection } = await select({}, { server: { fetch: ollamaUp } });
    assert.equal(selection.status, 'Ollama qwen2.5-coder:7b');
  });

  it('falls back to the built-in model, which is used directly when already downloaded', async () => {
    const dir = await tempDir();
    await downloadModel({ model: FAKE_MODEL, dir, fetch: modelServer().fetch, freeBytes: async () => null });
    const { selection, stderr: err, server, asked } = await select({}, { modelsDirPath: dir });
    assert.equal(selection.status, 'built-in Fake Coder 0.1B (metal)');
    assert.ok(selection.client);
    assert.deepEqual(asked, [], 'no question when the model is already there');
    assert.ok(!server.requests.some((r) => r.url.includes('models.example')), 'no download');
    assert.equal(err(), '');
  });

  it('in a terminal, asks once before downloading, then downloads and uses the model', async () => {
    const { selection, asked, stderr: err } = await select({}, { interactive: true, answer: '' });
    assert.equal(asked.length, 1);
    assert.match(asked[0], /runs on your machine \(your code never leaves it\)/);
    assert.match(asked[0], /one-time download: Fake Coder 0\.1B, 10 KB/);
    assert.match(asked[0], /\[Y\/n\] $/);
    assert.ok(selection.client, 'Enter means yes');
    assert.match(err(), /Downloaded Fake Coder 0\.1B/);
  });

  it('continues without AI when the download is declined, with a one-line explanation', async () => {
    const { selection, stderr: err } = await select({}, { interactive: true, answer: 'n' });
    assert.equal(selection.client, null);
    assert.match(selection.status, /skipped \(the AI model download was declined\)/);
    assert.match(err(), /AI cleanup skipped: the AI model download was declined\./);
    assert.match(err(), /--yes/);
  });

  it('never asks or downloads without a terminal (CI) unless --yes is given', async () => {
    const quiet = await select({});
    assert.equal(quiet.selection.client, null);
    assert.deepEqual(quiet.asked, []);
    assert.match(quiet.stderr(), /has not been downloaded yet/);
    assert.match(quiet.stderr(), /pass --yes/);
    const withYes = await select({ yes: true });
    assert.ok(withYes.selection.client);
    assert.deepEqual(withYes.asked, []);
  });

  it('never asks in --check mode, even in a terminal', async () => {
    const { asked, selection } = await select({ check: true }, { interactive: true });
    assert.deepEqual(asked, []);
    assert.equal(selection.client, null);
  });

  it('continues without AI when node-llama-cpp is not available on this machine', async () => {
    const dir = await tempDir();
    const capture = io(dir);
    const selection = await selectAiProvider({
      options: normalizeOptions('.', {}),
      io: capture.io,
      verbose: () => {},
      deps: { fetch: modelServer().fetch, loadLibrary: async () => { throw new Error('Cannot find package'); }, modelsDir: dir, model: FAKE_MODEL },
    });
    assert.equal(selection.client, null);
    assert.match(capture.stderr(), /not available on this machine/);
    assert.match(capture.stderr(), /ollama\.com/);
  });

  it('continues without AI when the download or loading fails', async () => {
    const failedDownload = await select({ yes: true }, { server: modelServer({ status: 503 }) });
    assert.equal(failedDownload.selection.client, null);
    assert.match(failedDownload.stderr(), /could not be downloaded: the download failed with HTTP 503/);
    const failedLoad = await select({ yes: true }, { library: fakeLibrary({ loadError: 'out of memory' }) });
    assert.equal(failedLoad.selection.client, null);
    assert.match(failedLoad.stderr(), /could not be loaded \(out of memory\)/);
  });

  it('is off with --no-ai, without touching anything', async () => {
    const { selection, server, asked } = await select({ ai: false });
    assert.equal(selection.status, 'off (--no-ai)');
    assert.deepEqual(server.requests, []);
    assert.deepEqual(asked, []);
  });
});

describe('provider selection (explicit)', () => {
  it('--ai-provider ollama, --model or --ollama-url: Ollama or a setup error, never the built-in model', async () => {
    for (const raw of [{ aiProvider: 'ollama' }, { model: 'llama3:8b' }, { ollamaUrl: 'http://localhost:11434' }]) {
      await assert.rejects(select(raw), (e) => e instanceof SetupError && /Ollama doesn't seem to be running/.test(e.message), JSON.stringify(raw));
    }
  });

  it('--ai-provider builtin: skips Ollama, and failures are setup errors', async () => {
    const { server } = await select({ aiProvider: 'builtin', yes: true });
    assert.ok(!server.requests.some((r) => r.url.includes('11434')), 'Ollama is not contacted');
    await assert.rejects(select({ aiProvider: 'builtin' }), (e) => e instanceof SetupError && /has not been downloaded yet/.test(e.message));
  });
});

describe('the whole run with the built-in model', () => {
  it('cleans code with the built-in model and names it in the summary', async () => {
    const root = await tempDir({
      'package.json': '{}',
      'sum.js': 'export function sum(values) {\n  // Start at zero\n  let total = 0;\n  // Add each value\n  for (const v of values) total += v;\n  return total;\n}\n',
    });
    const cache = await tempDir();
    const library = fakeLibrary({ reply: (user) => removeNarratingComments(user.slice(user.indexOf('return only the code:\n\n') + 23)) });
    const capture = captureIO(root);
    const code = await runClean(normalizeOptions('.', { yes: true }), capture.io, {
      fetch: modelServer().fetch,
      ai: { loadLibrary: async () => library.lib, modelsDir: cache, model: FAKE_MODEL, freeBytes: async () => null },
    });
    assert.equal(code, 0);
    assert.match(capture.stdout(), /AI: removed \d+ comment/);
    assert.match(capture.stdout(), /AI\s+built-in Fake Coder 0\.1B \(metal\) \(1 chunk\(s\) sent\)/);
    assert.equal(library.calls.disposed, 1, 'the model is unloaded at the end');
  });

  it('without AI available, still runs the deterministic rules and exits normally', async () => {
    const root = await tempDir({ 'package.json': '{}', 'a.js': "console.log('x');\nexport const a = 1;\n" });
    const capture = captureIO(root);
    const code = await runClean(normalizeOptions('.', {}), capture.io, {
      fetch: modelServer().fetch,
      ai: { loadLibrary: async () => fakeLibrary().lib, modelsDir: await tempDir(), model: FAKE_MODEL },
    });
    assert.equal(code, 0);
    assert.match(capture.stdout(), /removed `console\.log\('x'\)`/);
    assert.match(capture.stdout(), /AI\s+skipped \(the AI model has not been downloaded yet\)/);
  });
});
