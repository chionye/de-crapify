import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { contentSkipReason, discoverFiles, findGitRoot, SKIP_REASONS } from '../src/discover.js';
import { SetupError } from '../src/errors.js';
import { gitInit, hasGit, makeTempTree, removeTree, writeTree } from './helpers.js';

const BIG = 200 * 1024;
const dirs = [];
after(async () => {
  for (const dir of dirs) await removeTree(dir);
});

async function tree(files) {
  const dir = await makeTempTree(files);
  dirs.push(dir);
  return dir;
}

/** Discover and return file paths relative to the root, with forward slashes. */
async function discoverRel(root, options = {}) {
  const result = await discoverFiles(root, { maxFileSizeBytes: BIG, ...options });
  return {
    ...result,
    rel: result.files.map((f) => path.relative(root, f).split(path.sep).join('/')),
    skippedRel: result.skipped.map((s) => ({ file: path.relative(root, s.file).split(path.sep).join('/'), reason: s.reason })),
  };
}

/** The layout shared by the git and non-git walks: everything that must be included or excluded. */
const LAYOUT = {
  'src/a.js': 'a',
  'src/b.tsx': 'b',
  'src/c.mts': 'c',
  'src/types.d.ts': 'declare const x: number;',
  'src/styles.css': 'body {}',
  'src/vendor.min.js': 'x',
  'src/nested/deep/d.ts': 'd',
  'src/build/gen.js': 'skip: build dir',
  'node_modules/pkg/index.js': 'skip',
  'dist/out.js': 'skip',
  'out/x.js': 'skip',
  'coverage/c.js': 'skip',
  '.next/x.js': 'skip',
  '.expo/x.js': 'skip',
  '.hidden/h.js': 'skip',
  'src/.eslintrc.js': 'skip: dotfile',
  'ignored-dir/x.js': 'skip: gitignored',
  'src/secret.js': 'skip: gitignored',
  'src/sub/local-ignored.js': 'skip: nested gitignore',
  'src/sub/kept.js': 'k',
  '.gitignore': 'ignored-dir/\nsecret.js\n',
  'src/sub/.gitignore': 'local-ignored.js\n',
};

const EXPECTED = ['src/a.js', 'src/b.tsx', 'src/c.mts', 'src/nested/deep/d.ts', 'src/sub/kept.js'];

describe('discoverFiles without git (ignore package fallback)', () => {
  it('walks recursively and applies all skip rules, including nested .gitignore files', async () => {
    const root = await tree(LAYOUT);
    const result = await discoverRel(root);
    assert.equal(result.gitRoot, null);
    assert.deepEqual(result.rel, EXPECTED);
    assert.deepEqual(result.skippedRel, [{ file: 'src/vendor.min.js', reason: SKIP_REASONS.MINIFIED }]);
  });

  it('applies the nearest .gitignore above the target directory', async () => {
    const root = await tree({ '.gitignore': 'generated/\n', 'app/src/a.js': 'a', 'app/generated/g.js': 'g' });
    const result = await discoverRel(path.join(root, 'app'));
    assert.deepEqual(result.rel, ['src/a.js']);
  });
});

describe('discoverFiles inside a git repo', { skip: !hasGit && 'git not installed' }, () => {
  it('uses git ls-files and gives the same result as the fallback', async () => {
    const root = await tree(LAYOUT);
    gitInit(root);
    const result = await discoverRel(root);
    assert.equal(result.gitRoot, root);
    assert.deepEqual(result.rel, EXPECTED);
  });

  it('respects .git/info/exclude, which only git knows about', async () => {
    const root = await tree({ 'a.js': 'a', 'local.js': 'l' });
    gitInit(root);
    await fs.appendFile(path.join(root, '.git', 'info', 'exclude'), '\nlocal.js\n');
    assert.deepEqual((await discoverRel(root)).rel, ['a.js']);
  });

  it('only lists files under a target subdirectory', async () => {
    const root = await tree({ 'a.js': 'a', 'pkg/b.js': 'b', 'pkg/lib/c.js': 'c' });
    gitInit(root);
    const result = await discoverRel(path.join(root, 'pkg'));
    assert.equal(result.gitRoot, root);
    assert.deepEqual(result.rel, ['b.js', 'lib/c.js']);
  });

  it('falls back to walking when git ls-files fails', async () => {
    const root = await tree({ 'a.js': 'a', '.gitignore': 'b.js\n', 'b.js': 'b' });
    gitInit(root);
    const result = await discoverRel(root, { listGitFiles: async () => null });
    assert.deepEqual(result.rel, ['a.js']);
  });
});

describe('dot paths', () => {
  it('allows the target itself to start with a dot', async () => {
    const root = await tree({ '.config/tool/a.js': 'a', '.config/tool/.private/b.js': 'b' });
    const result = await discoverRel(path.join(root, '.config'));
    assert.deepEqual(result.rel, ['tool/a.js']);
  });
});

describe('React Native native folders', () => {
  it('skips android/ and ios/ next to a package.json that uses react-native or expo', async () => {
    const root = await tree({
      'package.json': JSON.stringify({ dependencies: { 'react-native': '0.74.0' } }),
      'App.tsx': 'a',
      'android/app/src/Main.js': 'skip',
      'ios/Pods/x.js': 'skip',
    });
    assert.deepEqual((await discoverRel(root)).rel, ['App.tsx']);
  });

  it('detects Expo projects too', async () => {
    const root = await tree({
      'package.json': JSON.stringify({ dependencies: { expo: '~51.0.0' } }),
      'App.tsx': 'a',
      'ios/x.js': 'skip',
    });
    assert.deepEqual((await discoverRel(root)).rel, ['App.tsx']);
  });

  it('keeps android/ and ios/ folders elsewhere', async () => {
    const root = await tree({
      'package.json': JSON.stringify({ dependencies: { react: '18.0.0' } }),
      'src/platforms/ios/setup.js': 'keep',
      'src/platforms/android/setup.js': 'keep',
    });
    assert.deepEqual((await discoverRel(root)).rel, ['src/platforms/android/setup.js', 'src/platforms/ios/setup.js']);
  });
});

describe('single file targets', () => {
  it('processes a supported file', async () => {
    const root = await tree({ 'a.ts': 'a' });
    const result = await discoverFiles(path.join(root, 'a.ts'), { maxFileSizeBytes: BIG });
    assert.equal(result.isDirectory, false);
    assert.deepEqual(result.files, [path.join(root, 'a.ts')]);
  });

  it('processes an explicitly named file even inside a skipped or dot folder', async () => {
    const root = await tree({ 'dist/a.js': 'a' });
    const result = await discoverFiles(path.join(root, 'dist/a.js'), { maxFileSizeBytes: BIG });
    assert.equal(result.files.length, 1);
  });

  it('reports an unsupported file as skipped', async () => {
    const root = await tree({ 'a.css': 'x', 'b.d.ts': 'x' });
    for (const name of ['a.css', 'b.d.ts']) {
      const result = await discoverFiles(path.join(root, name), { maxFileSizeBytes: BIG });
      assert.deepEqual(result.files, []);
      assert.equal(result.skipped[0].reason, SKIP_REASONS.UNSUPPORTED);
    }
  });

  it('throws SetupError for a missing path', async () => {
    await assert.rejects(discoverFiles('/definitely/not/here', { maxFileSizeBytes: BIG }), SetupError);
  });
});

describe('size and symlinks', () => {
  it('skips files over the size limit', async () => {
    const root = await tree({ 'small.js': 'x', 'large.js': 'x'.repeat(2048) });
    const result = await discoverRel(root, { maxFileSizeBytes: 1024 });
    assert.deepEqual(result.rel, ['small.js']);
    assert.deepEqual(result.skippedRel, [{ file: 'large.js', reason: SKIP_REASONS.TOO_LARGE }]);
  });

  it('skips symlinked files (writing through them could touch files outside the target)', async () => {
    const outside = await tree({ 'real.js': 'r' });
    const root = await tree({ 'a.js': 'a' });
    await fs.symlink(path.join(outside, 'real.js'), path.join(root, 'link.js'));
    const result = await discoverRel(root);
    assert.deepEqual(result.rel, ['a.js']);
    assert.deepEqual(result.skippedRel, [{ file: 'link.js', reason: SKIP_REASONS.SYMLINK }]);
  });
});

describe('contentSkipReason', () => {
  it('skips files with the ignore-file marker', () => {
    assert.equal(contentSkipReason('// de-crapify-ignore-file\nconst a = 1;'), SKIP_REASONS.IGNORED);
    assert.equal(contentSkipReason('/* de-crapify-ignore-file */\nconst a = 1;'), SKIP_REASONS.IGNORED);
  });

  it('skips generated files when the marker is in a comment', () => {
    assert.equal(contentSkipReason('// @generated by protoc\nexport {}'), SKIP_REASONS.GENERATED);
    assert.equal(contentSkipReason('/**\n * This file is @generated. Do not edit.\n */\nexport {}'), SKIP_REASONS.GENERATED);
  });

  it('does not treat @generated inside code as a marker', () => {
    assert.equal(contentSkipReason("const label = 'files marked @generated are skipped';"), null);
  });

  it('skips minified files (a line over 1000 characters)', () => {
    assert.equal(contentSkipReason('a\n' + 'x'.repeat(1001) + '\nb'), SKIP_REASONS.MINIFIED);
    assert.equal(contentSkipReason('x'.repeat(1000)), null);
  });

  it('accepts normal files', () => {
    assert.equal(contentSkipReason('const a = 1;\nexport default a;\n'), null);
    assert.equal(contentSkipReason(''), null);
  });
});

describe('findGitRoot', () => {
  it('returns null outside a repo', async () => {
    const root = await tree({ 'a/b/c.js': 'c' });
    assert.equal(await findGitRoot(path.join(root, 'a/b')), null);
  });

  it('finds .git as a file (worktrees, submodules)', async () => {
    const root = await tree({ '.git': 'gitdir: /elsewhere\n', 'a/b.js': 'b' });
    assert.equal(await findGitRoot(path.join(root, 'a')), root);
  });

  it('finds the nearest repo when walking up', { skip: !hasGit && 'git not installed' }, async () => {
    const root = await tree({});
    gitInit(root);
    await writeTree(root, { 'x/y/z.js': 'z' });
    assert.equal(await findGitRoot(path.join(root, 'x/y')), root);
  });
});
