import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createProgram } from '../src/cli.js';
import { makeTempTree, removeTree } from './helpers.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

/** Parse args with the real program, capturing what the `clean` action receives. */
async function parse(args) {
  let received;
  const program = createProgram({
    onClean: (targetPath, raw) => {
      received = { targetPath, raw };
    },
  });
  await program.parseAsync(['clean', ...args], { from: 'user' });
  return received;
}

describe('CLI flag parsing', () => {
  it('passes the path and defaults', async () => {
    const { targetPath, raw } = await parse(['src']);
    assert.equal(targetPath, 'src');
    assert.equal(raw.ai, true);
    assert.equal(raw.write, undefined);
    assert.equal(raw.typecheck, undefined, 'typecheck stays undefined (auto) when neither flag is given');
    assert.equal(raw.model, 'qwen2.5-coder:7b');
    assert.equal(raw.ollamaUrl, 'http://localhost:11434');
    assert.equal(raw.numCtx, '8192');
    assert.equal(raw.maxFileSize, '200');
    assert.equal(raw.keepConsole, 'error,warn');
  });

  it('parses every flag', async () => {
    const { raw } = await parse([
      'src',
      '--write',
      '--force',
      '--no-ai',
      '--model', 'm:1b',
      '--ollama-url', 'http://h:1',
      '--num-ctx', '4096',
      '--typecheck',
      '--test-cmd', 'npm test',
      '--max-file-size', '10',
      '--keep-console', 'error',
      '--verbose',
    ]);
    assert.equal(raw.write, true);
    assert.equal(raw.force, true);
    assert.equal(raw.ai, false);
    assert.equal(raw.model, 'm:1b');
    assert.equal(raw.ollamaUrl, 'http://h:1');
    assert.equal(raw.numCtx, '4096');
    assert.equal(raw.typecheck, true);
    assert.equal(raw.testCmd, 'npm test');
    assert.equal(raw.maxFileSize, '10');
    assert.equal(raw.keepConsole, 'error');
    assert.equal(raw.verbose, true);
  });

  it('parses --check and --no-typecheck', async () => {
    const { raw } = await parse(['src', '--check', '--no-typecheck']);
    assert.equal(raw.check, true);
    assert.equal(raw.typecheck, false);
  });
});

describe('CLI end to end (exit codes)', () => {
  let dir;
  before(async () => {
    dir = await makeTempTree({ 'a.js': 'export const a = 1;\n' });
  });
  after(() => removeTree(dir));

  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: dir });

  it('exits 0 on a clean dry run and prints the summary', () => {
    const r = run('clean', '.', '--no-ai');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Files scanned\s+1/);
  });

  it('exits 0 in --check mode when nothing is found', () => {
    assert.equal(run('clean', '.', '--check', '--no-ai').status, 0);
  });

  it('exits 2 for a missing path', () => {
    const r = run('clean', 'does-not-exist');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Path not found/);
  });

  it('exits 2 for --check with --write', () => {
    assert.equal(run('clean', '.', '--check', '--write').status, 2);
  });

  it('exits 2 for an unknown flag or missing argument', () => {
    assert.equal(run('clean', '.', '--bogus').status, 2);
    assert.equal(run('clean').status, 2);
    assert.equal(run().status, 2);
  });

  it('exits 2 for an invalid number', () => {
    assert.equal(run('clean', '.', '--num-ctx', 'lots').status, 2);
  });

  it('exits 0 for --help and --version', () => {
    assert.equal(run('--help').status, 0);
    assert.equal(run('clean', '--help').status, 0);
    assert.equal(run('--version').status, 0);
  });
});
