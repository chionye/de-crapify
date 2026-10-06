import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findKeepRanges } from '../src/keep.js';
import { parseSnippet } from './helpers.js';

/** The protected source text for each range. */
async function kept(source, file = 'a.ts') {
  const ast = await parseSnippet(source, file);
  return findKeepRanges(ast, source).map((r) => source.slice(r.start, r.end));
}

describe('de-crapify-keep', () => {
  it('protects the statement directly after the marker (including any export)', async () => {
    const source = '// de-crapify-keep\nexport function a() {\n  console.log(1);\n}\nfunction b() {}\n';
    assert.deepEqual(await kept(source), ['// de-crapify-keep\nexport function a() {\n  console.log(1);\n}']);
  });

  it('allows other comments (e.g. JSDoc) between the marker and the statement', async () => {
    const source = '// de-crapify-keep\n/** Docs */\n// more\nconst x = 1;\nconst y = 2;\n';
    const [range] = await kept(source);
    assert.ok(range.endsWith('const x = 1;'));
  });

  it('works for block-comment markers and nested statements', async () => {
    const source = 'function f() {\n  a();\n  /* de-crapify-keep */\n  console.log(2);\n  b();\n}\n';
    assert.deepEqual(await kept(source), ['/* de-crapify-keep */\n  console.log(2);']);
  });

  it('protects class members and object properties', async () => {
    const source = 'class C {\n  // de-crapify-keep\n  debug() { console.log(1); }\n  other() {}\n}\nconst o = {\n  // de-crapify-keep\n  log: () => console.log(1),\n};\n';
    const ranges = await kept(source);
    assert.equal(ranges.length, 2);
    assert.match(ranges[0], /debug\(\)/);
    assert.match(ranges[1], /log: \(\) =>/);
  });

  it('a trailing marker protects its own line too', async () => {
    const source = 'console.log(1); // de-crapify-keep\nconsole.log(2);\nconsole.log(3);\n';
    const ranges = await kept(source);
    assert.ok(ranges.some((r) => r === 'console.log(2);' || r.endsWith('console.log(2);')));
    assert.ok(ranges.some((r) => r.startsWith('console.log(1);')));
    assert.ok(!ranges.some((r) => r.includes('console.log(3)')));
  });

  it('ignores other comments that merely mention the marker', async () => {
    assert.deepEqual(await kept('// use de-crapify-keep to protect code\nconst x = 1;\n'), []);
  });

  it('returns nothing when there are no markers', async () => {
    assert.deepEqual(await kept('const x = 1;\n'), []);
  });
});
