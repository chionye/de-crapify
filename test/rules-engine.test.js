import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createProjectContext } from '../src/context/index.js';
import { formatReports } from '../src/output/reports.js';
import { runDeterministicRules } from '../src/rules/index.js';
import { makeTempTree, parseSnippet, plainChalk, removeTree } from './helpers.js';

const dirs = [];
after(async () => {
  for (const dir of dirs) await removeTree(dir);
});

async function clean(source, { rel = 'src/a.tsx', files = {}, keepConsole = new Set(['error', 'warn']) } = {}) {
  const root = await makeTempTree({ 'package.json': JSON.stringify({ dependencies: { react: '^18.2.0' } }), ...files });
  dirs.push(root);
  const filePath = path.join(root, rel);
  const context = createProjectContext({ stopDir: root });
  const ctx = await context.forFile(filePath);
  const ast = await parseSnippet(source, filePath);
  return runDeterministicRules({ source, ast, filePath, ctx, files: context.files, options: { keepConsole } });
}

describe('runDeterministicRules', () => {
  it('applies the console and import rules together and keeps formatting', async () => {
    const source = [
      "import { useMemo, useState } from 'react';",
      "import { dump } from './debug';",
      '',
      'export function Counter() {',
      '  const [n, setN] = useState(0);',
      '  console.log(dump, n);',
      '  return <button onClick={() => setN(n + 1)}>{n}</button>;',
      '}',
      '',
    ].join('\n');
    const { output, reasons, reports } = await clean(source, { files: { 'src/debug.ts': '' } });
    assert.equal(
      output,
      "import { useState } from 'react';\n\nexport function Counter() {\n  const [n, setN] = useState(0);\n  return <button onClick={() => setN(n + 1)}>{n}</button>;\n}\n",
    );
    assert.deepEqual(reasons, [
      "removed unused import `useMemo` from 'react'",
      "removed unused import `dump` from './debug'",
      'removed `console.log(dump, n)`',
    ]);
    assert.deepEqual(reports, []);
  });

  it('uses the classic runtime when unsure and keeps React', async () => {
    const source = "import React from 'react';\nexport const A = () => <div />;\n";
    const root = { 'package.json': JSON.stringify({ dependencies: { react: '*' } }) };
    const { output } = await clean(source, { files: root });
    assert.equal(output, source);
  });

  it('respects a per-file @jsxRuntime pragma', async () => {
    const source = "/** @jsxRuntime automatic */\nimport React from 'react';\nexport const A = () => <div />;\n";
    const { output } = await clean(source, { files: { 'package.json': JSON.stringify({ dependencies: { react: '16' } }) } });
    assert.equal(output, '/** @jsxRuntime automatic */\nexport const A = () => <div />;\n');
  });

  it('does not report a hallucinated import that is being removed as unused', async () => {
    const source = "import { x } from 'react-super-forms';\nimport { y } from 'also-fake';\nexport const z = y;\n";
    const { reports, reasons } = await clean(source, { rel: 'src/a.ts' });
    assert.deepEqual(reasons, ["removed unused import `x` from 'react-super-forms'"]);
    assert.equal(reports.length, 1);
    assert.match(reports[0].message, /'also-fake'/);
  });

  it('never touches de-crapify-keep code', async () => {
    const source = "// de-crapify-keep\nimport { unused } from 'react';\n// de-crapify-keep\nconsole.log(1);\nconsole.log(2);\n";
    const { output } = await clean(source, { rel: 'src/a.js' });
    assert.equal(output, "// de-crapify-keep\nimport { unused } from 'react';\n// de-crapify-keep\nconsole.log(1);\n");
  });

  it('returns the source unchanged when there is nothing to do', async () => {
    const source = "import { useState } from 'react';\nexport const f = () => useState(0);\n";
    const result = await clean(source, { rel: 'src/a.ts' });
    assert.equal(result.output, source);
    assert.deepEqual(result.reasons, []);
  });

  it('sorts reports by line', async () => {
    const source = "import a from 'fake-a';\nconst el = <B onPress={() => console.log('x')} />;\nimport b from 'fake-b';\nexport default [a, b, el];\n";
    const { reports } = await clean(source);
    assert.deepEqual(reports.map((r) => r.line), [1, 2, 3]);
  });
});

describe('formatReports', () => {
  it('groups by type in a fixed order, with file:line, and indents multi-line messages', () => {
    const text = formatReports(
      [
        { type: 'godFile', file: '/p/src/Big.tsx', line: 1, message: '2 components\nSuggested split:\n  - move `A`' },
        { type: 'unsafeConsole', file: '/p/src/a.js', line: 9, message: '`console.log(f())` has arguments...' },
        { type: 'hallucinatedImport', file: '/p/src/b.ts', line: 3, message: "'x' is not installed" },
        { type: 'hallucinatedImport', file: '/p/src/a.ts', line: 7, message: "'y' is not installed" },
        { type: 'unverifiedImport', file: '/p/src/c.ts', line: 2, message: "'@/c' could not be resolved" },
      ],
      { chalk: plainChalk, cwd: '/p' },
    );
    assert.equal(
      text,
      [
        'Likely hallucinated imports (2)',
        "  src/a.ts:7  'y' is not installed",
        "  src/b.ts:3  'x' is not installed",
        '',
        'Imports that could not be verified (1)',
        "  src/c.ts:2  '@/c' could not be resolved",
        '',
        'Console calls not safe to remove (1)',
        '  src/a.js:9  `console.log(f())` has arguments...',
        '',
        'God files (1)',
        '  src/Big.tsx:1  2 components',
        '    Suggested split:',
        '      - move `A`',
      ].join('\n'),
    );
  });

  it('is empty when there are no reports', () => {
    assert.equal(formatReports([], { chalk: plainChalk, cwd: '/' }), '');
  });
});
