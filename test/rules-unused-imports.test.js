import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findKeepRanges } from '../src/keep.js';
import { parseCode } from '../src/parse.js';
import { unusedImportsRule } from '../src/rules/unused-imports.js';
import { applyEdits, parseSnippet } from './helpers.js';

async function run(source, { file = 'a.tsx', jsxRuntime = 'automatic', removedRanges = [] } = {}) {
  const ast = await parseSnippet(source, file);
  const result = unusedImportsRule({ ast, source, keepRanges: findKeepRanges(ast, source), removedRanges, jsxRuntime });
  const output = applyEdits(source, result.edits);
  assert.ok(parseCode(output, file).ok, `output must parse:\n${output}`);
  return { ...result, output };
}

describe('unused imports: removes', () => {
  it('a whole unused import statement, as a line', async () => {
    const { output, reasons } = await run("import a from 'a';\nimport { b } from 'b';\nimport c from 'c';\nuse(a, c);\n");
    assert.equal(output, "import a from 'a';\nimport c from 'c';\nuse(a, c);\n");
    assert.deepEqual(reasons, ["removed unused import `b` from 'b'"]);
  });

  it('unused named specifiers in the middle, at the end and at the start', async () => {
    const cases = [
      ["import { a, b, c } from 'm';\nuse(a, c);\n", "import { a, c } from 'm';\nuse(a, c);\n"],
      ["import { a, b, c } from 'm';\nuse(a, b);\n", "import { a, b } from 'm';\nuse(a, b);\n"],
      ["import { a, b, c } from 'm';\nuse(b, c);\n", "import { b, c } from 'm';\nuse(b, c);\n"],
      ["import { a, b, c, d } from 'm';\nuse(a, d);\n", "import { a, d } from 'm';\nuse(a, d);\n"],
      ["import { a as x, b as y } from 'm';\nuse(y);\n", "import { b as y } from 'm';\nuse(y);\n"],
    ];
    for (const [input, expected] of cases) assert.equal((await run(input)).output, expected, input);
  });

  it('keeps multi-line formatting and trailing commas', async () => {
    const input = "import {\n  useEffect,\n  useMemo,\n  useState,\n} from 'react';\nuseState();\n";
    assert.equal((await run(input)).output, "import {\n  useState,\n} from 'react';\nuseState();\n");
    const input2 = "import {\n  useEffect,\n  useMemo,\n  useState,\n} from 'react';\nuseEffect();\n";
    assert.equal((await run(input2)).output, "import {\n  useEffect,\n} from 'react';\nuseEffect();\n");
  });

  it('the default specifier, or all the named ones, when the other part is used', async () => {
    assert.equal((await run("import React, { useState } from 'react';\nuseState();\n")).output, "import { useState } from 'react';\nuseState();\n");
    assert.equal((await run("import Def, { a, b } from 'm';\nDef();\n")).output, "import Def from 'm';\nDef();\n");
    assert.equal((await run("import Def, * as NS from 'm';\nNS.x();\n")).output, "import * as NS from 'm';\nNS.x();\n");
    assert.equal((await run("import Def, * as NS from 'm';\nDef();\n")).output, "import Def from 'm';\nDef();\n");
  });

  it('unused type-only imports and inline `type` specifiers', async () => {
    assert.equal((await run("import type { A } from './t';\nexport {};\n", { file: 'a.ts' })).output, 'export {};\n');
    assert.equal(
      (await run("import { type A, b } from './t';\nb();\n", { file: 'a.ts' })).output,
      "import { b } from './t';\nb();\n",
    );
  });

  it('the React import in a JSX file when the runtime is automatic', async () => {
    const { output } = await run("import React from 'react';\nexport const A = () => <div />;\n", { jsxRuntime: 'automatic' });
    assert.equal(output, 'export const A = () => <div />;\n');
  });

  it('imports only referenced from code another rule removes', async () => {
    const source = "import { dump } from './debug';\nconsole.log(dump);\n";
    const removed = [{ start: source.indexOf('console'), end: source.length }];
    assert.equal((await run(source, { removedRanges: removed })).output, source.slice(source.indexOf('console')));
  });
});

describe('unused imports: never removes', () => {
  it('side-effect imports', async () => {
    const source = "import './styles.css';\nimport 'react-native-gesture-handler';\nimport {} from 'empty';\n";
    assert.equal((await run(source)).output, source);
  });

  it('imports used in JSX, including member tags and lowercase member objects', async () => {
    const source = "import Button from './Button';\nimport * as UI from './ui';\nimport { motion } from 'framer-motion';\nexport const A = () => <><Button /><UI.Card /><motion.div /></>;\n";
    assert.equal((await run(source)).output, source);
  });

  it('imports used only as types', async () => {
    const source = [
      "import { Logger } from './logger';",
      "import type { User } from './types';",
      "import { Config } from './config';",
      "import * as NS from './ns';",
      "import { Kind } from './kind';",
      'export class S { constructor(private log: Logger) {} }',
      "export function f(u: User): Config['x'] { return u as any; }",
      'export type T = NS.Thing | typeof Kind;',
      '',
    ].join('\n');
    assert.equal((await run(source, { file: 'a.ts' })).output, source);
  });

  it('imports used only in a JSDoc type', async () => {
    const source = "import { Todo } from './types';\n/** @param {Todo} t */\nexport function f(t) { return t; }\n";
    assert.equal((await run(source, { file: 'a.js' })).output, source);
  });

  it('imports used in exports, decorators, computed keys, shorthand properties and default params', async () => {
    const source = [
      "import a from 'a';",
      "import { b } from 'b';",
      "import { dec } from 'dec';",
      "import { key } from 'key';",
      "import { val } from 'val';",
      "import { def } from 'def';",
      'export { a };',
      'export default b;',
      '@dec class C { [key] = 1; }',
      'const o = { val };',
      'function f(x = def) { return [C, o, x]; }',
      'f();',
      '',
    ].join('\n');
    assert.equal((await run(source, { file: 'a.js' })).output, source);
  });

  it('the React import in a JSX file with the classic runtime (default and namespace forms)', async () => {
    for (const imp of ["import React from 'react';", "import * as React from 'react';", "import React, { useState } from 'react';"]) {
      const source = `${imp}\nexport const A = () => <div />;\n`;
      const { output } = await run(source, { jsxRuntime: 'classic' });
      assert.match(output, /React/, imp);
    }
    // ...but unused named specifiers next to it still go.
    assert.equal(
      (await run("import React, { useState } from 'react';\nexport const A = () => <div />;\n", { jsxRuntime: 'classic' })).output,
      "import React from 'react';\nexport const A = () => <div />;\n",
    );
  });

  it('a JSX fragment also needs React with the classic runtime', async () => {
    const source = "import React from 'react';\nexport const A = () => <></>;\n";
    assert.equal((await run(source, { jsxRuntime: 'classic' })).output, source);
  });

  it('removes React in a classic-runtime file that has no JSX', async () => {
    assert.equal((await run("import React from 'react';\nexport const x = 1;\n", { jsxRuntime: 'classic', file: 'a.ts' })).output, 'export const x = 1;\n');
  });

  it('anything in files using eval, with, or a JSX pragma', async () => {
    const cases = [
      ["import { a } from 'a';\neval('a()');\n", 'eval', 'a.js'],
      // `import` makes a file strict, which forbids `with`, so this case has no imports to protect.
      ['with (obj) { x(); }\n', 'with', 'a.js'],
      ["/** @jsx h */\nimport { h } from 'preact';\nexport const A = () => <div />;\n", 'JSX pragma', 'a.jsx'],
    ];
    for (const [source, why, file] of cases) {
      const { output, skipReason } = await run(source, { file });
      assert.equal(output, source, why);
      assert.match(skipReason ?? '', new RegExp(why.split(' ')[0]), why);
    }
  });

  it('an import marked de-crapify-keep', async () => {
    const source = "// de-crapify-keep\nimport { unused } from 'x';\nimport { gone } from 'y';\n";
    assert.equal((await run(source)).output, "// de-crapify-keep\nimport { unused } from 'x';\n");
  });

  it('an import whose name is shadowed and used locally (overcounting is the safe direction)', async () => {
    const source = "import { item } from 'x';\nexport function f(item) { return item; }\n";
    assert.equal((await run(source, { file: 'a.js' })).output, source);
  });
});

describe('unused imports: names that are not usages', () => {
  it('property names, object keys, method names, labels, member types', async () => {
    const source = [
      "import { a, b, c, d, e } from 'm';",
      'obj.a;',
      'const o = { b: 1, c() {} };',
      'class K { d() {} }',
      'e: for (;;) break e;',
      '',
    ].join('\n');
    const { reasons } = await run(source, { file: 'a.js' });
    assert.equal(reasons.length, 5);
  });

  it('JSX attribute names and member properties', async () => {
    const source = "import { onClick, Item } from 'm';\nexport const A = () => <List.Item onClick={1} />;\n";
    const { reasons } = await run(source, { file: 'a.jsx' });
    assert.deepEqual(reasons.sort(), ["removed unused import `Item` from 'm'", "removed unused import `onClick` from 'm'"]);
  });

  it('re-exports from another module', async () => {
    const source = "import { x } from 'm';\nexport { x } from 'other';\n";
    assert.equal((await run(source, { file: 'a.js' })).reasons.length, 1);
  });
});
