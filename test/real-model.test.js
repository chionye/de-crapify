// Opt-in: runs the real built-in model end to end. It downloads ~1.1 GB the first time.
//   DE_CRAPIFY_REAL_MODEL=1 npm test
// Set DE_CRAPIFY_CACHE_DIR to reuse a download between runs.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { normalizeOptions } from '../src/options.js';
import { runClean } from '../src/run.js';
import { captureIO, copyFixture, removeTree } from './helpers.js';

const enabled = process.env.DE_CRAPIFY_REAL_MODEL === '1';
const dirs = [];
after(async () => {
  for (const dir of dirs) await removeTree(dir);
});

describe('real built-in model', { skip: !enabled && 'set DE_CRAPIFY_REAL_MODEL=1 to run (downloads ~1.1 GB once)' }, () => {
  it('cleans the React fixture: every accepted change passed validation, and the run completes', { timeout: 30 * 60_000 }, async () => {
    const root = await copyFixture('react-classic');
    dirs.push(path.dirname(root));
    const capture = captureIO(root);
    const code = await runClean(normalizeOptions('.', { aiProvider: 'builtin', yes: true, verbose: true }), capture.io);
    const out = capture.stdout();
    assert.equal(code, 0);
    assert.match(out, /AI\s+built-in Qwen2\.5-Coder 1\.5B Instruct \(Q4_K_M\) \(\w+\) \(\d+ chunk\(s\) sent/);
    // Print what the model did, for tuning.
    process.stderr.write(`${capture.stderr()}\n${out}\n`);
  });
});
