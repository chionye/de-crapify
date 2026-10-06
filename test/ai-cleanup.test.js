import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { aiCleanupFile, describeChange } from '../src/ai/cleanup.js';
import { createOllamaClient } from '../src/ai/ollama.js';
import { createProjectContext } from '../src/context/index.js';
import { parseCode } from '../src/parse.js';
import { makeTempTree, mockOllamaFetch, removeNarratingComments, removeTree } from './helpers.js';

const dirs = [];
after(async () => {
  for (const dir of dirs) await removeTree(dir);
});

const SOURCE = `import { useState } from 'react';
import { save } from './api';

// Format a price
export function formatPrice(cents: number): string {
  // Divide by 100
  const dollars = cents / 100;
  // Format the dollars
  const formatted = dollars.toFixed(2);
  // Return the result
  return '$' + formatted;
}

// The counter component
export function Counter() {
  // State for the count
  const [count, setCount] = useState(0);
  // Handle the click
  const onClick = () => save(count).then(() => setCount(count + 1));
  return <button onClick={onClick}>{formatPrice(count)}</button>;
}
`;

/** Run aiCleanupFile on SOURCE in a temp React project with a mocked model. */
async function run(reply, { source = SOURCE } = {}) {
  const root = await makeTempTree({ 'package.json': JSON.stringify({ dependencies: { react: '^18.2.0' } }), 'src/api.ts': 'export const save = async (n: number) => n;' });
  dirs.push(root);
  const filePath = path.join(root, 'src/Counter.tsx');
  const context = createProjectContext({ stopDir: root });
  const mock = mockOllamaFetch({ reply });
  const client = createOllamaClient({ baseUrl: 'http://ollama', model: 'qwen2.5-coder:7b', numCtx: 8192, fetch: mock.fetch });
  const log = [];
  const progress = [];
  const result = await aiCleanupFile({
    source,
    filePath,
    displayPath: 'src/Counter.tsx',
    ctx: await context.forFile(filePath),
    client,
    numCtx: 8192,
    log: (m) => log.push(m),
    progress: (name, i, n) => progress.push(`${name} ${i}/${n}`),
  });
  return { ...result, log, progress, calls: mock.calls.filter((c) => c.url.endsWith('/api/chat')) };
}

describe('aiCleanupFile', () => {
  it('applies validated rewrites and describes them, in file order', async () => {
    const result = await run(removeNarratingComments);
    assert.equal(result.chunks, 2);
    assert.deepEqual(result.reasons, ['removed 4 comments in `formatPrice`', 'removed 3 comments in `Counter`']);
    assert.ok(!result.output.includes('// Divide by 100'));
    assert.ok(result.output.startsWith("import { useState } from 'react';\nimport { save } from './api';\n\nexport function formatPrice"));
    assert.ok(parseCode(result.output, 'x.tsx').ok);
    assert.deepEqual(result.rejected, []);
  });

  it('processes chunks one at a time, from the end of the file', async () => {
    const result = await run(removeNarratingComments);
    assert.deepEqual(result.progress, ['Counter 1/2', 'formatPrice 2/2']);
  });

  it('gives the model the language, framework, imports and the other declarations', async () => {
    const { calls } = await run((code) => code);
    const user = calls[0].body.messages[1].content;
    assert.match(user, /^File: src\/Counter\.tsx$/m);
    assert.match(user, /^Language: TypeScript with JSX \(TSX\)$/m);
    assert.match(user, /This is React code/);
    assert.match(user, /^import \{ save \} from '\.\/api';$/m);
    assert.match(user, /you may use them; do not redefine them\): formatPrice$/m);
    assert.match(user, /\/\/ The counter component\nexport function Counter\(\)/);
    assert.equal(calls[0].body.messages[0].role, 'system');
  });

  it('rejects a rewrite that invents a helper, and keeps the original', async () => {
    const result = await run((code) => (code.includes('formatPrice(cents') ? code.replace("return '$' + formatted;", 'return currency(formatted);') : code));
    assert.deepEqual(result.reasons, []);
    assert.equal(result.output, SOURCE);
    assert.deepEqual(result.rejected.map((r) => [r.name, r.check, r.label]), [['formatPrice', 'identifiers', 'uses new identifiers']]);
    assert.ok(result.log.some((l) => /formatPrice: rejected \(uses new identifiers\): references `currency`/.test(l)));
  });

  it('rejects a truncated reply', async () => {
    const result = await run((code) => ({ content: removeNarratingComments(code), done_reason: 'length' }));
    assert.deepEqual(result.rejected.map((r) => r.check), ['truncated', 'truncated']);
    assert.equal(result.output, SOURCE);
  });

  it('accepts one chunk and rejects another independently', async () => {
    const result = await run((code) => (code.includes('Counter') ? removeNarratingComments(code).replace('useState(0)', 'useState(1)') : removeNarratingComments(code)));
    assert.deepEqual(result.reasons, ['removed 4 comments in `formatPrice`']);
    assert.deepEqual(result.rejected.map((r) => [r.name, r.check]), [['Counter', 'literals']]);
  });

  it('skips a chunk whose request fails and carries on', async () => {
    const result = await run((code) => (code.includes('Counter') ? new Error('socket hang up') : removeNarratingComments(code)));
    assert.deepEqual(result.failures.map((f) => f.name), ['Counter']);
    assert.match(result.failures[0].message, /request failed: socket hang up/);
    assert.deepEqual(result.reasons, ['removed 4 comments in `formatPrice`']);
  });

  it('treats a reply identical to the input (or reformatted only) as no change', async () => {
    const result = await run((code) => code.replace(/'/g, '"'));
    assert.deepEqual(result.reasons, []);
    assert.deepEqual(result.rejected, []);
    assert.equal(result.output, SOURCE);
  });

  it('accepts a reply wrapped in fences and prose', async () => {
    const result = await run((code) => `Here is the cleaned code:\n\`\`\`tsx\n${removeNarratingComments(code)}\n\`\`\``);
    assert.equal(result.reasons.length, 2);
  });
});

describe('describeChange', () => {
  const opts = /** @type {any} */ (parseCode('', 'a.ts')).parserOptions;

  it('names comment removal, flattening and removed variables', () => {
    const before = 'function f(a, b) {\n  // check a\n  if (a) {\n    if (b) {\n      const r = 1;\n      return r;\n    }\n  }\n  return 0;\n}';
    const after = 'function f(a, b) {\n  if (a && b) {\n    return 1;\n  }\n  return 0;\n}';
    assert.equal(describeChange(before, after, opts), 'removed 1 comment, flattened nested conditionals, removed 1 redundant variable');
  });

  it('falls back to "simplified code"', () => {
    assert.equal(describeChange('function f() { return a ? b : c; }', 'function f() { return a ? b : c; }', opts), 'simplified code');
  });
});
