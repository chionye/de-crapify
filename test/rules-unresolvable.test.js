import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createProjectContext } from '../src/context/index.js';
import { createFileCache } from '../src/context/files.js';
import { packageNameOf, resolveFile, stripLoaderAndQuery, typesPackageFor } from '../src/resolve.js';
import { matchPathPattern, unresolvableImportsRule } from '../src/rules/unresolvable-imports.js';
import { fakeInstall, makeTempTree, parseSnippet, removeTree } from './helpers.js';

const dirs = [];
after(async () => {
  for (const dir of dirs) await removeTree(dir);
});
async function tree(files) {
  const dir = await makeTempTree(files);
  dirs.push(dir);
  return dir;
}
const json = (v) => JSON.stringify(v);

/**
 * Run the rule on `source` as if it lived at `<root>/<rel>`. Returns reports keyed by specifier.
 */
async function check(root, rel, source) {
  const filePath = path.join(root, rel);
  const ast = await parseSnippet(source, filePath);
  const context = createProjectContext({ stopDir: root });
  const ctx = await context.forFile(filePath);
  const { reports } = await unresolvableImportsRule({ ast, filePath, ctx, files: context.files });
  return Object.fromEntries(reports.map((r) => [r.message.match(/^'([^']+)'/)?.[1], r]));
}

describe('resolve helpers', () => {
  it('stripLoaderAndQuery', () => {
    assert.equal(stripLoaderAndQuery('./icon.svg?react'), './icon.svg');
    assert.equal(stripLoaderAndQuery('raw-loader!./file.txt'), './file.txt');
    assert.equal(stripLoaderAndQuery('style-loader!css-loader!./a.css?inline'), './a.css');
  });

  it('packageNameOf and typesPackageFor', () => {
    assert.equal(packageNameOf('lodash/groupBy'), 'lodash');
    assert.equal(packageNameOf('@scope/pkg/deep/x'), '@scope/pkg');
    assert.equal(typesPackageFor('lodash'), '@types/lodash');
    assert.equal(typesPackageFor('@babel/core'), '@types/babel__core');
  });

  it('matchPathPattern', () => {
    assert.equal(matchPathPattern('@/*', '@/components/X'), 'components/X');
    assert.equal(matchPathPattern('shared', 'shared'), '');
    assert.equal(matchPathPattern('shared', 'shared/x'), null);
    assert.equal(matchPathPattern('*.svg', 'logo.svg'), 'logo');
    assert.equal(matchPathPattern('@/*', '~/x'), null);
  });

  it('resolveFile tries extensions, platform variants, .js→.ts, index files and package.json main', async () => {
    const root = await tree({
      'a.ts': '',
      'Button.ios.tsx': '',
      'esm.ts': '',
      'mod.mts': '',
      'dir/index.native.js': '',
      'types.d.ts': '',
      'x.config.ts': '',
      'lib/package.json': json({ main: './dist/main.js' }),
      'lib/dist/main.js': '',
      'Card.custom.tsx': '',
    });
    const files = createFileCache();
    const r = (p, moduleSuffixes) => resolveFile(path.join(root, p), { files, moduleSuffixes });
    assert.equal(await r('a'), path.join(root, 'a.ts'));
    assert.equal(await r('Button'), path.join(root, 'Button.ios.tsx'));
    assert.equal(await r('esm.js'), path.join(root, 'esm.ts'));
    assert.equal(await r('mod.mjs'), path.join(root, 'mod.mts'));
    assert.equal(await r('dir'), path.join(root, 'dir/index.native.js'));
    assert.equal(await r('types'), path.join(root, 'types.d.ts'));
    assert.equal(await r('x.config'), path.join(root, 'x.config.ts'));
    assert.equal(await r('lib'), path.join(root, 'lib/dist/main.js'));
    assert.equal(await r('Card'), null);
    assert.equal(await r('Card', ['.custom', '']), path.join(root, 'Card.custom.tsx'));
    assert.equal(await r('missing'), null);
  });

  it('resolveFile only accepts the exact file (or RN variants) for assets', async () => {
    const root = await tree({ 'logo@2x.png': '', 'icon.ios.png': '', 'styles.css': '', 'data.json.ts': '' });
    const files = createFileCache();
    const r = (p) => resolveFile(path.join(root, p), { files });
    assert.equal(await r('logo.png'), path.join(root, 'logo@2x.png'));
    assert.equal(await r('icon.png'), path.join(root, 'icon.ios.png'));
    assert.equal(await r('styles.css'), path.join(root, 'styles.css'));
    assert.equal(await r('data.json'), null, 'no extension guessing for assets');
    assert.equal(await r('missing.svg'), null);
  });
});

describe('unresolvable imports: likely hallucinated', () => {
  it('a package that is not installed or declared', async () => {
    const root = await tree({ 'package.json': json({ dependencies: { react: '18' } }) });
    const reports = await check(root, 'src/a.ts', "import x from 'react-super-forms';\nimport y from '@fake/pkg/sub';\n");
    assert.equal(reports['react-super-forms'].type, 'hallucinatedImport');
    assert.match(reports['react-super-forms'].message, /not installed/);
    assert.equal(reports['react-super-forms'].line, 1);
    assert.equal(reports['@fake/pkg/sub'].type, 'hallucinatedImport');
  });

  it('a relative import whose file does not exist', async () => {
    const root = await tree({ 'package.json': '{}', 'src/real.ts': '' });
    const reports = await check(root, 'src/a.ts', "import a from './real';\nimport b from './missing';\nimport c from '../nope/x.js';\n");
    assert.deepEqual(Object.keys(reports).sort(), ['../nope/x.js', './missing']);
    assert.ok(Object.values(reports).every((r) => r.type === 'hallucinatedImport'));
  });

  it('a node: import that is not a built-in', async () => {
    const root = await tree({ 'package.json': '{}' });
    const reports = await check(root, 'a.js', "import x from 'node:fake';\n");
    assert.equal(reports['node:fake'].type, 'hallucinatedImport');
  });

  it('require(), import(), re-exports and import-equals are checked too', async () => {
    const root = await tree({ 'package.json': '{}' });
    const source = "const a = require('nope-a');\nconst b = await import('nope-b');\nexport * from 'nope-c';\nexport { x } from 'nope-d';\n";
    const reports = await check(root, 'a.mjs', source);
    assert.deepEqual(Object.keys(reports).sort(), ['nope-a', 'nope-b', 'nope-c', 'nope-d']);
    const reportsTs = await check(root, 'a.ts', "import fs = require('nope-e');\n");
    assert.ok(reportsTs['nope-e']);
  });

  it('an alias that matches a tsconfig path but has no file, when no other config could define it', async () => {
    const root = await tree({ 'package.json': '{}', 'tsconfig.json': json({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }) });
    const reports = await check(root, 'src/a.ts', "import x from '@/components/Missing';\n");
    assert.equal(reports['@/components/Missing'].type, 'hallucinatedImport');
    assert.match(reports['@/components/Missing'].message, /matches the alias '@\/\*'/);
  });

  it('a # import not defined in package.json imports', async () => {
    const root = await tree({ 'package.json': json({ imports: { '#db': './db.js' } }) });
    const reports = await check(root, 'a.js', "import a from '#db';\nimport b from '#nope';\n");
    assert.deepEqual(Object.keys(reports), ['#nope']);
    assert.equal(reports['#nope'].type, 'hallucinatedImport');
  });

  it('reports each specifier once per file', async () => {
    const root = await tree({ 'package.json': '{}' });
    const reports = await check(root, 'a.js', "import a from 'nope';\nconst b = require('nope');\n");
    assert.equal(Object.keys(reports).length, 1);
  });
});

describe('unresolvable imports: could not verify', () => {
  it('alias-like imports when a JS config might define aliases', async () => {
    const root = await tree({ 'package.json': '{}', 'vite.config.ts': 'export default {}' });
    const reports = await check(root, 'src/a.ts', "import a from '@/x';\nimport b from '~/y';\nimport c from '#z';\nimport d from '@app/thing';\n");
    for (const spec of ['@/x', '~/y', '#z', '@app/thing']) {
      assert.equal(reports[spec]?.type, 'unverifiedImport', spec);
      assert.match(reports[spec].message, /vite\.config\.ts/);
    }
  });

  it('...but a plain package name is still hallucinated even with a JS config', async () => {
    const root = await tree({ 'package.json': '{}', 'vite.config.ts': '' });
    const reports = await check(root, 'src/a.ts', "import a from 'react-super-forms';\n");
    assert.equal(reports['react-super-forms'].type, 'hallucinatedImport');
  });

  it('alias-like imports when tsconfig extends something that cannot be found', async () => {
    const root = await tree({ 'package.json': '{}', 'tsconfig.json': json({ extends: '@company/tsconfig' }) });
    const reports = await check(root, 'a.ts', "import a from '@/x';\n");
    assert.equal(reports['@/x'].type, 'unverifiedImport');
  });

  it('require()/import() of a missing package inside try (optional dependency)', async () => {
    const root = await tree({ 'package.json': '{}' });
    const source = "let fsevents;\ntry { fsevents = require('fsevents'); } catch {}\nasync function f() { try { return await import('optional-x'); } catch { return null; } }\n";
    const reports = await check(root, 'a.js', source);
    assert.equal(reports.fsevents.type, 'unverifiedImport');
    assert.equal(reports['optional-x'].type, 'unverifiedImport');
    assert.match(reports.fsevents.message, /optional/);
  });

  it('root-relative paths that do not exist', async () => {
    const root = await tree({ 'package.json': '{}' });
    const reports = await check(root, 'a.js', "import x from '/src/main.js';\n");
    assert.equal(reports['/src/main.js'].type, 'unverifiedImport');
  });
});

describe('unresolvable imports: never flagged', () => {
  it('Node built-ins with or without node:, including subpaths', async () => {
    const root = await tree({ 'package.json': '{}' });
    const reports = await check(root, 'a.js', "import fs from 'fs';\nimport p from 'fs/promises';\nimport t from 'node:test';\nimport u from 'node:util';\nimport c from 'child_process';\n");
    assert.deepEqual(reports, {});
  });

  it('virtual and scheme specifiers, and query/loader suffixes', async () => {
    const root = await tree({ 'package.json': '{}', 'icon.svg': '', 'file.txt': '' });
    const source = "import a from 'virtual:pwa-register';\nimport b from 'astro:content';\nimport c from 'bun:test';\nimport d from './icon.svg?react';\nimport e from 'raw-loader!./file.txt';\n";
    assert.deepEqual(await check(root, 'a.js', source), {});
  });

  it('packages declared in any dependency field, or in a parent package.json (monorepo hoisting)', async () => {
    const root = await tree({
      'package.json': json({ dependencies: { lodash: '4' }, devDependencies: { vitest: '1' } }),
      'packages/app/package.json': json({ peerDependencies: { react: '18' }, optionalDependencies: { fsevents: '2' } }),
    });
    const source = "import g from 'lodash/groupBy';\nimport v from 'vitest';\nimport r from 'react';\nimport f from 'fsevents';\n";
    assert.deepEqual(await check(root, 'packages/app/src/a.js', source), {});
  });

  it('workspace packages and the package itself', async () => {
    const root = await tree({
      'package.json': json({ workspaces: ['packages/*'] }),
      'packages/ui/package.json': json({ name: '@acme/ui' }),
      'packages/app/package.json': json({ name: '@acme/app' }),
    });
    assert.deepEqual(await check(root, 'packages/app/src/a.js', "import ui from '@acme/ui';\nimport self from '@acme/app/x';\n"), {});
  });

  it('packages installed in node_modules even if not declared', async () => {
    const root = await tree({ 'package.json': '{}' });
    await fakeInstall(root, 'transitive-dep');
    await fakeInstall(root, '@scope/thing');
    assert.deepEqual(await check(root, 'src/a.js', "import a from 'transitive-dep';\nimport b from '@scope/thing';\n"), {});
  });

  it('type-only imports satisfied by @types', async () => {
    const root = await tree({ 'package.json': json({ devDependencies: { '@types/express-serve-static-core': '4' } }) });
    const source = "import type { Request } from 'express-serve-static-core';\n";
    assert.deepEqual(await check(root, 'a.ts', source), {});
    const valueImport = "import { Request } from 'express-serve-static-core';\n";
    assert.ok((await check(root, 'a.ts', valueImport))['express-serve-static-core'], 'a value import needs the real package');
  });

  it('tsconfig paths and baseUrl, and Babel module-resolver aliases and roots', async () => {
    const root = await tree({
      'package.json': '{}',
      'tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'], 'config': ['src/config/index.ts'] } } }),
      '.babelrc': json({ plugins: [['module-resolver', { root: ['./app'], alias: { '~lib': './lib', underscore: 'lodash' } }]] }),
      'src/components/Button.tsx': '',
      'src/config/index.ts': '',
      'src/utils/date.ts': '',
      'app/screens/Home.js': '',
      'lib/http.js': '',
    });
    await fakeInstall(root, 'lodash');
    const source = [
      "import a from '@/components/Button';",
      "import b from 'config';",
      "import c from 'src/utils/date';",
      "import d from 'screens/Home';",
      "import e from '~lib/http';",
      "import f from 'underscore';",
      '',
    ].join('\n');
    assert.deepEqual(await check(root, 'src/a.ts', source), {});
  });

  it('a catch-all `*` path alias still falls back to packages', async () => {
    const root = await tree({ 'package.json': json({ dependencies: { react: '18' } }), 'tsconfig.json': json({ compilerOptions: { paths: { '*': ['./types/*'] } } }) });
    assert.deepEqual(await check(root, 'a.ts', "import r from 'react';\n"), {});
  });

  it('React Native: platform files and image assets with density variants', async () => {
    const root = await tree({ 'package.json': '{}', 'Button.android.tsx': '', 'Button.ios.tsx': '', 'assets/logo@3x.png': '' });
    const source = "import { B } from './Button';\nconst logo = require('./assets/logo.png');\n";
    assert.deepEqual(await check(root, 'App.tsx', source), {});
  });

  it('TS ESM imports with .js pointing at .ts files', async () => {
    const root = await tree({ 'package.json': '{}', 'src/lib/db.ts': '', 'src/util.mts': '' });
    assert.deepEqual(await check(root, 'src/a.ts', "import { db } from './lib/db.js';\nimport u from './util.mjs';\n"), {});
  });

  it('dynamic expressions (non-literal require/import)', async () => {
    const root = await tree({ 'package.json': '{}' });
    assert.deepEqual(await check(root, 'a.js', 'const m = require(name);\nconst n = import(`./${x}.js`);\n'), {});
  });

  it('a locally defined require function', async () => {
    const root = await tree({ 'package.json': '{}' });
    assert.deepEqual(await check(root, 'a.js', "function require(x) { return x; }\nrequire('whatever');\n"), {});
  });
});
