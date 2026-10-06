// The whole pipeline with AI on: preflight → Stage 1 → AI (mocked Ollama) → validation → typecheck → output.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SetupError } from '../src/errors.js';
import { normalizeOptions } from '../src/options.js';
import { runClean } from '../src/run.js';
import { captureIO, copyFixture, makeTempTree, mockOllamaFetch, removeNarratingComments, removeTree } from './helpers.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
const dirs = [];
after(async () => {
  for (const dir of dirs) await removeTree(dir);
});

async function fixture(name) {
  const root = await copyFixture(name);
  dirs.push(path.dirname(root));
  return root;
}

/** Run `clean .` in `root` with AI on and a mocked Ollama. */
async function runWithAi(root, { reply = removeNarratingComments, models, raw = {}, deps = {} } = {}) {
  const mock = mockOllamaFetch({ reply, models });
  const capture = captureIO(root);
  // Never load the real model library here; built-in provider tests live in test/ai-providers.test.js.
  const ai = { loadLibrary: async () => { throw new Error('not in this test'); }, ...deps.ai };
  const code = await runClean(normalizeOptions('.', raw), capture.io, { fetch: mock.fetch, ...deps, ai });
  return { code, out: capture.stdout(), err: capture.stderr(), calls: mock.calls };
}

describe('AI run: preflight', () => {
  it('stops with a setup error when Ollama is not reachable (CLI exit 2)', async () => {
    const root = await makeTempTree({ 'a.js': 'export const a = 1;\n' });
    dirs.push(root);
    const r = spawnSync(process.execPath, [BIN, 'clean', '.', '--ollama-url', 'http://127.0.0.1:9'], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Ollama doesn't seem to be running at http:\/\/127\.0\.0\.1:9/);
    assert.match(r.stderr, /ollama serve/);
    assert.match(r.stderr, /--no-ai/);
  });

  it('with --ai-provider ollama, stops before processing any file when the model is missing', async () => {
    const root = await fixture('react-classic');
    await assert.rejects(
      runWithAi(root, { models: ['llama3:8b'], raw: { aiProvider: 'ollama' } }),
      (e) => e instanceof SetupError && /ollama pull qwen2\.5-coder:7b/.test(e.hint ?? ''),
    );
  });

  it('uses --model, --ollama-url and --num-ctx', async () => {
    const root = await fixture('react-classic');
    const { calls } = await runWithAi(root, { models: ['llama3:8b'], raw: { model: 'llama3:8b', ollamaUrl: 'http://gpu-box:11434', numCtx: '16384' } });
    assert.equal(calls[0].url, 'http://gpu-box:11434/api/tags');
    const chat = calls.find((c) => c.url.endsWith('/api/chat'));
    assert.equal(chat?.body.model, 'llama3:8b');
    assert.equal(chat?.body.options.num_ctx, 16384);
  });

  it('never contacts Ollama with --no-ai', async () => {
    const root = await fixture('react-classic');
    const { calls, out } = await runWithAi(root, { raw: { ai: false } });
    assert.deepEqual(calls, []);
    assert.match(out, /AI\s+off \(--no-ai\)/);
  });
});

describe('AI run: results', () => {
  it('shows AI reasons under the diff and counts accepted fixes', async () => {
    const root = await fixture('react-classic');
    const { out, code } = await runWithAi(root);
    assert.equal(code, 0);
    assert.match(out, /• AI: removed \d+ comments in `SignupForm`/);
    assert.match(out, /• AI: removed \d+ comments in `validateSignup`/);
    assert.match(out, /• removed unused import `useEffect` from 'react'/, 'deterministic reasons are still there');
    assert.match(out, /AI fixes accepted\s+[1-9]/);
    assert.match(out, /AI\s+Ollama qwen2\.5-coder:7b \(\d+ chunk\(s\) sent\)/);
    assert.doesNotMatch(out, /^\+.*\/\/ State for the email field/m);
  });

  it('counts rejected suggestions by reason in the summary', async () => {
    const root = await fixture('react-classic');
    const { out } = await runWithAi(root, { reply: (code) => removeNarratingComments(code).replace(/return errors;/, 'return normalize(errors);') });
    assert.match(out, /AI suggestions rejected\s+1/);
    assert.match(out, /1 × uses new identifiers/);
  });

  it('reports failed requests in the AI status line and keeps going', async () => {
    const root = await fixture('react-classic');
    const { out } = await runWithAi(root, { reply: (code) => (code.includes('validateSignup(values)') ? new Error('boom') : removeNarratingComments(code)) });
    assert.match(out, /1 request\(s\) failed or timed out/);
    assert.match(out, /AI: removed \d+ comments in `SignupForm`/);
  });

  it('shows progress on stderr without --verbose, and details with it', async () => {
    const root = await fixture('react-classic');
    const quiet = await runWithAi(root);
    assert.match(quiet.err, /AI src\/SignupForm\.tsx › SignupForm \(1\/1\)/);
    const loud = await runWithAi(root, { raw: { verbose: true }, reply: (code) => code.replace('Email is required', 'Email required') });
    assert.match(loud.err, /AI validateSignup: rejected \(changed literal values\)/);
    assert.match(loud.err, /AI buildPayload: no change|AI skip/);
  });

  it('in --check mode, exits 1 when only the AI finds cleanups, and 0 when nothing is found', async () => {
    const root = await makeTempTree({
      'package.json': '{}',
      'sum.js': 'export function sum(values) {\n  // Start at zero\n  let total = 0;\n  // Add each value\n  for (const v of values) total += v;\n  return total;\n}\n',
    });
    dirs.push(root);
    const found = await runWithAi(root, { raw: { check: true } });
    assert.equal(found.code, 1);
    assert.match(found.out, /AI: removed 2 comments in `sum`/);
    const nothing = await runWithAi(root, { reply: (code) => code, raw: { check: true } });
    assert.equal(nothing.code, 0);
  });
});

describe('AI run: typecheck drops AI changes that break types, keeps deterministic ones', () => {
  const ts6 = (() => {
    try {
      return createRequire(import.meta.url)('typescript-6');
    } catch {
      return null;
    }
  })();

  it('with a real TypeScript 6', { skip: !ts6 && 'typescript-6 devDependency not installed' }, async () => {
    const source = [
      "import { readFileSync } from 'node:fs';",
      '',
      'interface Item {',
      '  id: string;',
      '}',
      '',
      'export function ids(items: Item[]): string[] {',
      '  // Get the id of an item',
      '  const getId = (item: Item) => item.id;',
      '  // Map the items',
      '  const result = items.map(getId);',
      '  return result;',
      '}',
      '',
    ].join('\n');
    const root = await makeTempTree({
      'package.json': '{}',
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] }, include: ['src'] }),
      'src/words.ts': source,
    });
    dirs.push(root);
    // Passes validation (dropping a type reference is allowed: no new names, literals or growth),
    // but `item` is now an implicit any (TS7006) under strict mode.
    const reply = (code) => removeNarratingComments(code).replace('(item: Item) =>', '(item) =>');
    const { out } = await runWithAi(root, { reply, deps: { loadTypeScript: () => ts6 } });
    assert.match(out, /^-import \{ readFileSync \} from 'node:fs';$/m, 'the deterministic fix stays');
    assert.doesNotMatch(out, /^\+\s+const getId = \(item\) =>/m, 'the AI change was dropped');
    assert.doesNotMatch(out, /^-\s+\/\/ Get the id of an item$/m, 'including its harmless parts');
    assert.match(out, /words\.ts: new type errors, dropped the AI changes \(words\.ts: TS7006/);
    assert.match(out, /AI fixes accepted\s+0/);
    assert.match(out, /Typecheck\s+ran \(tsconfig\.json\); 1 file\(s\) changed back/);
  });
});
