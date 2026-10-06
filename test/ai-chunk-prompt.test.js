import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findChunks, MIN_CHUNK_LINES } from '../src/ai/chunk.js';
import { buildUserMessage, languageLabel, SYSTEM_PROMPT } from '../src/ai/prompt.js';
import { findKeepRanges } from '../src/keep.js';
import { parseSnippet } from './helpers.js';

/** A function body of `n` lines total. */
const fn = (header, n = 6) => `${header} {\n${Array.from({ length: n - 2 }, (_, i) => `  step${i}();`).join('\n')}\n}`;

async function chunksOf(source, { file = 'a.tsx', numCtx = 8192, promptTokens = 1000 } = {}) {
  const ast = await parseSnippet(source, file);
  const result = findChunks({ ast, source, keepRanges: findKeepRanges(ast, source), numCtx, promptTokens });
  return { ...result, texts: result.chunks.map((c) => source.slice(c.start, c.end)), names: result.chunks.map((c) => c.name) };
}

describe('findChunks', () => {
  it('chunks functions, classes, arrow components, wrapped components and exported values', async () => {
    const source = [
      "import { memo } from 'react';",
      fn('function plain()'),
      fn('export function exported()'),
      fn('export default function Page()'),
      fn('class Store'),
      `export const Card = memo(() => {\n${'  a();\n'.repeat(4)}  return null;\n});`,
      `const helper = (x) => {\n${'  a();\n'.repeat(4)}  return x;\n};`,
      `export const config = {\n${'  a: 1,\n'.repeat(5)}};`,
    ].join('\n\n');
    const { names } = await chunksOf(source);
    assert.deepEqual(names, ['plain', 'exported', 'Page', 'Store', 'Card', 'helper', 'config']);
  });

  it('leaves imports, plain statements, non-exported plain values and TS types alone', async () => {
    const source = [
      "import x from 'x';",
      `const settings = {\n${'  a: 1,\n'.repeat(5)}};`,
      `app.use(() => {\n${'  a();\n'.repeat(5)}});`,
      `export interface Props {\n${'  a: string;\n'.repeat(5)}}`,
      `export type T = {\n${'  a: string;\n'.repeat(5)}};`,
      `export enum E {\n${'  A,\n'.repeat(5)}}`,
    ].join('\n\n');
    assert.deepEqual((await chunksOf(source)).names, []);
  });

  it(`skips chunks under ${MIN_CHUNK_LINES} lines, marked de-crapify-keep, or too large for num_ctx`, async () => {
    const source = [fn('function tiny()', 4), `// de-crapify-keep\n${fn('function kept()')}`, fn('function big()', 1000), fn('function ok()')].join('\n\n');
    const { names, skipped } = await chunksOf(source, { numCtx: 4096 });
    assert.deepEqual(names, ['ok']);
    assert.deepEqual(
      skipped.map((s) => [s.name, s.reason.replace(/\(~\d+ tokens\)/, '(…)')]),
      [
        ['tiny', 'only 4 lines'],
        ['kept', 'marked de-crapify-keep'],
        ['big', 'too large for --num-ctx 4096 (…)'],
      ],
    );
  });

  it('includes the // comments directly above, but not JSDoc, block comments, or comments after a blank line', async () => {
    const source = [
      "import x from 'x';",
      '',
      '// Not attached: blank line below',
      '',
      '/** JSDoc stays outside the chunk. */',
      '// Narrating comment that may be removed',
      '// eslint-disable-next-line complexity',
      fn('export function a()'),
      '',
      'const z = 1; // trailing comment of other code',
      fn('function b()'),
    ].join('\n');
    const { texts } = await chunksOf(source, { file: 'a.ts' });
    assert.ok(texts[0].startsWith('// Narrating comment that may be removed\n// eslint-disable-next-line complexity\nexport function a()'), texts[0]);
    assert.ok(texts[1].startsWith('function b()'), texts[1]);
  });
});

describe('prompt', () => {
  it('the system prompt states the output format and every rule from the spec', () => {
    const required = [
      /ONLY the code/,
      /no markdown, no code fences/,
      /If nothing should change, return the code exactly as you received it/,
      /Remove comments that merely restate/,
      /Flatten unnecessary nesting/,
      /early returns/,
      /redundant intermediate variables/,
      /clearly duplicated/,
      /Rename the declaration, its parameters/,
      /type annotation, the return type/,
      /async or a generator/,
      /side effect/,
      /Add imports, dependencies/,
      /new features/,
      /JSDoc/,
      /@ts-ignore.*@ts-expect-error.*eslint-disable/,
      /de-crapify-keep/,
      /Do not add, remove, reorder or move hook calls/,
      /early return before any hook call/,
      /dependency arrays/,
    ];
    for (const pattern of required) assert.match(SYSTEM_PROMPT, pattern);
  });

  it('labels the language from the extension and JSX use', () => {
    assert.equal(languageLabel('a.tsx', true), 'TypeScript with JSX (TSX)');
    assert.equal(languageLabel('a.jsx', true), 'JavaScript with JSX (JSX)');
    assert.equal(languageLabel('a.ts', false), 'TypeScript');
    assert.equal(languageLabel('a.mts', false), 'TypeScript');
    assert.equal(languageLabel('App.js', true), 'JavaScript with JSX');
    assert.equal(languageLabel('a.cjs', false), 'JavaScript');
  });

  it('the user message gives the file, language, framework, imports, other declarations and the code', () => {
    const message = buildUserMessage({
      code: 'export function A() {}',
      displayPath: 'src/A.tsx',
      language: 'TypeScript with JSX (TSX)',
      framework: 'react-native',
      imports: ["import { View } from 'react-native';"],
      otherDeclarations: ['styles', 'helper'],
    });
    assert.equal(
      message,
      [
        'File: src/A.tsx',
        'Language: TypeScript with JSX (TSX)',
        'This is React Native code (React rules apply).',
        '',
        'Imports in this file (do not add any):',
        "import { View } from 'react-native';",
        '',
        'Other top-level declarations in this file (you may use them; do not redefine them): styles, helper',
        '',
        'Clean up this declaration and return only the code:',
        '',
        'export function A() {}',
      ].join('\n'),
    );
  });

  it('says when there are no imports, and omits the framework line for plain code', () => {
    const message = buildUserMessage({ code: 'x', displayPath: 'a.js', language: 'JavaScript', framework: null, imports: [], otherDeclarations: [] });
    assert.match(message, /This file has no imports \(do not add any\)\./);
    assert.doesNotMatch(message, /React/);
  });
});
