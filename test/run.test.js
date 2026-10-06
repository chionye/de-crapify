import assert from 'node:assert/strict';
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

  it('never modifies files', async () => {
    const files = { 'a.js': "import x from 'y';\nconsole.log(1);\n" };
    const { stdout } = await runOn(files, { write: true, force: true });
    assert.match(stdout(), /Files changed\s+0/);
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
