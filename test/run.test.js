import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { normalizeOptions } from '../src/options.js';
import { runClean } from '../src/run.js';
import { captureIO, makeTempTree, removeTree } from './helpers.js';

const dirs = [];
after(async () => {
  for (const dir of dirs) await removeTree(dir);
});

async function runOn(files, raw = {}) {
  const dir = await makeTempTree(files);
  dirs.push(dir);
  const capture = captureIO(dir);
  const code = await runClean(normalizeOptions('.', { ai: false, ...raw }), capture.io);
  return { code, ...capture };
}

describe('runClean (phase 1 pipeline)', () => {
  it('scans parseable files and skips the rest with a reason', async () => {
    const { code, stdout } = await runOn({
      'ok.js': 'export const a = 1;\n',
      'ok.tsx': 'export const B = () => <div />;\n',
      'broken.js': 'function (\n',
      'ignored.js': '// de-crapify-ignore-file\nconsole.log(1);\n',
      'gen.ts': '// @generated\nexport {};\n',
    });
    assert.equal(code, 0);
    assert.match(stdout(), /Files scanned\s+2/);
    assert.match(stdout(), /Files skipped\s+3/);
    assert.match(stdout(), /could not parse: broken\.js/);
    assert.match(stdout(), /ignored \(de-crapify-ignore-file\): ignored\.js/);
    assert.match(stdout(), /generated \(@generated\): gen\.ts/);
  });

  it('never modifies files on disk in a dry run', async () => {
    const files = { 'a.js': "import x from 'y';\nconsole.log(1);\n" };
    const dir = await makeTempTree(files);
    dirs.push(dir);
    const capture = captureIO(dir);
    await runClean(normalizeOptions('.', { ai: false }), capture.io);
    assert.match(capture.stdout(), /removed unused import `x`/);
    assert.equal(await fs.readFile(path.join(dir, 'a.js'), 'utf8'), files['a.js']);
  });

  it('refuses --write outside a git repository (without --force)', async () => {
    const dir = await makeTempTree({ 'a.js': 'console.log(1);\n' });
    dirs.push(dir);
    await assert.rejects(runClean(normalizeOptions('.', { ai: false, write: true }), captureIO(dir).io), /outside a git repository/);
    assert.equal(await fs.readFile(path.join(dir, 'a.js'), 'utf8'), 'console.log(1);\n');
  });

  it('logs skip reasons with --verbose', async () => {
    const { stderr } = await runOn({ 'broken.js': 'function (' }, { verbose: true });
    assert.match(stderr(), /skip .*broken\.js/);
  });

  it('describes AI as off with --no-ai', async () => {
    const { stdout } = await runOn({ 'a.js': '' });
    assert.match(stdout(), /AI\s+off \(--no-ai\)/);
  });
});

describe('--check exit codes', () => {
  const check = async (files) => {
    const dir = await makeTempTree({ 'package.json': '{}', ...files });
    dirs.push(dir);
    return runClean(normalizeOptions('.', { ai: false, check: true }), captureIO(dir).io);
  };

  it('exits 0 when nothing is found', async () => {
    assert.equal(await check({ 'a.js': 'export const a = 1;\n' }), 0);
  });

  it('exits 1 for cleanups', async () => {
    assert.equal(await check({ 'a.js': "console.log('x');\nexport const a = 1;\n" }), 1);
  });

  it('exits 1 for a likely hallucinated import, even with nothing to clean', async () => {
    assert.equal(await check({ 'a.js': "import x from 'react-super-forms';\nexport default x;\n" }), 1);
  });

  it('exits 0 when the only findings are "could not verify", unsafe console calls, or god files', async () => {
    assert.equal(await check({ 'vite.config.js': 'export default {};\n', 'a.js': "import x from '@/nowhere';\nexport default x;\n" }), 0);
    assert.equal(await check({ 'a.js': 'export const f = () => console.log(load());\n' }), 0);
  });
});
