import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCode } from '../src/parse.js';
import { extractCode, fencedBlocks, isProseLine } from '../src/validate/fences.js';
import { CHECKS, SIZE_LIMITS, validateRewrite } from '../src/validate/index.js';

const FILE = `import { useEffect, useState } from 'react';
import { fetchUser } from './api';
import type { User } from './types';

const LIMIT = 10;

// UserCard component
export function UserCard({ id, compact = false }: { id: string; compact?: boolean }): JSX.Element | null {
  // State for the user
  const [user, setUser] = useState<User | null>(null);
  // State for loading
  const [loading, setLoading] = useState(true);

  // Load the user
  useEffect(() => {
    fetchUser(id).then((u) => {
      setUser(u);
      setLoading(false);
    });
  }, [id]);

  // Check if loading
  if (loading) {
    return null;
  } else {
    // Check if user exists
    if (user) {
      // @ts-expect-error legacy prop
      return <div className="card" data-limit={LIMIT}>{compact ? user.name : \`\${user.name} <\${user.email}>\`}</div>;
    } else {
      return <p>Not found</p>;
    }
  }
}

export function helper() {
  return LIMIT;
}
`;

const CHUNK = FILE.slice(FILE.indexOf('// UserCard component'), FILE.indexOf('\n\nexport function helper'));

/** A good rewrite: narrating comments gone, nesting flattened with early returns. */
const GOOD = `export function UserCard({ id, compact = false }: { id: string; compact?: boolean }): JSX.Element | null {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchUser(id).then((u) => {
      setUser(u);
      setLoading(false);
    });
  }, [id]);

  if (loading) {
    return null;
  }
  if (user) {
    // @ts-expect-error legacy prop
    return <div className="card" data-limit={LIMIT}>{compact ? user.name : \`\${user.name} <\${user.email}>\`}</div>;
  }
  return <p>Not found</p>;
}`;

const PARSER_OPTIONS = /** @type {any} */ (parseCode(FILE, 'UserCard.tsx')).parserOptions;

/**
 * Validate `reply` as a rewrite of `chunk` inside `file`.
 * @param {string} reply
 * @param {{ file?: string, chunk?: string, doneReason?: string, filePath?: string }} [opts]
 */
function validate(reply, { file = FILE, chunk = CHUNK, doneReason = 'stop', filePath = 'UserCard.tsx' } = {}) {
  const start = file.indexOf(chunk);
  assert.notEqual(start, -1, 'test setup: chunk must be in the file');
  const parsed = parseCode(file, filePath);
  assert.ok(parsed.ok, 'test setup: file must parse');
  return validateRewrite({ fileSource: file, chunk: { start, end: start + chunk.length }, reply, doneReason, parserOptions: parsed.parserOptions });
}

/** Assert a rejection by a specific check, optionally matching the reason. */
function assertRejected(result, check, reasonPattern) {
  assert.equal(result.ok, false, `expected a rejection by "${check}", but it was accepted`);
  assert.equal(result.check, check, `expected check "${check}", got "${result.check}": ${result.reason}`);
  if (reasonPattern) assert.match(result.reason, reasonPattern);
  assert.ok(CHECKS[check], 'every check has a summary label');
}

/** Replace exactly one occurrence (fails loudly if the test's anchor text isn't there). */
function edit(text, from, to) {
  assert.ok(text.includes(from), `test setup: "${from}" not found`);
  return text.replace(from, to);
}

describe('validateRewrite: accepts', () => {
  it('a good rewrite, and returns the new file', () => {
    const result = validate(GOOD);
    assert.equal(result.ok, true, result.ok ? '' : result.reason);
    assert.ok(result.ok && result.changed);
    assert.ok(result.ok && result.changed && result.fileSource.includes('return <p>Not found</p>;\n}\n\nexport function helper'));
  });

  it('the same rewrite wrapped in fences and prose', () => {
    const reply = `Here is the cleaned-up code:\n\n\`\`\`tsx\n${GOOD}\n\`\`\`\n\nI removed the comments and flattened the nesting.`;
    const result = validate(reply);
    assert.ok(result.ok && result.changed, result.ok ? '' : result.reason);
  });

  it('comment-only removal of a heavily commented chunk (size ignores comments)', () => {
    const file = `// a\n// b\n// c\n// d\n// e\n// f\n// g\n// h\nexport function f(x: number) {\n  // add one\n  return x + 1;\n}\n`;
    const chunk = file.trimEnd();
    const result = validate('export function f(x: number) {\n  return x + 1;\n}', { file, chunk, filePath: 'f.ts' });
    assert.ok(result.ok && result.changed, result.ok ? '' : result.reason);
  });

  it('merging duplicated logic (fewer literals is fine)', () => {
    const file = `export function check(a: number, b: number) {\n  if (a < 0) {\n    throw new Error('negative');\n  }\n  if (b < 0) {\n    throw new Error('negative');\n  }\n  return a + b;\n}\n`;
    const reply = `export function check(a: number, b: number) {\n  if (a < 0 || b < 0) {\n    throw new Error('negative');\n  }\n  return a + b;\n}`;
    const result = validate(reply, { file, chunk: file.trimEnd(), filePath: 'c.ts' });
    assert.ok(result.ok && result.changed, result.ok ? '' : result.reason);
  });

  it('`undefined`, `NaN` and `Infinity` without counting them as invented', () => {
    const file = `export function f(x?: number) {\n  if (x == null) {\n    return 0;\n  } else {\n    return x;\n  }\n}\n`;
    const reply = `export function f(x?: number) {\n  if (x === undefined) return 0;\n  return x;\n}`;
    const result = validate(reply, { file, chunk: file.trimEnd(), filePath: 'f.ts' });
    assert.ok(result.ok, result.ok ? '' : result.reason);
  });
});

describe('validateRewrite: echoed context (small-model habit)', () => {
  it('keeps only the requested declaration when the model repeats imports and neighbours', () => {
    const reply = "```tsx\nimport { useEffect, useState } from 'react';\nimport type { User } from './types';\n\nconst LIMIT = 10;\n\n" + GOOD + '\n```';
    const result = validate(reply);
    assert.ok(result.ok && result.changed, result.ok ? '' : result.reason);
    assert.ok(result.ok && result.changed && !result.code.includes('import'), 'echoed imports are dropped');
    assert.equal(result.ok && result.changed && result.fileSource.match(/import \{ useEffect/g)?.length, 1);
  });

  it('still rejects a helper the declaration depends on (it is not applied, so it is invented)', () => {
    const reply = `function formatName(u) {\n  return u.name;\n}\n\n${edit(GOOD, '{compact ? user.name', '{compact ? formatName(user)')}`;
    assertRejected(validate(reply), 'identifiers', /`formatName`/);
  });

  it('does not guess when the requested name is declared twice', () => {
    assertRejected(validate(`${GOOD}\n\n${GOOD}`), 'parse');
  });
});

describe('validateRewrite: unchanged', () => {
  it('reports identical code as unchanged', () => {
    assert.deepEqual(validate(CHUNK), { ok: true, changed: false });
  });

  it('reports formatting-only changes as unchanged (no churn in the diff)', () => {
    const reformatted = CHUNK.replace(/'/g, '"').replace(/\n\n/g, '\n').replace('{ id, compact = false }', '{id, compact = false}');
    assert.deepEqual(validate(reformatted), { ok: true, changed: false });
  });
});

describe('validateRewrite: rejects (1–3) bad replies', () => {
  it('a truncated reply (done_reason "length"), even if it parses', () => {
    assertRejected(validate(GOOD, { doneReason: 'length' }), 'truncated', /length/);
    assertRejected(validate(GOOD, { doneReason: null }), 'truncated', /missing/);
  });

  it('an empty reply or one with only an empty fence', () => {
    assertRejected(validate(''), 'empty');
    assertRejected(validate('```tsx\n```'), 'empty');
  });

  it('code that does not parse', () => {
    assertRejected(validate(GOOD.replace('return null;\n  }', 'return null;\n')), 'parse', /on its own/);
    assertRejected(validate('I cannot help with that.'), 'parse');
  });

  it('code that parses alone but breaks the file', () => {
    // Fine on its own, but the file already declares LIMIT.
    assertRejected(validate('const LIMIT = 5;'), 'parse', /file/);
  });

  it('prose that cannot be separated from the code', () => {
    assertRejected(validate(`${GOOD}\n/* trailing`), 'parse');
  });
});

describe('validateRewrite: rejects (4) top-level changes', () => {
  it('never applies an added helper function or import (they are dropped, not added to the file)', () => {
    for (const reply of [`${GOOD}\n\nfunction formatUser(u) {\n  return u.name;\n}`, `import { clsx } from 'clsx';\n${GOOD}`]) {
      const result = validate(reply);
      assert.ok(result.ok && result.changed, result.ok ? '' : result.reason);
      assert.ok(result.ok && result.changed && !/formatUser|clsx/.test(result.fileSource));
    }
  });

  it('a rewrite that replaces the declaration with a different one', () => {
    assertRejected(validate('export function OtherCard() {\n  return null;\n}'), 'topLevel', /removed UserCard; added OtherCard/);
  });

  it('a dropped export', () => {
    assertRejected(validate(edit(GOOD, 'export function UserCard', 'function UserCard')), 'topLevel', /exports changed/);
  });

  it('a renamed function', () => {
    assertRejected(validate(edit(GOOD, 'function UserCard', 'function ProfileCard')), 'topLevel', /removed UserCard; added ProfileCard/);
  });
});

describe('validateRewrite: rejects (5) signature changes', () => {
  it('a changed parameter type', () => {
    assertRejected(validate(edit(GOOD, 'id: string;', 'id: number;')), 'signature', /params/);
  });

  it('a changed default value', () => {
    assertRejected(validate(edit(GOOD, 'compact = false', 'compact = true')), 'signature', /params/);
  });

  it('an added or removed parameter', () => {
    assertRejected(validate(edit(GOOD, '{ id, compact = false }: { id: string; compact?: boolean }', '{ id }: { id: string }')), 'signature', /params/);
    assertRejected(validate(edit(GOOD, '): JSX.Element | null {', ', extra?: number): JSX.Element | null {')), 'signature', /params/);
  });

  it('a changed or removed return type', () => {
    assertRejected(validate(edit(GOOD, '): JSX.Element | null {', '): JSX.Element {')), 'signature', /returnType/);
    assertRejected(validate(edit(GOOD, '): JSX.Element | null {', ') {')), 'signature', /returnType/);
  });

  it('added async or generator', () => {
    assertRejected(validate(edit(GOOD, 'export function UserCard', 'export async function UserCard')), 'signature', /async/);
  });

  it('class members removed, added or changed', () => {
    const file = `export class Store {\n  private items: string[] = [];\n  add(item: string): void {\n    // add the item\n    this.items.push(item);\n  }\n  count(): number {\n    return this.items.length;\n  }\n}\n`;
    const chunk = file.trimEnd();
    const opts = { file, chunk, filePath: 'store.ts' };
    const cleaned = chunk.replace('    // add the item\n', '');
    assert.ok(validate(cleaned, opts).ok);
    assertRejected(validate(cleaned.replace(/  count\(\)[\s\S]*?\n  }\n/, ''), opts), 'signature', /member count/);
    assertRejected(validate(cleaned.replace('add(item: string)', 'add(item: string, at?: number)'), opts), 'signature', /member add/);
    assertRejected(validate(cleaned.replace('}\n}', '}\n  clear(): void {\n    this.items = [];\n  }\n}'), opts), 'signature', /member clear/);
  });

  it('a changed wrapper (memo → forwardRef) or binding type', () => {
    const file = `export const Card = memo(({ title }: { title: string }) => {\n  // render the title\n  return <h2>{title}</h2>;\n});\n`;
    const chunk = file.trimEnd();
    const opts = { file, chunk, filePath: 'Card.tsx' };
    assertRejected(validate(chunk.replace('memo(', 'forwardRef('), opts), 'signature', /wrapper/);
    const typed = `export const Card: FC = memo(({ title }: { title: string }) => {\n  return <h2>{title}</h2>;\n});`;
    assertRejected(validate(typed, opts), 'signature', /binding Card/);
  });
});

describe('validateRewrite: rejects (6) new identifiers', () => {
  it('an invented helper function', () => {
    assertRejected(validate(edit(GOOD, '{compact ? user.name', '{compact ? formatName(user)')), 'identifiers', /`formatName`/);
  });

  it('a new global the original did not use', () => {
    assertRejected(validate(edit(GOOD, '  if (loading) {', '  console.log(user);\n  if (loading) {')), 'identifiers', /`console`/);
    assertRejected(validate(edit(GOOD, 'return null;', 'return window.fallback ?? null;')), 'identifiers', /`window`/);
  });

  it('an invented component in JSX', () => {
    assertRejected(validate(edit(GOOD, 'return <p>Not found</p>;', 'return <Empty>Not found</Empty>;')), 'identifiers', /`Empty`/);
  });

  it('an invented type', () => {
    assertRejected(validate(edit(GOOD, 'useState<User | null>', 'useState<UserModel | null>')), 'identifiers', /`UserModel`/);
  });

  it('a variable used outside the scope that declares it', () => {
    const file = `export function f(items: number[]) {\n  for (const item of items) {\n    total(item);\n  }\n  return items.length;\n}\n`;
    const reply = `export function f(items: number[]) {\n  for (const item of items) total(item);\n  return item;\n}`;
    assertRejected(validate(reply, { file, chunk: file.trimEnd(), filePath: 'f.ts' }), 'identifiers', /`item`/);
  });
});

describe('validateRewrite: rejects (7) rules-of-hooks violations', () => {
  it('a hook moved into an if', () => {
    const reply = edit(GOOD, '  useEffect(() => {', '  if (id) useEffect(() => {');
    assertRejected(validate(reply), 'hooks', /useEffect.*inside a condition/);
  });

  it('a hook after an early return', () => {
    const reply = edit(GOOD, '  const [user, setUser]', '  if (!id) return null;\n  const [user, setUser]');
    assertRejected(validate(reply), 'hooks', /useState.*after an early return/);
  });

  it('a hook moved into a nested function', () => {
    const reply = edit(GOOD, '  const [loading, setLoading] = useState(true);', '  const init = () => useState(true);\n  const [loading, setLoading] = init();');
    assertRejected(validate(reply), 'hooks', /nested function/);
  });

  it('a removed or reordered hook', () => {
    assertRejected(validate(GOOD.replace(/  useEffect\(\(\) => \{[\s\S]*?\}, \[id\]\);\n/, '')), 'hooks', /changed from \[useState, useState, useEffect\] to \[useState, useState\]/);
  });

  it('a hook switched between `React.useX` and `useX`', () => {
    const file = `export function C() {\n  const [a] = React.useState(0);\n  return a;\n}\n`;
    const reply = `export function C() {\n  const [a] = useState(0);\n  return a;\n}`;
    const result = validate(reply, { file, chunk: file.trimEnd(), filePath: 'C.tsx' });
    assert.equal(result.ok, false);
  });

  it('a changed useEffect dependency array (added, removed, or emptied)', () => {
    assertRejected(validate(edit(GOOD, '}, [id]);', '}, [id, user]);')), 'hooks', /dependency array of `useEffect`/);
    assertRejected(validate(edit(GOOD, '}, [id]);', '}, []);')), 'hooks', /dependency array/);
    assertRejected(validate(edit(GOOD, '}, [id]);', '});')), 'hooks', /dependency array/);
  });

  it('a changed useMemo / useCallback dependency array', () => {
    const file = `export function C({ a, b }: { a: number; b: number }) {\n  // memo the sum\n  const sum = useMemo(() => a + b, [a, b]);\n  const go = useCallback(() => sum, [sum]);\n  return go();\n}\n`;
    const opts = { file, chunk: file.trimEnd(), filePath: 'C.tsx' };
    const clean = file.trimEnd().replace('  // memo the sum\n', '');
    assert.ok(validate(clean, opts).ok);
    assertRejected(validate(clean.replace('[a, b]', '[a]'), opts), 'hooks', /useMemo/);
    assertRejected(validate(clean.replace('[sum]', '[]'), opts), 'hooks', /useCallback/);
  });

  it('allows whitespace-only differences in a dependency array', () => {
    const result = validate(edit(GOOD, '}, [id]);', '}, [ id ]);'));
    assert.ok(result.ok, result.ok ? '' : result.reason);
  });

  it('does not blame the rewrite for violations the original already had', () => {
    const file = `export function C({ on }: { on: boolean }) {\n  // conditional hook (already wrong)\n  if (on) {\n    useEffect(() => {}, []);\n  }\n  return null;\n}\n`;
    const reply = `export function C({ on }: { on: boolean }) {\n  if (on) {\n    useEffect(() => {}, []);\n  }\n  return null;\n}`;
    assert.ok(validate(reply, { file, chunk: file.trimEnd(), filePath: 'C.tsx' }).ok);
  });
});

describe('validateRewrite: rejects (8) dropped or moved directives', () => {
  it('a removed @ts-expect-error', () => {
    assertRejected(validate(edit(GOOD, '    // @ts-expect-error legacy prop\n', '')), 'directives', /@ts-expect-error/);
  });

  it('a @ts-expect-error moved to another statement', () => {
    const moved = edit(edit(GOOD, '    // @ts-expect-error legacy prop\n', ''), '  return <p>', '  // @ts-expect-error legacy prop\n  return <p>');
    assertRejected(validate(moved), 'directives', /@ts-expect-error/);
  });

  it('removed eslint-disable comments of each kind', () => {
    const file = [
      'export function f(a: any) {',
      '  // narrating comment',
      '  // eslint-disable-next-line no-console',
      "  console.log('x');",
      '  const b = a; // eslint-disable-line prefer-const',
      '  /* eslint-disable no-alert */',
      '  alert(b);',
      '  // @ts-ignore',
      '  return a.b.c;',
      '}',
      '',
    ].join('\n');
    const opts = { file, chunk: file.trimEnd(), filePath: 'f.ts' };
    const good = file.trimEnd().replace('  // narrating comment\n', '');
    assert.ok(validate(good, opts).ok);
    for (const directive of ['// eslint-disable-next-line no-console', ' // eslint-disable-line prefer-const', '/* eslint-disable no-alert */', '// @ts-ignore']) {
      assertRejected(validate(good.replace(directive, ''), opts), 'directives');
    }
  });
});

describe('validateRewrite: rejects (9) changed literals', () => {
  it('a changed string, JSX text, attribute, number or template text', () => {
    // Without the @ts-expect-error, so editing its line isn't caught by the directive check first.
    const file = FILE.replace('      // @ts-expect-error legacy prop\n', '');
    const chunk = CHUNK.replace('      // @ts-expect-error legacy prop\n', '');
    const good = GOOD.replace('    // @ts-expect-error legacy prop\n', '');
    const opts = { file, chunk };
    assert.ok(validate(good, opts).ok);
    assertRejected(validate(edit(good, '<p>Not found</p>', '<p>User not found</p>'), opts), 'literals', /User not found/);
    assertRejected(validate(edit(good, 'className="card"', 'className="user-card"'), opts), 'literals', /user-card/);
    assertRejected(validate(edit(good, 'data-limit={LIMIT}', 'data-limit={LIMIT + 1}'), opts), 'literals', /number 1/);
    assertRejected(validate(edit(good, '<${user.email}>', '(${user.email})'), opts), 'literals', /\(/);
  });

  it('a changed regex or URL', () => {
    const file = `export function check(s: string) {\n  // test the url\n  return /^https:\\/\\/api\\.example\\.com/.test(s) && fetch('https://api.example.com/v1');\n}\n`;
    const opts = { file, chunk: file.trimEnd(), filePath: 'c.ts' };
    const good = file.trimEnd().replace('  // test the url\n', '');
    assert.ok(validate(good, opts).ok);
    assertRejected(validate(good.replace('/v1', '/v2'), opts), 'literals', /v2/);
    assertRejected(validate(good.replace('^https', '^http'), opts), 'literals', /regex/);
  });

  it('a duplicated literal (multiset, not set)', () => {
    const file = `export function f(a: string) {\n  // check\n  return a === 'x';\n}\n`;
    const reply = `export function f(a: string) {\n  return a === 'x' || a === 'x';\n}`;
    assertRejected(validate(reply, { file, chunk: file.trimEnd(), filePath: 'f.ts' }), 'literals', /"x"/);
  });
});

describe('validateRewrite: rejects (10) edited de-crapify-keep statements', () => {
  const file = `export function dump(x: unknown) {\n  // narrate\n  const y = x;\n  // de-crapify-keep\n  console.log('dump', y);\n  return y;\n}\n`;
  const opts = { file, chunk: file.trimEnd(), filePath: 'd.ts' };

  it('accepts changes around a kept statement', () => {
    const result = validate(file.trimEnd().replace('  // narrate\n', ''), opts);
    assert.ok(result.ok && result.changed, result.ok ? '' : result.reason);
  });

  it('treats a whitespace-only edit of a kept statement as no change at all', () => {
    assert.deepEqual(validate(file.trimEnd().replace("console.log('dump', y)", "console.log('dump',  y)"), opts), { ok: true, changed: false });
  });

  it('rejects an edited, reformatted or removed kept statement', () => {
    const cleaned = file.trimEnd().replace('  // narrate\n', '');
    assertRejected(validate(cleaned.replace("console.log('dump', y)", "console.log('dump',  y)"), opts), 'keep');
    assertRejected(validate(cleaned.replace("console.log('dump', y)", 'console.log("dump", y)'), opts), 'keep');
    assertRejected(validate(file.trimEnd().replace("  // de-crapify-keep\n  console.log('dump', y);\n", ''), opts), 'keep');
    assertRejected(validate(file.trimEnd().replace('  // de-crapify-keep\n', ''), opts), 'keep');
  });
});

describe('validateRewrite: rejects (11) suspicious size changes', () => {
  const body = Array.from({ length: 10 }, (_, i) => `  const v${i} = compute(x, ${i});`).join('\n');
  const file = `export function f(x: number) {\n${body}\n  return v0 + v1 + v2 + v3 + v4 + v5 + v6 + v7 + v8 + v9;\n}\n`;
  const opts = { file, chunk: file.trimEnd(), filePath: 'f.ts' };

  it('a rewrite more than ~60% shorter', () => {
    assertRejected(validate('export function f(x: number) {\n  return compute(x, 0);\n}', opts), 'size', /shorter/);
  });

  it('a rewrite longer than the original', () => {
    const longer = file.trimEnd().replace('  return v0', '  const total = v0').replace('v9;\n}', 'v9;\n  return total;\n}');
    assertRejected(validate(longer, opts), 'size', /longer/);
  });

  it('uses tunable limits', () => {
    assert.equal(SIZE_LIMITS.MIN_RATIO, 0.4);
    assert.equal(SIZE_LIMITS.MAX_RATIO, 1);
  });
});

describe('extractCode (fence and prose stripping)', () => {
  const opts = /** @type {any} */ (parseCode('', 'a.ts')).parserOptions;

  it('returns plain code unchanged (trimmed)', () => {
    assert.equal(extractCode('\n\nconst a = 1;\n\n', opts), 'const a = 1;');
  });

  it('takes the content of a fenced block, with or without a language tag', () => {
    assert.equal(extractCode('```ts\nconst a = 1;\n```', opts), 'const a = 1;');
    assert.equal(extractCode('```\nconst a = 1;\n```', opts), 'const a = 1;');
    assert.equal(extractCode('~~~typescript\nconst a = 1;\n~~~', opts), 'const a = 1;');
  });

  it('ignores prose around a fenced block', () => {
    assert.equal(extractCode('Sure! Here you go:\n```js\nconst a = 1;\n```\nHope this helps.', opts), 'const a = 1;');
  });

  it('takes the longest of several fenced blocks', () => {
    assert.equal(extractCode('```\nx;\n```\nand the full version:\n```\nconst a = 1;\nconst b = 2;\n```', opts), 'const a = 1;\nconst b = 2;');
  });

  it('takes everything after an unclosed fence (truncated reply)', () => {
    assert.equal(extractCode('```ts\nconst a = 1;\nconst b', opts), 'const a = 1;\nconst b');
  });

  it('trims prose lines before and after unfenced code', () => {
    assert.equal(extractCode('Here is the refactored function:\n\nconst a = 1;\n\nThis removes redundant comments.', opts), 'const a = 1;');
  });

  it('never trims lines that look like code', () => {
    const reply = 'Note: x = 1 is set first\nconst a = 1;';
    assert.equal(extractCode(reply, opts), reply, 'a line with `=` is not treated as prose');
    assert.equal(extractCode('const a = 1;\nconst b', opts), 'const a = 1;\nconst b', 'a short code line is not prose');
  });

  it('isProseLine', () => {
    for (const line of ['Here is the cleaned-up code:', 'I removed the redundant comments.', '', '   ']) assert.ok(isProseLine(line), line);
    for (const line of ['const b', 'return total', '@observer', 'export default', '}', 'foo()', '// a comment here', ' * jsdoc line', 'x = 1']) {
      assert.ok(!isProseLine(line), line);
    }
  });

  it('returns null for an empty reply', () => {
    assert.equal(extractCode('   \n  ', opts), null);
    assert.equal(extractCode('```\n```', opts), null);
  });

  it('fencedBlocks handles CRLF', () => {
    assert.deepEqual(fencedBlocks('```js\r\nconst a = 1;\r\n```\r\n'), ['const a = 1;']);
  });
});
