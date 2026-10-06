// End-to-end: run `de-crapify clean . --no-ai` (in-process) on a temp copy of each fixture project
// and check the diffs, reports and summary a user would see.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { normalizeOptions } from '../src/options.js';
import { runClean } from '../src/run.js';
import { captureIO, copyFixture, removeTree } from './helpers.js';

const dirs = [];
after(async () => {
  for (const dir of dirs) await removeTree(dir);
});

/** @param {string} name @param {Record<string, any>} [raw] */
async function runFixture(name, raw = {}) {
  const root = await copyFixture(name);
  dirs.push(path.dirname(root));
  const capture = captureIO(root);
  const code = await runClean(normalizeOptions('.', { ai: false, ...raw }), capture.io);
  const out = capture.stdout();
  /** The "- " / "+ " lines of the diff for one file. */
  const diffOf = (rel) => {
    const start = out.indexOf(`diff --git a/${rel} b/${rel}`);
    if (start === -1) return null;
    // A file's block ends at the blank line after its list of reasons.
    const end = out.indexOf('\n\n', start);
    return out.slice(start, end === -1 ? undefined : end);
  };
  /** A reports section: its heading line through the next blank line. */
  const section = (title) => {
    const lines = out.split('\n');
    const from = lines.findIndex((l) => l.startsWith(`${title} (`));
    if (from === -1) return '';
    const to = lines.indexOf('', from);
    return lines.slice(from, to === -1 ? undefined : to).join('\n');
  };
  return { root, code, out, diffOf, section };
}

describe('fixture e2e: react-classic', () => {
  it('keeps React (classic runtime), removes unused hooks, the unused import and debug logs', async () => {
    const { diffOf, section, out } = await runFixture('react-classic');
    const diff = diffOf('src/SignupForm.tsx') ?? '';
    assert.match(diff, /^\+import React, \{ useState \} from 'react';$/m);
    assert.match(diff, /^-import \{ formatPhone \} from '\.\/formatters';$/m);
    assert.match(diff, /^-  console\.log\('SignupForm render', email, password\);$/m);
    assert.match(diff, /^-\s+console\.debug\('submitted'\);$/m);
    const errorLines = (sign) => diff.split('\n').filter((l) => l.startsWith(sign) && l.includes("console.error('Signup failed', error)")).length;
    assert.equal(errorLines('-'), errorLines('+'), 'console.error is kept (it may be re-indented, never removed)');
    assert.match(diff, /^\+ {4}if \(Object\.keys\(result\)\.length === 0 && !submitting && email && password\) \{$/m, 'nested ifs merged');
    assert.match(out, /removed unused import `useEffect` from 'react'/);
    assert.equal(section('Likely hallucinated imports'), '');
  });
});

describe('fixture e2e: react-automatic', () => {
  it('removes the unused React import (automatic runtime) and flags nothing', async () => {
    const { diffOf, out } = await runFixture('react-automatic');
    assert.match(diffOf('src/TodoList.tsx') ?? '', /^\+import \{ useState, useEffect \} from 'react';$/m);
    assert.match(out, /Likely hallucinated imports\s+0/);
    assert.match(out, /Imports that could not be verified\s+0/);
  });
});

describe('fixture e2e: react-native-expo', () => {
  it('flags none of the imports and reports (not removes) the inline console call', async () => {
    const { out, section, diffOf } = await runFixture('react-native-expo');
    assert.match(out, /Likely hallucinated imports\s+0/);
    assert.match(out, /Imports that could not be verified\s+0/);
    assert.match(section('Console calls not safe to remove'), /App\.tsx:25 {2}`console\.log\('pressed'\)` is the body of an arrow function/);
    const diff = diffOf('App.tsx') ?? '';
    assert.match(diff, /^-\s+console\.log\('App rendered in dev mode'\);$/m);
    assert.doesNotMatch(diff, /pressed/);
  });
});

describe('fixture e2e: god-file', () => {
  it('reports Dashboard.tsx with a suggested split and leaves utils.ts alone', async () => {
    const { section } = await runFixture('god-file');
    const report = section('God files');
    assert.match(report, /src\/Dashboard\.tsx:1 {2}4 React components in one file/);
    assert.match(report, /move `StatsPanel` and `formatCurrency`/);
    assert.doesNotMatch(report, /utils\.ts/);
  });
});

describe('fixture e2e: node-api', () => {
  it('reports the hallucinated package and missing file, but not the .js → .ts import', async () => {
    const { section, diffOf } = await runFixture('node-api');
    const hallucinated = section('Likely hallucinated imports');
    assert.match(hallucinated, /src\/routes\/users\.ts:2 {2}'express-validator-pro' is not installed/);
    assert.match(hallucinated, /src\/routes\/users\.ts:4 {2}'\.\/helpers\/sanitize' does not resolve to a file/);
    assert.doesNotMatch(hallucinated + section('Imports that could not be verified'), /lib\/db\.js/);
    assert.match(diffOf('src/routes/users.ts') ?? '', /^-import \{ validateUser \} from '\.\.\/validation\.js';$/m);
    assert.match(diffOf('src/server.ts') ?? '', /^-import path from 'path';$/m);
  });

  it('exits 1 in --check mode', async () => {
    assert.equal((await runFixture('node-api', { check: true })).code, 1);
  });
});

describe('fixture e2e: monorepo', () => {
  it('does not flag hoisted root deps or workspace packages, and exits 0 in --check mode', async () => {
    const { out, code } = await runFixture('monorepo', { check: true });
    assert.match(out, /Likely hallucinated imports\s+0/);
    assert.match(out, /Files with changes\s+0/);
    assert.equal(code, 0);
  });
});

describe('fixture e2e: ts-utils', () => {
  it('keeps type-only imports, decorators, console.error, @ts-expect-error and the keep block', async () => {
    const { diffOf, root } = await runFixture('ts-utils');
    const diff = diffOf('src/format.ts') ?? '';
    const removed = diff.split('\n').filter((l) => /^-[^-]/.test(l));
    assert.deepEqual(removed, ["-import { readFileSync } from 'node:fs';", '-    // Log the call', "-    console.log('displayName', user.id);"]);
    const source = await fs.readFile(path.join(root, 'src/format.ts'), 'utf8');
    assert.match(source, /console\.log\('debugDump'/, 'kept block untouched on disk');
  });
});

describe('fixture e2e: ignore-file', () => {
  it('skips the marked file entirely and still cleans its neighbour', async () => {
    const { out, diffOf } = await runFixture('ignore-file');
    assert.equal(diffOf('src/legacy.js'), null);
    assert.match(out, /ignored \(de-crapify-ignore-file\): src\/legacy\.js/);
    assert.match(diffOf('src/active.js') ?? '', /^-\s+console\.log\('active', value\);$/m);
    assert.doesNotMatch(out, /not-installed-anywhere/, 'no reports from an ignored file');
  });
});
