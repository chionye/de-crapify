import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatDiff, formatReasons } from '../src/output/diff.js';
import { colorChalk, plainChalk } from './helpers.js';

// A hardcoded fake change: an unused import and a console.log removed.
const BEFORE = `import { useMemo, useState } from 'react';

export function Counter() {
  const [n, setN] = useState(0);
  console.log('render', n);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
}
`;
const AFTER = `import { useState } from 'react';

export function Counter() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
}
`;

describe('formatDiff', () => {
  it('prints a git-style unified diff', () => {
    const text = formatDiff('src/Counter.jsx', BEFORE, AFTER, { chalk: plainChalk });
    const lines = text.split('\n');
    assert.deepEqual(lines.slice(0, 3), [
      'diff --git a/src/Counter.jsx b/src/Counter.jsx',
      '--- a/src/Counter.jsx',
      '+++ b/src/Counter.jsx',
    ]);
    assert.ok(lines.includes('@@ -1,7 +1,6 @@'), text);
    assert.ok(lines.includes("-import { useMemo, useState } from 'react';"));
    assert.ok(lines.includes("+import { useState } from 'react';"));
    assert.ok(lines.includes("-  console.log('render', n);"));
    assert.ok(lines.includes(' export function Counter() {'), 'context lines keep a leading space');
  });

  it('colors hunk headers cyan, removals red, additions green, context gray', () => {
    const text = formatDiff('a.js', 'one\ntwo\nthree\n', 'one\n2\nthree\n', { chalk: colorChalk });
    assert.ok(text.includes(colorChalk.cyan('@@ -1,3 +1,3 @@')));
    assert.ok(text.includes(colorChalk.red('-two')));
    assert.ok(text.includes(colorChalk.green('+2')));
    assert.ok(text.includes(colorChalk.gray(' one')));
  });

  it('limits unchanged context to 3 lines around changes by default', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const after = before.replace('line 10\n', '');
    const lines = formatDiff('a.js', before, after, { chalk: plainChalk }).split('\n');
    assert.ok(lines.includes('@@ -7,7 +7,6 @@'));
    assert.ok(!lines.includes(' line 6'));
    assert.ok(lines.includes(' line 7') && lines.includes(' line 13'));
    assert.ok(!lines.includes(' line 14'));
  });

  it('produces separate hunks for distant changes', () => {
    const before = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') + '\n';
    const after = before.replace('l2\n', '').replace('l25\n', 'L25\n');
    const hunks = formatDiff('a.js', before, after, { chalk: plainChalk }).split('\n').filter((l) => l.startsWith('@@'));
    assert.equal(hunks.length, 2);
  });

  it('uses git-style ranges for added and deleted files', () => {
    const lines = formatDiff('a.js', '', 'x\n', { chalk: plainChalk }).split('\n');
    assert.ok(lines.includes('@@ -0,0 +1 @@'));
    const removed = formatDiff('a.js', 'x\n', '', { chalk: plainChalk }).split('\n');
    assert.ok(removed.includes('@@ -1 +0,0 @@'));
  });

  it('marks a missing trailing newline', () => {
    const text = formatDiff('a.js', 'a\nb', 'a\nc', { chalk: plainChalk });
    assert.match(text, /\\ No newline at end of file/);
  });

  it('returns an empty string when nothing changed', () => {
    assert.equal(formatDiff('a.js', BEFORE, BEFORE, { chalk: plainChalk }), '');
  });
});

describe('formatReasons', () => {
  it('lists each reason as a bullet', () => {
    const text = formatReasons(['removed unused import `useMemo`', "removed console.log('render', n)"], { chalk: plainChalk });
    assert.equal(text, "  • removed unused import `useMemo`\n  • removed console.log('render', n)");
  });
});
