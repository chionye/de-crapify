import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSupportedFile, parseCode, parserAttemptsFor } from '../src/parse.js';

/** Plugin names (without options) of the first parser attempt for a file. */
function firstPlugins(file) {
  return parserAttemptsFor(file)[0].plugins.map((p) => (Array.isArray(p) ? p[0] : p));
}

describe('isSupportedFile', () => {
  it('accepts JS/TS extensions, including React Native platform files', () => {
    for (const f of ['a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'a.ts', 'a.tsx', 'a.mts', 'a.cts', 'Button.ios.tsx', 'Button.android.js']) {
      assert.ok(isSupportedFile(f), f);
    }
  });

  it('rejects declaration files and other extensions', () => {
    for (const f of ['a.d.ts', 'a.d.mts', 'a.d.cts', 'a.vue', 'a.svelte', 'a.json', 'a.css', 'README.md']) {
      assert.ok(!isSupportedFile(f), f);
    }
  });
});

describe('parser settings per extension', () => {
  it('.ts / .mts / .cts use typescript without jsx', () => {
    for (const f of ['a.ts', 'a.mts', 'a.cts']) {
      const plugins = firstPlugins(f);
      assert.ok(plugins.includes('typescript'), f);
      assert.ok(!plugins.includes('jsx'), f);
    }
  });

  it('.tsx uses typescript + jsx', () => {
    const plugins = firstPlugins('a.tsx');
    assert.ok(plugins.includes('typescript') && plugins.includes('jsx'));
  });

  it('.js / .jsx / .mjs / .cjs use jsx, never typescript', () => {
    for (const f of ['a.js', 'a.jsx', 'a.mjs', 'a.cjs']) {
      for (const attempt of parserAttemptsFor(f)) {
        const plugins = attempt.plugins.map((p) => (Array.isArray(p) ? p[0] : p));
        assert.ok(plugins.includes('jsx'), f);
        assert.ok(!plugins.includes('typescript'), f);
      }
    }
  });

  it('always enables decorators, classProperties, topLevelAwait, importAttributes', () => {
    for (const f of ['a.js', 'a.ts', 'a.tsx']) {
      const plugins = firstPlugins(f);
      assert.ok(plugins.some((p) => p === 'decorators' || p === 'decorators-legacy'), f);
      for (const p of ['classProperties', 'topLevelAwait', 'importAttributes']) assert.ok(plugins.includes(p), `${f} ${p}`);
    }
  });

  it('.cjs tries script first, others module first', () => {
    assert.equal(parserAttemptsFor('a.cjs')[0].sourceType, 'script');
    assert.equal(parserAttemptsFor('a.cts')[0].sourceType, 'script');
    assert.equal(parserAttemptsFor('a.js')[0].sourceType, 'module');
  });
});

describe('parseCode', () => {
  it('parses a generic arrow function in a .ts file', () => {
    assert.ok(parseCode('export const id = <T>(x: T): T => x;', 'a.ts').ok);
  });

  it('parses JSX in a .js file (React Native style)', () => {
    assert.ok(parseCode('export default function App() { return <View><Text>hi</Text></View>; }', 'App.js').ok);
  });

  it('parses TSX', () => {
    assert.ok(parseCode('export function A({ n }: { n: number }) { return <div>{n}</div>; }', 'A.tsx').ok);
  });

  it('parses NestJS-style parameter decorators in TS', () => {
    const code = `
      @Controller('users')
      export class UsersController {
        constructor(@Inject(TOKEN) private readonly svc: Svc) {}
        @Post() create(@Body() dto: CreateDto) { return dto; }
      }`;
    assert.ok(parseCode(code, 'users.controller.ts').ok);
  });

  it('parses decorators after export (TS 5 / stage 3 style) via the fallback', () => {
    assert.ok(parseCode('export @Injectable() class B {}', 'b.ts').ok);
    assert.ok(parseCode('export default @dec class C {}', 'c.js').ok);
  });

  it('parses MobX-style decorators in JS', () => {
    assert.ok(parseCode('@observer class A { @observable x = 1; @action.bound go() {} }', 'a.js').ok);
  });

  it('parses top-level await and import attributes', () => {
    assert.ok(parseCode("import data from './d.json' with { type: 'json' };\nawait load(data);", 'a.mjs').ok);
  });

  it('falls back to script for CommonJS (e.g. top-level return, `with`)', () => {
    assert.ok(parseCode("if (!module.parent) return;\nmodule.exports = 1;", 'a.cjs').ok);
    assert.ok(parseCode('with (obj) { x = 1; }', 'legacy.js').ok);
  });

  it('reports failure for invalid code instead of throwing', () => {
    const result = parseCode('function (', 'bad.js');
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.error instanceof Error);
  });

  it('rejects TS syntax in a .js file', () => {
    assert.equal(parseCode('const x: number = 1;', 'a.js').ok, false);
  });

  it('returns the parser options that worked', () => {
    const result = parseCode('const a = 1;', 'a.ts');
    assert.ok(result.ok && result.parserOptions.plugins.includes('typescript'));
  });
});
