import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createProjectContext, describeContext } from '../src/context/index.js';
import { copyFixture, fakeInstall, makeTempTree, removeTree, writeTree } from './helpers.js';

const dirs = [];
after(async () => {
  for (const dir of dirs) await removeTree(dir);
});

/** Copy a fixture to a temp dir and return its path; the fixture root acts as the git root. */
async function fixture(name) {
  const dir = await copyFixture(name);
  dirs.push(path.dirname(dir));
  return dir;
}

async function contextFor(root, relDir = '.') {
  return createProjectContext({ stopDir: root }).forDirectory(path.join(root, relDir));
}

describe('fixture: react-classic', () => {
  it('detects the classic runtime from tsconfig "jsx": "react" (a JSONC tsconfig)', async () => {
    const root = await fixture('react-classic');
    const ctx = await contextFor(root, 'src');
    assert.equal(ctx.tsconfig?.error, null);
    assert.equal(ctx.jsxRuntime.runtime, 'classic');
    assert.match(ctx.jsxRuntime.reason, /tsconfig/);
    assert.equal(ctx.reactMajor, 16);
  });
});

describe('fixture: react-automatic (Vite, solution-style tsconfig)', () => {
  it('reads jsx from the referenced tsconfig.app.json', async () => {
    const root = await fixture('react-automatic');
    const ctx = await contextFor(root, 'src');
    assert.deepEqual(ctx.tsconfig?.files, []);
    assert.deepEqual(
      ctx.tsconfigReferences.map((c) => path.basename(c.path)),
      ['tsconfig.app.json', 'tsconfig.node.json'],
    );
    assert.equal(ctx.jsxRuntime.runtime, 'automatic');
    assert.match(ctx.jsxRuntime.reason, /react-jsx/);
  });

  it('flags vite.config.ts as a possible source of unknown aliases', async () => {
    const root = await fixture('react-automatic');
    const ctx = await contextFor(root, 'src');
    assert.deepEqual(ctx.jsConfigFiles, [path.join(root, 'vite.config.ts')]);
    assert.ok(ctx.aliasUncertainty.some((r) => r.includes('vite.config.ts')));
  });

  it('is still automatic from package.json alone (Vite + plugin-react + React 18)', async () => {
    const root = await fixture('react-automatic');
    await writeTree(root, { 'tsconfig.app.json': '{ "include": ["src"] }' });
    const ctx = await contextFor(root, 'src');
    assert.equal(ctx.jsxRuntime.runtime, 'automatic');
    assert.match(ctx.jsxRuntime.reason, /Vite/);
  });

  it('reports TypeScript availability only when it is installed', async () => {
    const root = await fixture('react-automatic');
    const before = await contextFor(root, 'src');
    assert.equal(before.typescript.tsconfigPath, path.join(root, 'tsconfig.json'));
    assert.equal(before.typescript.installed, false);
    await fakeInstall(root, 'typescript', { version: '5.4.5' });
    const after = await contextFor(root, 'src');
    assert.equal(after.typescript.installed, true);
    assert.equal(after.typescript.version, '5.4.5');
  });
});

describe('fixture: react-native-expo', () => {
  it('reads @/ paths relative to the tsconfig, even when expo/tsconfig.base is not installed', async () => {
    const root = await fixture('react-native-expo');
    const ctx = await contextFor(root);
    assert.deepEqual(ctx.pathAliases, [{ pattern: '@/*', targets: [path.join(root, '*')] }]);
    assert.deepEqual(ctx.tsconfig?.unresolvedExtends, ['expo/tsconfig.base']);
    assert.ok(ctx.aliasUncertainty.some((r) => r.includes('expo/tsconfig.base')));
    assert.ok(ctx.aliasUncertainty.some((r) => r.includes('babel.config.js')));
  });

  it('follows extends into an installed expo package', async () => {
    const root = await fixture('react-native-expo');
    await fakeInstall(root, 'expo', { version: '51.0.28' }, {
      'tsconfig.base.json': JSON.stringify({ compilerOptions: { jsx: 'react-native', moduleSuffixes: ['.ios', '.native', ''] } }),
    });
    const ctx = await contextFor(root, 'components');
    assert.deepEqual(ctx.tsconfig?.unresolvedExtends, []);
    assert.equal(ctx.tsconfig?.compilerOptions.strict, true);
    assert.deepEqual(ctx.moduleSuffixes, ['.ios', '.native', '']);
  });

  it('detects the automatic runtime (Expo + React 18)', async () => {
    const root = await fixture('react-native-expo');
    const ctx = await contextFor(root);
    assert.equal(ctx.jsxRuntime.runtime, 'automatic');
    assert.match(ctx.jsxRuntime.reason, /Expo/);
  });

  it('prefers the installed React version over the declared range', async () => {
    const root = await fixture('react-native-expo');
    await fakeInstall(root, 'react', { version: '16.14.0' });
    const ctx = await contextFor(root);
    assert.equal(ctx.reactMajor, 16);
    assert.equal(ctx.jsxRuntime.runtime, 'classic');
  });
});

describe('fixture: monorepo', () => {
  it('sees hoisted root deps and workspace packages from inside a package', async () => {
    const root = await fixture('monorepo');
    const ctx = await contextFor(root, 'packages/api/src');
    assert.equal(ctx.packages.nearest?.json.name, '@acme/api');
    assert.ok(!('lodash' in (ctx.packages.nearest?.json.dependencies ?? {})), 'the package itself does not list lodash');
    assert.ok(ctx.packages.declared.has('lodash'), 'but the root does');
    assert.deepEqual([...ctx.packages.workspaceNames].sort(), ['@acme/api', '@acme/shared', '@acme/utils']);
    assert.ok(ctx.packages.selfNames.has('@acme/api'));
  });
});

describe('fixture: node-api', () => {
  it('finds the tsconfig and no React', async () => {
    const root = await fixture('node-api');
    const ctx = await contextFor(root, 'src/routes');
    assert.equal(ctx.tsconfig?.path, path.join(root, 'tsconfig.json'));
    assert.equal(ctx.tsconfig?.compilerOptions.moduleResolution, 'NodeNext');
    assert.equal(ctx.reactMajor, null);
    assert.deepEqual(ctx.aliasUncertainty, []);
  });
});

describe('project context boundaries and caching', () => {
  it('does not read package.json files above the stop (git) root', async () => {
    const outer = await makeTempTree({
      'package.json': JSON.stringify({ dependencies: { 'outer-only': '1' } }),
      'repo/package.json': JSON.stringify({ name: 'repo' }),
      'repo/src/a.js': '',
    });
    dirs.push(outer);
    const ctx = await contextFor(path.join(outer, 'repo'), 'src');
    assert.ok(!ctx.packages.declared.has('outer-only'));
  });

  it('returns the same context object for files in the same directory', async () => {
    const root = await fixture('node-api');
    const context = createProjectContext({ stopDir: root });
    const a = await context.forFile(path.join(root, 'src/routes/users.ts'));
    const b = await context.forFile(path.join(root, 'src/routes/other.ts'));
    assert.equal(a, b);
  });

  it('describes itself for --verbose', async () => {
    const root = await fixture('react-native-expo');
    const lines = describeContext(await contextFor(root), root);
    assert.ok(lines.some((l) => l.startsWith('package: package.json')));
    assert.ok(lines.some((l) => l === 'aliases: @/*'));
    assert.ok(lines.some((l) => l.startsWith('JSX runtime: automatic')));
    assert.ok(lines.some((l) => l.startsWith('aliases may be incomplete')));
  });
});
