import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { SetupError } from '../src/errors.js';
import { assertSafeToWrite, gitState } from '../src/git.js';
import { normalizeOptions } from '../src/options.js';
import { runClean } from '../src/run.js';
import { outputTail, runTestCommand } from '../src/test-cmd.js';
import { loadProjectTypeScript, resolveProjectTsc } from '../src/typecheck.js';
import { writeChanges, writeFileAtomic } from '../src/write.js';
import { captureIO, hasGit, makeTempTree, mockOllamaFetch, removeTree, writeTree } from './helpers.js';

const dirs = [];
after(async () => {
  for (const dir of dirs) await removeTree(dir);
});

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

/** A temp git repo with `files` committed. */
async function repo(files) {
  const dir = await makeTempTree(files);
  dirs.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

const read = (dir, rel) => fs.readFile(path.join(dir, rel), 'utf8');

/** `de-crapify clean . --write` in `dir` (no AI unless a model reply is given). */
async function write(dir, raw = {}, { reply, deps = {} } = {}) {
  const capture = captureIO(dir);
  const options = normalizeOptions('.', { write: true, ai: Boolean(reply), ...raw });
  const fetch = reply ? mockOllamaFetch({ reply }).fetch : undefined;
  const code = await runClean(options, capture.io, { fetch, ...deps });
  return { code, out: capture.stdout(), err: capture.stderr() };
}

const MESSY = "import { unused } from './b.js';\n\nexport function a() {\n  console.log('debug');\n  return 1;\n}\n";
const CLEAN = 'export function a() {\n  return 1;\n}\n';

describe('git safety check', { skip: !hasGit && 'git not installed' }, () => {
  it('reports dirty source files under the target only (modified, staged, untracked), ignoring other files', async () => {
    const dir = await repo({ 'src/a.ts': 'a', 'src/b.ts': 'b', 'other/c.ts': 'c', 'README.md': 'r' });
    await writeTree(dir, { 'src/a.ts': 'changed', 'src/new.ts': 'new', 'src/notes.md': 'notes', 'other/c.ts': 'changed elsewhere', 'README.md': 'changed' });
    await fs.writeFile(path.join(dir, 'src/b.ts'), 'staged');
    git(dir, 'add', 'src/b.ts');
    const state = await gitState(path.join(dir, 'src'), dir);
    assert.equal(state.inRepo, true);
    assert.deepEqual(state.dirty.map((f) => path.relative(dir, f)).sort(), ['src/a.ts', 'src/b.ts', 'src/new.ts']);
  });

  it('is clean right after a commit, and knows when there is no repo', async () => {
    const dir = await repo({ 'a.js': 'a' });
    assert.deepEqual((await gitState(dir, dir)).dirty, []);
    assert.deepEqual(await gitState('/tmp/x', null), { inRepo: false, dirty: [], error: null });
  });

  it('refuses outside a repo, with dirty files, or when git fails; --force overrides', () => {
    const cwd = '/p';
    assert.throws(() => assertSafeToWrite({ inRepo: false, dirty: [], error: null }, { force: false, cwd }), (e) => e instanceof SetupError && /outside a git repository/.test(e.message));
    assert.throws(() => assertSafeToWrite({ inRepo: true, dirty: ['/p/src/a.ts'], error: null }, { force: false, cwd }), /1 source file\(s\) under the target have uncommitted changes:\n {2}src\/a\.ts/);
    assert.throws(() => assertSafeToWrite({ inRepo: true, dirty: [], error: 'git: not found' }, { force: false, cwd }), /could not check/);
    assert.doesNotThrow(() => assertSafeToWrite({ inRepo: false, dirty: ['x'], error: 'y' }, { force: true, cwd }));
    assert.doesNotThrow(() => assertSafeToWrite({ inRepo: true, dirty: [], error: null }, { force: false, cwd }));
  });
});

describe('test command runner', () => {
  it('reports pass and fail, with the end of the output', async () => {
    const pass = await runTestCommand(`"${process.execPath}" -e "console.log('ok')"`, { cwd: process.cwd() });
    assert.equal(pass.ok, true);
    const fail = await runTestCommand(`"${process.execPath}" -e "console.error('1 failing'); process.exit(3)"`, { cwd: process.cwd() });
    assert.deepEqual([fail.ok, fail.code], [false, 3]);
    assert.equal(outputTail(fail.output), '1 failing');
  });

  it('treats a command that cannot run as a failure', async () => {
    const result = await runTestCommand('definitely-not-a-command-xyz', { cwd: process.cwd() });
    assert.equal(result.ok, false);
  });
});

describe('writing files', () => {
  it('writes atomically and keeps file permissions', async () => {
    const dir = await makeTempTree({ 'run.sh': 'old' });
    dirs.push(dir);
    const file = path.join(dir, 'run.sh');
    await fs.chmod(file, 0o755);
    await writeFileAtomic(file, 'new');
    assert.equal(await fs.readFile(file, 'utf8'), 'new');
    assert.equal((await fs.stat(file)).mode & 0o777, 0o755);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['run.sh'], 'no temp file left behind');
  });

  it('skips a file that changed on disk since it was read', async () => {
    const dir = await makeTempTree({ 'a.js': 'edited by someone', 'b.js': 'b' });
    dirs.push(dir);
    const { written, skipped } = await writeChanges([
      { file: path.join(dir, 'a.js'), before: 'original', after: 'cleaned' },
      { file: path.join(dir, 'b.js'), before: 'b', after: 'b2' },
    ]);
    assert.deepEqual(written.map((w) => path.basename(w.file)), ['b.js']);
    assert.match(skipped[0].reason, /changed on disk/);
    assert.equal(await read(dir, 'a.js'), 'edited by someone');
  });
});

describe('--write end to end', { skip: !hasGit && 'git not installed' }, () => {
  it('writes the cleanups and prints a short per-file summary', async () => {
    const dir = await repo({ 'package.json': '{}', 'a.js': MESSY, 'b.js': 'export const unused = 1;\n', 'clean.js': CLEAN });
    const { code, out } = await write(dir);
    assert.equal(code, 0);
    assert.equal(await read(dir, 'a.js'), CLEAN);
    assert.match(out, /✔ wrote a\.js \(2 fixes: 2 deterministic\)/);
    assert.doesNotMatch(out, /diff --git/, 'no full diff without --verbose');
    assert.match(out, /Files changed\s+1/);
    assert.match(git(dir, 'diff', '--stat'), /a\.js/, 'reviewable and undoable with git');
  });

  it('shows the diff too with --verbose', async () => {
    const dir = await repo({ 'package.json': '{}', 'a.js': MESSY, 'b.js': 'export const unused = 1;\n' });
    assert.match((await write(dir, { verbose: true })).out, /diff --git a\/a\.js/);
  });

  it('refuses with uncommitted changes, writing nothing; --force writes anyway', async () => {
    const dir = await repo({ 'package.json': '{}', 'a.js': MESSY, 'b.js': 'export const unused = 1;\n' });
    await fs.appendFile(path.join(dir, 'b.js'), '// wip\n');
    await assert.rejects(write(dir), (e) => e instanceof SetupError && /uncommitted changes:\n {2}b\.js/.test(e.message));
    assert.equal(await read(dir, 'a.js'), MESSY);
    await write(dir, { force: true });
    assert.equal(await read(dir, 'a.js'), CLEAN);
  });

  it('never writes in --check mode', async () => {
    const dir = await repo({ 'package.json': '{}', 'a.js': MESSY, 'b.js': 'export const unused = 1;\n' });
    const capture = captureIO(dir);
    const code = await runClean(normalizeOptions('.', { check: true, ai: false }), capture.io);
    assert.equal(code, 1);
    assert.equal(await read(dir, 'a.js'), MESSY);
  });
});

describe('--write with --test-cmd', { skip: !hasGit && 'git not installed' }, () => {
  /** A "test suite": fails when check.json's condition is violated. */
  const checkScript = (body) => `const fs = require('node:fs');\n${body}\n`;
  const testCmd = `"${process.execPath}" check.cjs`;

  it('aborts before changing anything when the tests already fail', async () => {
    const dir = await repo({ 'package.json': '{}', 'a.js': MESSY, 'b.js': 'export const unused = 1;\n', 'check.cjs': checkScript("console.error('2 tests failed'); process.exit(1);") });
    await assert.rejects(write(dir, { testCmd }), (e) => e instanceof SetupError && /fails before de-crapify changes anything/.test(e.message) && /2 tests failed/.test(e.hint ?? ''));
    assert.equal(await read(dir, 'a.js'), MESSY);
  });

  it('keeps everything when the tests pass (running them only once)', async () => {
    const dir = await repo({ 'package.json': '{}', 'a.js': MESSY, 'b.js': 'export const unused = 1;\n', 'check.cjs': checkScript("fs.appendFileSync('runs.log', 'x');") });
    await fs.appendFile(path.join(dir, '.gitignore'), 'runs.log\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'ignore');
    const { out } = await write(dir, { testCmd });
    assert.equal(await read(dir, 'a.js'), CLEAN);
    assert.equal(await read(dir, 'runs.log'), 'xx', 'baseline + one run');
    assert.doesNotMatch(out, /Files reverted/);
  });

  it('finds the file that breaks the tests, changes it back, and keeps the rest', async () => {
    const dir = await repo({
      'package.json': '{}',
      'a.js': MESSY,
      'b.js': 'export const unused = 1;\n',
      'c.js': "export function c() {\n  console.log('the tests read this line');\n  return 2;\n}\n",
      'check.cjs': checkScript("if (!fs.readFileSync('c.js', 'utf8').includes('the tests read this line')) { console.error('c.test: expected log line'); process.exit(1); }"),
    });
    const { out, err } = await write(dir, { testCmd });
    assert.equal(await read(dir, 'a.js'), CLEAN, 'a.js keeps its cleanup');
    assert.match(await read(dir, 'c.js'), /the tests read this line/, 'c.js is back to how it was');
    assert.match(err, /checking the files one at a time/);
    assert.match(out, /Files reverted\s+1/);
    assert.match(out, /c\.js: tests failed with this file's changes, left it unchanged \(c\.test: expected log line\)/);
    assert.match(out, /Files changed\s+1/);
  });

  it('drops only the AI changes when the deterministic ones pass the tests', async () => {
    const source = "import { unused } from './b.js';\n\nexport function total(values) {\n  // Start at zero, see BUG-12\n  let sum = 0;\n  for (const v of values) sum += v;\n  return sum;\n}\n";
    const dir = await repo({
      'package.json': '{}',
      'a.js': source,
      'b.js': 'export const unused = 1;\n',
      'check.cjs': checkScript("if (!fs.readFileSync('a.js', 'utf8').includes('BUG-12')) { console.error('lint: BUG-12 reference removed'); process.exit(1); }"),
    });
    // The "model" removes every comment, including the one the (contrived) test suite needs.
    const reply = (code) => code.replace(/^\s*\/\/.*\n/gm, '');
    const { out } = await write(dir, { testCmd }, { reply });
    const after = await read(dir, 'a.js');
    assert.doesNotMatch(after, /import \{ unused \}/, 'the deterministic fix stays');
    assert.match(after, /BUG-12/, 'the AI change was dropped');
    assert.match(out, /a\.js: tests failed with the AI changes, kept the deterministic fixes/);
    assert.match(out, /AI fixes accepted\s+0/);
  });
});

describe('--write with a TypeScript 7 project (tsc binary, real)', { skip: (!hasGit || !resolveProjectTsc(process.cwd())) && 'git or typescript 7 missing' }, () => {
  const ts7 = loadProjectTypeScript(process.cwd());
  const tscPath = resolveProjectTsc(process.cwd());

  it('type-checks with the binary in write mode and drops AI changes that add errors', async () => {
    const dir = await repo({
      'package.json': '{}',
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['src'] }),
      'src/ids.ts': "import { readFileSync } from 'node:fs';\n\ninterface Item {\n  id: string;\n}\n\nexport function ids(items: Item[]): string[] {\n  // Get the id of an item\n  const getId = (item: Item) => item.id;\n  const result = items.map(getId);\n  return result;\n}\n",
    });
    const reply = (code) => code.replace('(item: Item) =>', '(item) =>');
    const dry = await write(dir, { write: false }, { reply, deps: { loadTypeScript: () => ts7, resolveTsc: () => tscPath } });
    assert.match(dry.out, /Typecheck\s+not run: skipped tsconfig\.json in dry run/);
    const { out } = await write(dir, {}, { reply, deps: { loadTypeScript: () => ts7, resolveTsc: () => tscPath } });
    const after = await read(dir, 'src/ids.ts');
    assert.doesNotMatch(after, /readFileSync/, 'deterministic fix written');
    assert.match(after, /\(item: Item\) =>/, 'the AI change that broke types was not written');
    assert.match(out, /Typecheck\s+ran \(tsconfig\.json\); 1 file\(s\) changed back/);
  });
});
