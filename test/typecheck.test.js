import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { normalizeOptions } from '../src/options.js';
import { runClean } from '../src/run.js';
import { createRequire } from 'node:module';
import {
  cliConfigs,
  createCliChecker,
  hasCompilerApi,
  loadProjectTypeScript,
  newErrors,
  parseTscOutput,
  resolveProjects,
  resolveProjectTsc,
  typecheckChanges,
} from '../src/typecheck.js';
import { captureIO, makeTempTree, removeTree, writeTree } from './helpers.js';

/**
 * A tiny stand-in for the `typescript` package, implementing just the API de-crapify uses.
 * "Type errors" are:
 *   - `TYPE_ERROR(message)` anywhere in a file;
 *   - `requires(NAME)` when no file in the program contains `export const NAME`;
 *   - `needs-import(./x)` when the file doesn't contain `from './x'` (like a module augmentation).
 */
const FAKE_TYPESCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);
module.exports = {
  version: '0.0.0-fake',
  DiagnosticCategory: { Warning: 0, Error: 1 },
  sys: { readFile: (p) => fs.readFileSync(p, 'utf8') },
  readConfigFile: (p, read) => ({ config: JSON.parse(read(p)) }),
  parseJsonConfigFileContent(config, sys, dir) {
    let fileNames;
    if (config.files) fileNames = config.files.map((f) => path.resolve(dir, f));
    else fileNames = (config.include ?? ['.']).flatMap((inc) => walk(path.resolve(dir, inc)));
    const projectReferences = (config.references ?? []).map((r) => ({ path: path.resolve(dir, r.path) }));
    return { options: config.compilerOptions ?? {}, fileNames, projectReferences, errors: [] };
  },
  resolveProjectReferencePath: (ref) => ref.path,
  flattenDiagnosticMessageText: (m) => (typeof m === 'string' ? m : m.messageText),
  createSourceFile: (fileName, text) => ({ fileName, text }),
  createCompilerHost: () => ({
    getSourceFile: (f) => ({ fileName: f, text: fs.readFileSync(f, 'utf8') }),
    readFile: (f) => fs.readFileSync(f, 'utf8'),
  }),
  createProgram: ({ rootNames, host }) => ({ files: rootNames.map((f) => host.getSourceFile(f, 99)) }),
  getPreEmitDiagnostics(program) {
    const all = program.files.map((f) => f.text).join('\n');
    const diags = [];
    for (const file of program.files) {
      for (const m of file.text.matchAll(/TYPE_ERROR\(([^)]*)\)/g)) diags.push({ file, code: 2322, category: 1, messageText: m[1] });
      for (const m of file.text.matchAll(/requires\((\w+)\)/g)) {
        if (!all.includes('export const ' + m[1])) diags.push({ file, code: 2305, category: 1, messageText: 'no exported member ' + m[1] });
      }
      for (const m of file.text.matchAll(/needs-import\(([^)]+)\)/g)) {
        if (!file.text.includes("from '" + m[1] + "'")) diags.push({ file, code: 2339, category: 1, messageText: 'augmentation from ' + m[1] + ' missing' });
      }
      if (file.text.includes('WARNING_ONLY')) diags.push({ file, code: 6133, category: 0, messageText: 'just a warning' });
    }
    return diags;
  },
};`;

const dirs = [];
after(async () => {
  for (const dir of dirs) await removeTree(dir);
});

/** A temp project with the fake `typescript` installed. */
async function project(files, { withTypeScript = true } = {}) {
  const root = await makeTempTree({ 'package.json': '{}', ...files });
  dirs.push(root);
  if (withTypeScript) {
    await writeTree(root, {
      'node_modules/typescript/package.json': JSON.stringify({ name: 'typescript', version: '0.0.0-fake', main: 'index.js' }),
      'node_modules/typescript/index.js': FAKE_TYPESCRIPT,
    });
  }
  return root;
}

/** A changed-file record for typecheckChanges. */
async function change(root, rel, { stage1, after: afterContent, tsconfig = 'tsconfig.json' }) {
  const file = path.join(root, rel);
  const before = await fs.readFile(file, 'utf8');
  return { file, before, stage1: stage1 ?? afterContent, after: afterContent ?? stage1, tsconfigPath: tsconfig ? path.join(root, tsconfig) : null };
}

describe('loading the project TypeScript', () => {
  it("loads the project's own typescript package", async () => {
    const root = await project({});
    assert.equal(loadProjectTypeScript(root)?.version, '0.0.0-fake');
  });

  it('returns null when the project has none', async () => {
    const root = await project({}, { withTypeScript: false });
    assert.equal(loadProjectTypeScript(root), null);
  });
});

describe('resolveProjects', () => {
  it('checks a normal config itself', async () => {
    const root = await project({ 'tsconfig.json': '{"include":["src"]}', 'src/a.ts': '' });
    const ts = loadProjectTypeScript(root);
    const projects = resolveProjects(ts, path.join(root, 'tsconfig.json'));
    assert.deepEqual(projects.map((p) => path.basename(p.configPath)), ['tsconfig.json']);
    assert.deepEqual(projects[0].parsed.fileNames.map((f) => path.resolve(f)), [path.join(root, 'src/a.ts')]);
  });

  it('checks the references of a solution-style config (files: [])', async () => {
    const root = await project({
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }, { path: './tools' }] }),
      'tsconfig.app.json': '{"include":["src"]}',
      'tools/tsconfig.json': '{"include":["."]}',
      'src/a.ts': '',
      'tools/b.ts': '',
    });
    const projects = resolveProjects(loadProjectTypeScript(root), path.join(root, 'tsconfig.json'));
    assert.deepEqual(projects.map((p) => path.relative(root, p.configPath)), ['tsconfig.app.json', path.join('tools', 'tsconfig.json')]);
  });
});

describe('newErrors', () => {
  it('counts duplicates of existing errors as new', () => {
    const baseline = new Map([['a', 1]]);
    assert.deepEqual(newErrors(baseline, new Map([['a', 2], ['b', 1]])), ['a', 'b']);
    assert.deepEqual(newErrors(baseline, new Map([['a', 1]])), []);
    assert.deepEqual(newErrors(baseline, new Map()), []);
  });
});

describe('typecheckChanges', () => {
  it('reports when there is nothing to check', async () => {
    const root = await project({});
    assert.match(typecheckChanges({ files: [], cwd: root }).status, /no changes/);
    const noConfig = [{ file: path.join(root, 'a.ts'), before: 'a', stage1: 'b', after: 'b', tsconfigPath: null }];
    assert.match(typecheckChanges({ files: noConfig, cwd: root }).status, /no tsconfig/);
  });

  it('reports when TypeScript is not installed', async () => {
    const root = await project({ 'tsconfig.json': '{}', 'a.ts': 'const a = 1;' }, { withTypeScript: false });
    const outcome = typecheckChanges({ files: [await change(root, 'a.ts', { stage1: 'const a = 2;' })], cwd: root });
    assert.equal(outcome.ran, false);
    assert.match(outcome.status, /not installed/);
  });

  it('keeps changes that add no errors, ignoring errors that already existed', async () => {
    const root = await project({ 'tsconfig.json': '{}', 'a.ts': '// TYPE_ERROR(old)\nconst a = 1;\n// WARNING_ONLY' });
    const outcome = typecheckChanges({ files: [await change(root, 'a.ts', { stage1: '// TYPE_ERROR(old)\nconst a = 2;' })], cwd: root });
    assert.equal(outcome.ran, true);
    assert.deepEqual(outcome.reverts, []);
    assert.match(outcome.status, /^ran \(tsconfig\.json\); no new errors$/);
  });

  it('changes back a file that introduces a new error, or a second copy of an existing one', async () => {
    const root = await project({ 'tsconfig.json': '{}', 'a.ts': '// TYPE_ERROR(old)\n', 'b.ts': 'ok' });
    const files = [
      await change(root, 'a.ts', { stage1: '// TYPE_ERROR(old)\n// TYPE_ERROR(old)\n' }),
      await change(root, 'b.ts', { stage1: '// TYPE_ERROR(bad)\n' }),
    ];
    const outcome = typecheckChanges({ files, cwd: root });
    assert.deepEqual(outcome.reverts.map((r) => [path.basename(r.file), r.revertedTo]).sort(), [['a.ts', 'before'], ['b.ts', 'before']]);
    assert.match(outcome.reverts.find((r) => r.file.endsWith('b.ts'))?.errors[0] ?? '', /b\.ts: TS2322: bad/);
    assert.match(outcome.status, /2 file\(s\) changed back/);
  });

  it('drops only the AI changes when the deterministic ones are fine', async () => {
    const root = await project({ 'tsconfig.json': '{}', 'a.ts': 'original' });
    const outcome = typecheckChanges({ files: [await change(root, 'a.ts', { stage1: 'stage one', after: '// TYPE_ERROR(ai broke it)' })], cwd: root });
    assert.deepEqual(outcome.reverts.map((r) => r.revertedTo), ['stage1']);
  });

  it('drops everything when the deterministic changes break types too', async () => {
    const root = await project({ 'tsconfig.json': '{}', 'a.ts': 'original' });
    const outcome = typecheckChanges({ files: [await change(root, 'a.ts', { stage1: '// TYPE_ERROR(s1)', after: '// TYPE_ERROR(ai)' })], cwd: root });
    assert.deepEqual(outcome.reverts.map((r) => r.revertedTo), ['before']);
  });

  it('blames the file whose change breaks another file', async () => {
    const root = await project({
      'tsconfig.json': '{}',
      'lib.ts': 'export const helper = 1;',
      'use.ts': '// requires(helper)',
      'other.ts': 'fine',
    });
    const files = [
      await change(root, 'lib.ts', { stage1: 'export const renamed = 1;' }),
      await change(root, 'other.ts', { stage1: 'still fine' }),
    ];
    const outcome = typecheckChanges({ files, cwd: root });
    assert.deepEqual(outcome.reverts.map((r) => path.basename(r.file)), ['lib.ts']);
    assert.match(outcome.reverts[0].errors[0], /use\.ts: TS2305/);
  });

  it('checks the referenced configs of a solution-style tsconfig and names them', async () => {
    const root = await project({
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }] }),
      'tsconfig.app.json': '{"include":["src"]}',
      'tsconfig.node.json': '{"files":["vite.config.ts"]}',
      'src/a.ts': 'ok',
      'vite.config.ts': 'ok',
    });
    const outcome = typecheckChanges({ files: [await change(root, 'src/a.ts', { stage1: '// TYPE_ERROR(x)' })], cwd: root });
    assert.deepEqual(outcome.configs.map((c) => path.basename(c)), ['tsconfig.app.json', 'tsconfig.node.json']);
    assert.equal(outcome.reverts.length, 1);
    assert.match(outcome.status, /^ran \(tsconfig\.app\.json, tsconfig\.node\.json\)/);
  });

  it('ignores files that no checked config includes', async () => {
    const root = await project({ 'tsconfig.json': '{"include":["src"]}', 'src/a.ts': 'ok', 'scripts/x.ts': 'ok' });
    const outcome = typecheckChanges({ files: [await change(root, 'scripts/x.ts', { stage1: '// TYPE_ERROR(x)' })], cwd: root });
    assert.deepEqual(outcome.reverts, []);
  });
});

describe('typecheck in the run', () => {
  /** Runs `clean . --no-ai` on a temp project and returns stdout. */
  async function runOn(root, raw = {}) {
    const capture = captureIO(root);
    const code = await runClean(normalizeOptions('.', { ai: false, ...raw }), capture.io);
    return { code, out: capture.stdout(), err: capture.stderr() };
  }

  it('keeps an unused import that a type augmentation needs (removal adds a type error)', async () => {
    const root = await project({
      'tsconfig.json': '{}',
      'augment.ts': 'export const x = 1;',
      'a.ts': "import { x } from './augment';\n// needs-import(./augment)\nconsole.log('debug');\nexport const a = 1;\n",
      'b.ts': "import { unused } from './augment';\nexport const b = 2;\n",
    });
    const { out } = await runOn(root);
    assert.doesNotMatch(out, /diff --git a\/a\.ts/, 'a.ts was changed back entirely');
    assert.match(out, /diff --git a\/b\.ts/, 'b.ts keeps its cleanup');
    assert.match(out, /Files reverted\s+1/);
    assert.match(out, /a\.ts: new type errors, left the file unchanged \(a\.ts: TS2339: augmentation from \.\/augment missing\)/);
    assert.match(out, /Typecheck\s+ran \(tsconfig\.json\); 1 file\(s\) changed back/);
    assert.match(out, /Deterministic fixes\s+1/, 'only b.ts fixes count');
  });

  it('is off with --no-typecheck', async () => {
    const root = await project({ 'tsconfig.json': '{}', 'a.ts': "import { x } from './augment';\n// needs-import(./augment)\n", 'augment.ts': '' });
    const { out } = await runOn(root, { typecheck: false });
    assert.match(out, /diff --git a\/a\.ts/);
    assert.match(out, /Typecheck\s+off \(--no-typecheck\)/);
  });

  it('warns when --typecheck is requested but cannot run', async () => {
    const root = await project({ 'tsconfig.json': '{}', 'a.ts': "import { x } from './y';\n", 'y.ts': '' }, { withTypeScript: false });
    const { err, out } = await runOn(root, { typecheck: true });
    assert.match(err, /--typecheck: not run \(TypeScript is not installed/);
    assert.match(out, /Typecheck\s+not run/);
  });
});

describe('CLI backend helpers', () => {
  it('parseTscOutput reads located errors, continuation lines and global errors', () => {
    const output = [
      "src/a.ts(3,7): error TS2322: Type 'number' is not assignable to type 'string'.",
      "src/b.ts(1,1): error TS2345: Argument of type 'X' is not assignable to parameter of type 'Y'.",
      "  Property 'z' is missing in type 'X'.",
      'error TS5083: Cannot read file \'/x/tsconfig.base.json\'.',
      '',
      'Found 3 errors in 2 files.',
    ].join('\n');
    const errors = parseTscOutput(output, '/proj');
    assert.deepEqual([...errors.keys()], [
      "/proj/src/a.ts|TS2322|Type 'number' is not assignable to type 'string'.",
      "/proj/src/b.ts|TS2345|Argument of type 'X' is not assignable to parameter of type 'Y'.\nProperty 'z' is missing in type 'X'.",
      "(global)|TS5083|Cannot read file '/x/tsconfig.base.json'.",
    ]);
  });

  it('cliConfigs expands solution-style configs and keeps normal ones', async () => {
    const root = await project({
      'tsconfig.json': '{\n  // Vite template\n  "files": [],\n  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./packages/a" }],\n}',
      'normal.json': '{ "include": ["src"], "references": [{ "path": "./x" }] }',
    });
    assert.deepEqual(cliConfigs(path.join(root, 'tsconfig.json')), [path.join(root, 'tsconfig.app.json'), path.join(root, 'packages/a/tsconfig.json')]);
    assert.deepEqual(cliConfigs(path.join(root, 'normal.json')), [path.join(root, 'normal.json')]);
  });

  it('createCliChecker writes overrides only while checking, then restores them (even on failure)', async () => {
    const root = await project({ 'tsconfig.json': '{}', 'a.ts': 'original' });
    const file = path.join(root, 'a.ts');
    const seen = [];
    const checker = createCliChecker({
      tscPath: '/fake/tsc',
      configPath: path.join(root, 'tsconfig.json'),
      runTsc: () => {
        seen.push(readFileSync(file, 'utf8'));
        return 'a.ts(1,1): error TS1: boom';
      },
    });
    const errors = checker.errors(new Map([[file, 'candidate']]));
    assert.deepEqual(seen, ['candidate']);
    assert.equal(await fs.readFile(file, 'utf8'), 'original');
    assert.deepEqual([...errors.keys()], [`${file}|TS1|boom`]);

    const failing = createCliChecker({ tscPath: '/fake/tsc', configPath: path.join(root, 'tsconfig.json'), runTsc: () => { throw new Error('tsc crashed'); } });
    assert.throws(() => failing.errors(new Map([[file, 'candidate']])), /tsc crashed/);
    assert.equal(await fs.readFile(file, 'utf8'), 'original');
  });

  it('a TypeScript without the compiler API (TS 7) is skipped in dry run and says why', async () => {
    const root = await project({ 'tsconfig.json': '{}', 'a.ts': 'ok' });
    const outcome = typecheckChanges({
      files: [await change(root, 'a.ts', { stage1: '// TYPE_ERROR(x)' })],
      cwd: root,
      loadTypeScript: () => ({ version: '7.0.0' }),
      resolveTsc: () => '/project/node_modules/typescript/bin/tsc',
    });
    assert.equal(outcome.ran, false);
    assert.match(outcome.status, /skipped tsconfig\.json in dry run \(TypeScript 7\+ can only check files on disk; it runs with --write\)/);
  });
});

const requireHere = createRequire(import.meta.url);
const ts6 = (() => {
  try {
    return requireHere('typescript-6');
  } catch {
    return null;
  }
})();
const ts7Bin = resolveProjectTsc(process.cwd());
const ts7 = loadProjectTypeScript(process.cwd());

describe('real TypeScript 6 (compiler API, in memory)', { skip: !hasCompilerApi(ts6) && 'typescript-6 devDependency not installed' }, () => {
  const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ['src'] });

  it('changes back a file with a real type error, without touching disk', async () => {
    const root = await project({ 'tsconfig.json': tsconfig, 'src/a.ts': 'export const n: number = 1;\n', 'src/b.ts': 'export const s: string = "x";\n' }, { withTypeScript: false });
    const files = [
      await change(root, 'src/a.ts', { stage1: "export const n: number = 'x';\n" }),
      await change(root, 'src/b.ts', { stage1: 'export const s: string = "y";\n' }),
    ];
    const outcome = typecheckChanges({ files, cwd: root, loadTypeScript: () => ts6 });
    assert.deepEqual(outcome.reverts.map((r) => path.basename(r.file)), ['a.ts']);
    assert.match(outcome.reverts[0].errors[0], /a\.ts: TS2322: Type 'string' is not assignable to type 'number'/);
    assert.equal(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8'), 'export const n: number = 1;\n');
  });

  it('catches a change in one file that breaks another', async () => {
    const root = await project(
      { 'tsconfig.json': tsconfig, 'src/lib.ts': 'export function total(): number {\n  return 1;\n}\n', 'src/use.ts': "import { total } from './lib';\nexport const t: number = total();\n" },
      { withTypeScript: false },
    );
    const files = [await change(root, 'src/lib.ts', { stage1: "export function total() {\n  return '1';\n}\n" })];
    const outcome = typecheckChanges({ files, cwd: root, loadTypeScript: () => ts6 });
    assert.equal(outcome.reverts.length, 1);
    assert.match(outcome.reverts[0].errors[0], /use\.ts: TS2322/);
  });

  it("checks a Vite-style solution config's references", async () => {
    const root = await project(
      {
        'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }),
        'tsconfig.app.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ['src'] }),
        'src/a.ts': 'export const n: number = 1;\n',
      },
      { withTypeScript: false },
    );
    const outcome = typecheckChanges({ files: [await change(root, 'src/a.ts', { stage1: "export const n: number = 'x';\n" })], cwd: root, loadTypeScript: () => ts6 });
    assert.match(outcome.status, /^ran \(tsconfig\.app\.json\); 1 file\(s\) changed back/);
  });
});

describe('real TypeScript 7 (native tsc binary, on disk)', { skip: (!ts7Bin || hasCompilerApi(ts7)) && 'typescript 7 devDependency not installed' }, () => {
  it('in write mode, changes back a file with a real type error and restores the disk', async () => {
    const root = await project(
      { 'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src'] }), 'src/a.ts': 'export const n: number = 1;\n', 'src/b.ts': 'export const b = 1;\n' },
      { withTypeScript: false },
    );
    const files = [
      await change(root, 'src/a.ts', { stage1: "export const n: number = 'x';\n" }),
      await change(root, 'src/b.ts', { stage1: 'export const b = 2;\n' }),
    ];
    const outcome = typecheckChanges({ files, mode: 'write', cwd: root, loadTypeScript: () => ts7, resolveTsc: () => ts7Bin });
    assert.equal(outcome.ran, true);
    assert.deepEqual(outcome.reverts.map((r) => path.basename(r.file)), ['a.ts']);
    assert.match(outcome.reverts[0].errors[0], /TS2322/);
    assert.equal(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8'), 'export const n: number = 1;\n', 'disk restored');
    assert.equal(await fs.readFile(path.join(root, 'src/b.ts'), 'utf8'), 'export const b = 1;\n', 'checking never writes the result');
  });
});
