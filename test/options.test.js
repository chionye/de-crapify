import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SetupError } from '../src/errors.js';
import { DEFAULTS, ineffectiveOptionWarnings, normalizeOptions } from '../src/options.js';

describe('normalizeOptions', () => {
  it('applies defaults', () => {
    const o = normalizeOptions('src', {});
    assert.equal(o.targetPath, 'src');
    assert.equal(o.write, false);
    assert.equal(o.check, false);
    assert.equal(o.force, false);
    assert.equal(o.ai, true);
    assert.equal(o.model, DEFAULTS.model);
    assert.equal(o.ollamaUrl, 'http://localhost:11434');
    assert.equal(o.numCtx, 8192);
    assert.equal(o.typecheck, 'auto');
    assert.equal(o.testCmd, undefined);
    assert.equal(o.maxFileSizeBytes, 200 * 1024);
    assert.deepEqual([...o.keepConsole], ['error', 'warn']);
    assert.equal(o.verbose, false);
  });

  it('reads explicit values', () => {
    const o = normalizeOptions('x.ts', {
      write: true,
      force: true,
      ai: false,
      model: 'llama3:8b',
      ollamaUrl: 'http://10.0.0.2:11434/',
      numCtx: '16384',
      typecheck: false,
      testCmd: 'npm test',
      maxFileSize: '50',
      keepConsole: 'error, warn ,info',
      verbose: true,
    });
    assert.equal(o.write, true);
    assert.equal(o.ai, false);
    assert.equal(o.model, 'llama3:8b');
    assert.equal(o.ollamaUrl, 'http://10.0.0.2:11434');
    assert.equal(o.numCtx, 16384);
    assert.equal(o.typecheck, false);
    assert.equal(o.testCmd, 'npm test');
    assert.equal(o.maxFileSizeBytes, 50 * 1024);
    assert.deepEqual([...o.keepConsole], ['error', 'warn', 'info']);
  });

  it('treats --typecheck as an explicit on', () => {
    assert.equal(normalizeOptions('x', { typecheck: true }).typecheck, true);
  });

  it('allows an empty --keep-console (remove all debug methods)', () => {
    assert.equal(normalizeOptions('x', { keepConsole: '' }).keepConsole.size, 0);
  });

  it('rejects --check with --write', () => {
    assert.throws(() => normalizeOptions('x', { check: true, write: true }), SetupError);
  });

  it('rejects bad numbers', () => {
    for (const numCtx of ['0', '-1', 'abc', '1.5']) {
      assert.throws(() => normalizeOptions('x', { numCtx }), SetupError, `numCtx=${numCtx}`);
    }
    for (const maxFileSize of ['0', '-3', 'big']) {
      assert.throws(() => normalizeOptions('x', { maxFileSize }), SetupError, `maxFileSize=${maxFileSize}`);
    }
  });

  it('rejects bad URLs and empty model names', () => {
    assert.throws(() => normalizeOptions('x', { ollamaUrl: 'not a url' }), SetupError);
    assert.throws(() => normalizeOptions('x', { ollamaUrl: 'ftp://host' }), SetupError);
    assert.throws(() => normalizeOptions('x', { model: '  ' }), SetupError);
  });

  it('rejects a missing path', () => {
    assert.throws(() => normalizeOptions('', {}), SetupError);
  });

  it('ignores a blank --test-cmd', () => {
    assert.equal(normalizeOptions('x', { testCmd: '   ' }).testCmd, undefined);
  });
});

describe('ineffectiveOptionWarnings', () => {
  it('warns about --test-cmd and --force without --write', () => {
    const warnings = ineffectiveOptionWarnings(normalizeOptions('x', { testCmd: 'npm test', force: true }));
    assert.equal(warnings.length, 2);
  });

  it('is quiet when the options apply', () => {
    assert.deepEqual(ineffectiveOptionWarnings(normalizeOptions('x', { write: true, testCmd: 'npm test', force: true })), []);
  });
});
