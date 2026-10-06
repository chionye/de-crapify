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

  it('never modifies files on disk (dry run, and --write is not implemented yet)', async () => {
    const files = { 'a.js': "import x from 'y';\nconsole.log(1);\n" };
    const dir = await makeTempTree(files);
    dirs.push(dir);
    for (const raw of [{}, { write: true, force: true }]) {
      const capture = captureIO(dir);
      await runClean(normalizeOptions('.', { ai: false, ...raw }), capture.io);
      assert.match(capture.stdout(), /removed unused import `x`/);
      assert.equal(await fs.readFile(path.join(dir, 'a.js'), 'utf8'), files['a.js']);
    }
  });

  it('warns that --write is not implemented yet', async () => {
    const { stderr } = await runOn({ 'a.js': '' }, { write: true });
    assert.match(stderr(), /--write is not implemented yet/);
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
