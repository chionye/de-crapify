import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { findJsConfigFiles, loadBabelAliases } from '../src/context/aliases.js';
import { ancestorDirs, createFileCache, parseJsonc } from '../src/context/files.js';
import { detectProjectJsxRuntime, jsxRuntimePragma, resolveJsxRuntime } from '../src/context/jsx-runtime.js';
import {
  createInstalledCheck,
  expandWorkspacePatterns,
  loadPackages,
  matchesSubpathImport,
  minMajorVersion,
  parsePnpmWorkspaceYaml,
} from '../src/context/packages.js';
import { findNearestConfig, loadTsconfig } from '../src/context/tsconfig.js';
import { fakeInstall, makeTempTree, removeTree } from './helpers.js';

const dirs = [];
after(async () => {
  for (const dir of dirs) await removeTree(dir);
});
async function tree(files) {
  const dir = await makeTempTree(files);
  dirs.push(dir);
  return dir;
}
const json = (value) => JSON.stringify(value, null, 2);

describe('parseJsonc', () => {
  it('handles comments and trailing commas', () => {
    const text = `{
      // line comment
      "a": 1, /* block */
      "b": [1, 2, 3,],
      "c": { "d": true, },
    }`;
    assert.deepEqual(parseJsonc(text), { a: 1, b: [1, 2, 3], c: { d: true } });
  });

  it('leaves comment-like and comma-like text inside strings alone', () => {
    const text = '{ "url": "http://x/*not*/", "s": "a,}", "q": "say \\"hi\\" // ok", }';
    assert.deepEqual(parseJsonc(text), { url: 'http://x/*not*/', s: 'a,}', q: 'say "hi" // ok' });
  });

  it('throws on invalid JSON', () => {
    assert.throws(() => parseJsonc('{ a: 1 }'));
  });
});

describe('ancestorDirs', () => {
  it('stops at the stop dir', () => {
    assert.deepEqual(ancestorDirs('/a/b/c', '/a'), ['/a/b/c', '/a/b', '/a']);
  });

  it('walks to the root without a stop dir, or when outside it', () => {
    assert.deepEqual(ancestorDirs('/a/b', null), ['/a/b', '/a', '/']);
    assert.deepEqual(ancestorDirs('/x/y', '/a'), ['/x/y', '/x', '/']);
  });
});

describe('minMajorVersion', () => {
  const cases = {
    '^16.14.0': 16,
    '~17.0.2': 17,
    '18.2.0': 18,
    '>=16.8.0': 16,
    '>= 17': 17,
    '16.x': 16,
    '18': 18,
    'v18.1.0': 18,
    '^16.8.0 || ^17.0.0': 16,
    'npm:@preact/compat@18.3.1': 18,
    '18.3.0-canary-abc': 18,
    '*': null,
    latest: null,
    'workspace:*': null,
    '<17': null,
    'github:facebook/react': null,
    '': null,
  };
  for (const [range, expected] of Object.entries(cases)) {
    it(`${JSON.stringify(range)} → ${expected}`, () => assert.equal(minMajorVersion(range), expected));
  }
  it('handles undefined', () => assert.equal(minMajorVersion(undefined), null));
});

describe('pnpm-workspace.yaml', () => {
  it('reads the packages list (quotes, comments, negations)', () => {
    const yaml = `packages:\n  - 'packages/*'\n  - "apps/**" # all apps\n  - tools/cli\n  - '!**/test/**'\ncatalog:\n  react: ^18\n`;
    assert.deepEqual(parsePnpmWorkspaceYaml(yaml), ['packages/*', 'apps/**', 'tools/cli', '!**/test/**']);
  });
});

describe('expandWorkspacePatterns', () => {
  it('expands *, **, exact paths and negations to dirs with a package.json', async () => {
    const root = await tree({
      'packages/a/package.json': '{}',
      'packages/b/package.json': '{}',
      'packages/not-a-package/README.md': '',
      'apps/web/package.json': '{}',
      'apps/group/mobile/package.json': '{}',
      'apps/group/mobile/test/fixture/package.json': '{}',
      'apps/node_modules/x/package.json': '{}',
      'tools/cli/package.json': '{}',
    });
    const found = await expandWorkspacePatterns(root, ['packages/*', 'apps/**', './tools/cli/', '!**/test/**', 'missing/*']);
    assert.deepEqual(
      found.map((d) => path.relative(root, d)),
      ['apps/group/mobile', 'apps/web', 'packages/a', 'packages/b', 'tools/cli'],
    );
  });
});

describe('matchesSubpathImport', () => {
  it('matches exact keys and * patterns', () => {
    const keys = ['#config', '#internal/*', '#utils/*.js'];
    assert.ok(matchesSubpathImport('#config', keys));
    assert.ok(matchesSubpathImport('#internal/db/client', keys));
    assert.ok(matchesSubpathImport('#utils/strings.js', keys));
    assert.ok(!matchesSubpathImport('#utils/strings.ts', keys));
    assert.ok(!matchesSubpathImport('#other', keys));
  });
});

describe('loadPackages', () => {
  it('collects all dependency fields from every package.json up to the stop dir', async () => {
    const root = await tree({
      'package.json': json({ name: 'outside', dependencies: { 'outside-dep': '1' } }),
      'repo/package.json': json({
        name: 'repo-root',
        dependencies: { lodash: '^4', react: '^17.0.0' },
        devDependencies: { vitest: '1' },
        peerDependencies: { 'peer-dep': '1' },
        optionalDependencies: { fsevents: '2' },
      }),
      'repo/app/package.json': json({ name: 'app', dependencies: { react: '^18.2.0' }, imports: { '#db': './db.js', '#lib/*': './lib/*.js' } }),
    });
    const files = createFileCache();
    const info = await loadPackages(path.join(root, 'repo/app/src'), path.join(root, 'repo'), files);
    assert.equal(info.nearest?.path, path.join(root, 'repo/app/package.json'));
    assert.equal(info.chain.length, 2);
    for (const dep of ['lodash', 'vitest', 'peer-dep', 'fsevents', 'react']) assert.ok(info.declared.has(dep), dep);
    assert.equal(info.declared.get('react'), '^18.2.0', 'the closest package.json wins');
    assert.ok(!info.declared.has('outside-dep'), 'nothing above the stop dir is read');
    assert.deepEqual([...info.selfNames].sort(), ['app', 'repo-root']);
    assert.deepEqual(info.subpathImports, ['#db', '#lib/*']);
  });

  it('finds npm/yarn workspace package names (array and object forms)', async () => {
    for (const workspaces of [['packages/*'], { packages: ['packages/*'] }]) {
      const root = await tree({
        'package.json': json({ name: 'mono', workspaces }),
        'packages/ui/package.json': json({ name: '@mono/ui' }),
        'packages/core/package.json': json({ name: '@mono/core' }),
        'packages/core/src/index.js': '',
      });
      const info = await loadPackages(path.join(root, 'packages/core/src'), root, createFileCache());
      assert.deepEqual([...info.workspaceNames].sort(), ['@mono/core', '@mono/ui']);
    }
  });

  it('finds pnpm workspace package names', async () => {
    const root = await tree({
      'package.json': json({ name: 'mono' }),
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
      'apps/web/package.json': json({ name: 'web' }),
    });
    const info = await loadPackages(path.join(root, 'apps/web'), root, createFileCache());
    assert.deepEqual([...info.workspaceNames], ['web']);
  });

  it('ignores unparseable package.json files', async () => {
    const root = await tree({ 'package.json': '{ broken', 'a/package.json': json({ name: 'a' }) });
    const info = await loadPackages(path.join(root, 'a'), root, createFileCache());
    assert.deepEqual([...info.selfNames], ['a']);
  });
});

describe('installed check', () => {
  it('finds packages in node_modules here or in any parent, including scoped ones', async () => {
    const root = await tree({ 'app/src/x.js': '' });
    await fakeInstall(root, 'lodash', { version: '4.17.21' });
    await fakeInstall(path.join(root, 'app'), '@scope/pkg');
    const check = createInstalledCheck(createFileCache());
    const from = path.join(root, 'app/src');
    assert.ok(await check.isInstalled('lodash', from));
    assert.ok(await check.isInstalled('@scope/pkg', from));
    assert.ok(!(await check.isInstalled('missing', from)));
    assert.equal((await check.installedPackageJson('lodash', from))?.version, '4.17.21');
  });
});

describe('tsconfig loading', () => {
  it('prefers tsconfig.json over jsconfig.json, and finds the nearest one', async () => {
    const root = await tree({ 'tsconfig.json': '{}', 'jsconfig.json': '{}', 'sub/jsconfig.json': '{}', 'sub/deep/x.js': '' });
    const files = createFileCache();
    assert.deepEqual(await findNearestConfig(root, root, files), { path: path.join(root, 'tsconfig.json'), kind: 'tsconfig' });
    assert.deepEqual(await findNearestConfig(path.join(root, 'sub/deep'), root, files), {
      path: path.join(root, 'sub/jsconfig.json'),
      kind: 'jsconfig',
    });
    assert.deepEqual(await findNearestConfig(path.join(root, 'sub/deep'), root, files, { tsconfigOnly: true }), {
      path: path.join(root, 'tsconfig.json'),
      kind: 'tsconfig',
    });
  });

  it('follows relative extends (with and without .json) and merges compilerOptions', async () => {
    const root = await tree({
      'configs/base.json': json({ compilerOptions: { strict: true, jsx: 'react', target: 'es2017' } }),
      'configs/mid.json': json({ extends: './base', compilerOptions: { target: 'es2020' } }),
      'tsconfig.json': json({ extends: './configs/mid.json', compilerOptions: { jsx: 'react-jsx' } }),
    });
    const info = await loadTsconfig(path.join(root, 'tsconfig.json'), 'tsconfig', createFileCache());
    assert.equal(info.compilerOptions.strict, true);
    assert.equal(info.compilerOptions.target, 'es2020');
    assert.equal(info.jsx, 'react-jsx');
    assert.deepEqual(info.unresolvedExtends, []);
  });

  it('applies extends arrays in order (later wins)', async () => {
    const root = await tree({
      'a.json': json({ compilerOptions: { jsx: 'react', target: 'es5' } }),
      'b.json': json({ compilerOptions: { jsx: 'react-jsx' } }),
      'tsconfig.json': json({ extends: ['./a.json', './b.json'] }),
    });
    const info = await loadTsconfig(path.join(root, 'tsconfig.json'), 'tsconfig', createFileCache());
    assert.equal(info.jsx, 'react-jsx');
    assert.equal(info.compilerOptions.target, 'es5');
  });

  it('follows extends into node_modules packages (e.g. expo/tsconfig.base)', async () => {
    const root = await tree({ 'tsconfig.json': json({ extends: 'expo/tsconfig.base', compilerOptions: { strict: true } }) });
    await fakeInstall(root, 'expo', {}, { 'tsconfig.base.json': json({ compilerOptions: { jsx: 'react-native', moduleSuffixes: ['.ios', ''] } }) });
    await fakeInstall(root, '@tsconfig/node20', {}, { 'tsconfig.json': json({ compilerOptions: { target: 'es2023' } }) });
    const files = createFileCache();
    const info = await loadTsconfig(path.join(root, 'tsconfig.json'), 'tsconfig', files);
    assert.deepEqual(info.unresolvedExtends, []);
    assert.equal(info.jsx, 'react-native');
    assert.deepEqual(info.moduleSuffixes, ['.ios', '']);

    const root2 = await tree({ 'tsconfig.json': json({ extends: '@tsconfig/node20' }) });
    await fakeInstall(root2, '@tsconfig/node20', {}, { 'tsconfig.json': json({ compilerOptions: { target: 'es2023' } }) });
    const info2 = await loadTsconfig(path.join(root2, 'tsconfig.json'), 'tsconfig', createFileCache());
    assert.equal(info2.compilerOptions.target, 'es2023');
  });

  it('records unresolvable extends and continues', async () => {
    const root = await tree({
      'tsconfig.json': json({ extends: ['expo/tsconfig.base', './missing.json'], compilerOptions: { paths: { '@/*': ['./*'] } } }),
    });
    const info = await loadTsconfig(path.join(root, 'tsconfig.json'), 'tsconfig', createFileCache());
    assert.deepEqual(info.unresolvedExtends, ['expo/tsconfig.base', './missing.json']);
    assert.equal(info.paths.length, 1);
    assert.equal(info.error, null);
  });

  it('survives extends cycles', async () => {
    const root = await tree({ 'a.json': json({ extends: './b.json' }), 'b.json': json({ extends: './a.json', compilerOptions: { jsx: 'react' } }) });
    const info = await loadTsconfig(path.join(root, 'a.json'), 'tsconfig', createFileCache());
    assert.equal(info.jsx, 'react');
  });

  it('resolves paths against baseUrl when set', async () => {
    const root = await tree({ 'tsconfig.json': json({ compilerOptions: { baseUrl: './src', paths: { '~/*': ['./*'], 'shared': ['../shared/index.ts'] } } }) });
    const info = await loadTsconfig(path.join(root, 'tsconfig.json'), 'tsconfig', createFileCache());
    assert.equal(info.baseUrl, path.join(root, 'src'));
    assert.deepEqual(info.paths, [
      { pattern: '~/*', targets: [path.join(root, 'src/*')] },
      { pattern: 'shared', targets: [path.join(root, 'shared/index.ts')] },
    ]);
  });

  it('resolves paths against the defining config dir when there is no baseUrl', async () => {
    const root = await tree({
      'configs/base.json': json({ compilerOptions: { paths: { '@lib/*': ['../lib/*'] } } }),
      'app/tsconfig.json': json({ extends: '../configs/base.json' }),
    });
    const info = await loadTsconfig(path.join(root, 'app/tsconfig.json'), 'tsconfig', createFileCache());
    assert.deepEqual(info.paths, [{ pattern: '@lib/*', targets: [path.join(root, 'lib/*')] }]);
  });

  it('uses an inherited baseUrl for paths defined in the child', async () => {
    const root = await tree({
      'base.json': json({ compilerOptions: { baseUrl: './src' } }),
      'tsconfig.json': json({ extends: './base.json', compilerOptions: { paths: { '@/*': ['*'] } } }),
    });
    const info = await loadTsconfig(path.join(root, 'tsconfig.json'), 'tsconfig', createFileCache());
    assert.deepEqual(info.paths[0].targets, [path.join(root, 'src/*')]);
  });

  it('reads files, include and references (references are not inherited)', async () => {
    const root = await tree({
      'base.json': json({ include: ['src'], references: [{ path: './nope' }] }),
      'tsconfig.json': json({ extends: './base.json', files: [], references: [{ path: './tsconfig.app.json' }, { path: './packages/a' }] }),
    });
    const info = await loadTsconfig(path.join(root, 'tsconfig.json'), 'tsconfig', createFileCache());
    assert.deepEqual(info.files, []);
    assert.deepEqual(info.include, ['src']);
    assert.deepEqual(info.references, [{ path: path.join(root, 'tsconfig.app.json') }, { path: path.join(root, 'packages/a') }]);
  });

  it('reports an unparseable config instead of throwing', async () => {
    const root = await tree({ 'tsconfig.json': '{ "compilerOptions": { jsx: react } }' });
    const info = await loadTsconfig(path.join(root, 'tsconfig.json'), 'tsconfig', createFileCache());
    assert.match(info.error ?? '', /cannot parse/);
    assert.deepEqual(info.paths, []);
  });
});

describe('Babel aliases', () => {
  it('reads module-resolver aliases and roots from JSON configs, including env and overrides', async () => {
    const root = await tree({
      '.babelrc': `{
        // comments are allowed here
        "plugins": [
          ["module-resolver", { "root": ["./src"], "alias": { "~": "./src", "@components": ["./src/components"], "underscore": "lodash" } }],
        ],
        "env": { "test": { "plugins": [["babel-plugin-module-resolver", { "alias": { "^@test/(.+)": "./test/\\\\1" } }]] } },
      }`,
      'babel.config.json': json({ overrides: [{ plugins: [['module-resolver', { alias: { '#shared': './shared' } }]] }] }),
    });
    const info = await loadBabelAliases([root], createFileCache());
    assert.deepEqual(info.configs.map((c) => path.basename(c)), ['.babelrc', 'babel.config.json']);
    assert.deepEqual(info.roots, [path.join(root, 'src')]);
    const byPattern = Object.fromEntries(info.aliases.map((a) => [a.pattern, a]));
    assert.deepEqual(byPattern['~'].targets, [path.join(root, 'src')]);
    assert.deepEqual(byPattern['@components'].targets, [path.join(root, 'src/components')]);
    assert.deepEqual(byPattern.underscore.targets, ['lodash'], 'package targets stay package names');
    assert.ok(byPattern['^@test/(.+)'].regex instanceof RegExp);
    assert.deepEqual(byPattern['#shared'].targets, [path.join(root, 'shared')]);
  });

  it('marks unparseable JSON configs as unreadable', async () => {
    const root = await tree({ '.babelrc': '{ plugins: [ "module-resolver" ] }' });
    const info = await loadBabelAliases([root], createFileCache());
    assert.deepEqual(info.unreadable, [path.join(root, '.babelrc')]);
  });

  it('detects JS configs that may define aliases', async () => {
    const root = await tree({ 'babel.config.js': '', 'metro.config.js': '', 'vite.config.mts': '', 'webpack.config.cjs': '', 'other.config.js': '' });
    const found = await findJsConfigFiles([root], createFileCache());
    assert.deepEqual(found.map((f) => path.basename(f)).sort(), ['babel.config.js', 'metro.config.js', 'vite.config.mts', 'webpack.config.cjs']);
  });
});

describe('JSX runtime detection', () => {
  const deps = (...names) => new Map(names.map((n) => [n, '*']));
  const detect = (tsconfigJsx, declared, reactMajor) => detectProjectJsxRuntime({ tsconfigJsx, declared, reactMajor }).runtime;

  it('tsconfig jsx decides first', () => {
    assert.equal(detect('react', deps('next'), 18), 'classic');
    assert.equal(detect('react-jsx', deps(), 16), 'automatic');
    assert.equal(detect('react-jsxdev', deps(), null), 'automatic');
  });

  it('"preserve" and "react-native" decide nothing', () => {
    assert.equal(detect('preserve', deps('next'), 18), 'automatic', 'Next.js sets preserve');
    assert.equal(detect('preserve', deps(), null), 'classic');
    assert.equal(detect('react-native', deps('expo'), 18), 'automatic');
  });

  it('React below 17 is classic even with a framework', () => {
    assert.equal(detect(null, deps('next'), 16), 'classic');
    assert.equal(detect(null, deps('vite', '@vitejs/plugin-react'), 16), 'classic');
  });

  it('Expo, Next.js, and Vite with its React plugin are automatic with React 17+', () => {
    assert.equal(detect(null, deps('expo'), 18), 'automatic');
    assert.equal(detect(null, deps('next'), 17), 'automatic');
    assert.equal(detect(null, deps('vite', '@vitejs/plugin-react'), 18), 'automatic');
    assert.equal(detect(null, deps('vite', '@vitejs/plugin-react-swc'), 18), 'automatic');
  });

  it('falls back to classic when unsure', () => {
    assert.equal(detect(null, deps('vite'), 18), 'classic', 'Vite without the React plugin uses esbuild classic JSX');
    assert.equal(detect(null, deps('expo'), null), 'classic', 'unknown React version');
    assert.equal(detect(null, deps(), 18), 'classic', 'no known framework');
  });

  it('reads the per-file pragma, which overrides the project', () => {
    assert.equal(jsxRuntimePragma('/** @jsxRuntime classic */\nconst a = <div />;'), 'classic');
    assert.equal(jsxRuntimePragma('// @jsxRuntime automatic\n'), 'automatic');
    assert.equal(jsxRuntimePragma('/**\n * @jsxRuntime classic\n * @jsx h\n */'), 'classic');
    assert.equal(jsxRuntimePragma("const s = '@jsxRuntime classic';"), null);
    const project = { runtime: /** @type {const} */ ('automatic'), reason: 'tsconfig' };
    assert.equal(resolveJsxRuntime(project, '/** @jsxRuntime classic */').runtime, 'classic');
    assert.equal(resolveJsxRuntime(project, 'const a = 1;'), project);
  });
});
