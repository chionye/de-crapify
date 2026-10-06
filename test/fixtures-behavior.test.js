// Behavior tests for the runnable logic in test-fixtures/. The same assertions run against the
// original fixtures and against a copy cleaned by de-crapify, proving the cleanup didn't change
// behavior.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, beforeEach, describe, it, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { aiCleanupFile } from '../src/ai/cleanup.js';
import { createOllamaClient } from '../src/ai/ollama.js';
import { createProjectContext } from '../src/context/index.js';
import { parseCode } from '../src/parse.js';
import { runDeterministicRules } from '../src/rules/index.js';
import { FIXTURES_DIR, makeTempTree, mockOllamaFetch, removeNarratingComments, removeTree } from './helpers.js';

/** Fixture files with runnable logic, relative to test-fixtures/. */
const RUNNABLE = [
  'react-classic/src/signupLogic.js',
  'react-classic/src/formatters.js',
  'react-automatic/src/todoLogic.js',
  'node-api/src/validation.js',
  'monorepo/packages/utils/src/index.js',
];

/**
 * Import a fixture module from `root` (the original test-fixtures/ or a cleaned copy).
 * @param {string} root
 * @param {string} rel
 */
function loadFixtureModule(root, rel) {
  return import(pathToFileURL(path.join(root, rel)).href);
}

/**
 * Copy test-fixtures/ to a temp dir and run the deterministic rules (and, with `ai`, the AI stage
 * with a mock model that strips narrating comments) over the runnable files. Every AI rewrite goes
 * through the real validation. Returns the copy's path and how many files actually changed.
 * @param {{ ai?: boolean }} [options]
 */
async function cleanedFixturesCopy({ ai = false } = {}) {
  const client = ai
    ? createOllamaClient({ baseUrl: 'http://mock', model: 'qwen2.5-coder:7b', numCtx: 8192, fetch: mockOllamaFetch({ reply: removeNarratingComments }).fetch })
    : null;
  const tmp = await makeTempTree();
  const root = path.join(tmp, 'test-fixtures');
  await fs.cp(FIXTURES_DIR, root, { recursive: true });
  let changed = 0;
  /** @type {Record<string, string>} */
  const contents = {};
  for (const rel of RUNNABLE) {
    const filePath = path.join(root, rel);
    const projectRoot = path.join(root, rel.split('/')[0]);
    const context = createProjectContext({ stopDir: projectRoot });
    const source = await fs.readFile(filePath, 'utf8');
    const parsed = parseCode(source, filePath);
    if (!parsed.ok) throw parsed.error;
    const { output } = await runDeterministicRules({
      source,
      ast: parsed.ast,
      filePath,
      ctx: await context.forFile(filePath),
      files: context.files,
      options: { keepConsole: new Set(['error', 'warn']) },
    });
    const ctx = await context.forFile(filePath);
    const final = client
      ? (await aiCleanupFile({ source: output, filePath, displayPath: rel, ctx, client, numCtx: 8192 })).output
      : output;
    if (final !== source) changed++;
    contents[rel] = final;
    await fs.writeFile(filePath, final);
  }
  return { tmp, root, changed, contents };
}

beforeEach(() => {
  // The fixtures are full of debug logs; keep test output readable.
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
});

/**
 * @param {string} label
 * @param {string} root
 */
function behaviorSuites(label, root) {
  describe(`${label}: react-classic/src/signupLogic.js`, async () => {
    const { validateSignup, buildPayload } = await loadFixtureModule(root, 'react-classic/src/signupLogic.js');

    it('accepts valid input', () => {
      assert.deepEqual(validateSignup({ email: 'a@b.co', password: 'longenough', confirm: 'longenough' }), {});
    });

    it('reports each problem', () => {
      assert.deepEqual(validateSignup({ email: '', password: '', confirm: 'x' }), {
        email: 'Email is required',
        password: 'Password is required',
        confirm: 'Passwords do not match',
      });
      assert.deepEqual(validateSignup({ email: 'nope', password: 'short', confirm: 'short' }), {
        email: 'Email is invalid',
        password: 'Password must be at least 8 characters',
      });
    });

    it('normalizes the payload email', () => {
      assert.deepEqual(buildPayload({ email: '  Ada@Example.COM ', password: 'pw' }), { email: 'ada@example.com', password: 'pw' });
    });
  });

  describe(`${label}: react-classic/src/formatters.js`, async () => {
    const { formatPhone } = await loadFixtureModule(root, 'react-classic/src/formatters.js');

    it('formats 10-digit numbers and passes others through', () => {
      assert.equal(formatPhone('555-123-4567'), '(555) 123-4567');
      assert.equal(formatPhone('12345'), '12345');
    });
  });

  describe(`${label}: react-automatic/src/todoLogic.js`, async () => {
    const { addTodo, toggleTodo, visibleTodos, resetIds } = await loadFixtureModule(root, 'react-automatic/src/todoLogic.js');

    it('adds, toggles and filters todos', () => {
      resetIds();
      let todos = addTodo([], '  write tests ');
      todos = addTodo(todos, 'ship');
      assert.deepEqual(todos, [
        { id: 1, text: 'write tests', done: false },
        { id: 2, text: 'ship', done: false },
      ]);
      const before = todos;
      todos = toggleTodo(todos, 1);
      assert.notEqual(todos, before, 'returns a new array');
      assert.equal(before[0].done, false, 'does not mutate');
      assert.deepEqual(visibleTodos(todos, 'all').map((t) => t.id), [1, 2]);
      assert.deepEqual(visibleTodos(todos, 'active').map((t) => t.id), [2]);
      assert.deepEqual(visibleTodos(todos, 'done').map((t) => t.id), [1]);
    });

    it('returns all todos and warns for an unknown filter', () => {
      const todos = [{ id: 1, text: 'a', done: true }];
      assert.equal(visibleTodos(todos, 'weird'), todos);
      assert.equal(/** @type {any} */ (console.warn).mock.callCount(), 1);
    });
  });

  describe(`${label}: node-api/src/validation.js`, async () => {
    const { validateUser, validateUserUpdate } = await loadFixtureModule(root, 'node-api/src/validation.js');

    it('validateUser requires name and email, checks age range', () => {
      assert.deepEqual(validateUser({ name: 'Ada', email: 'a@b.c' }), []);
      assert.deepEqual(validateUser({ name: ' ', email: 'nope', age: 200 }), ['name', 'email', 'age']);
      assert.deepEqual(validateUser({}), ['name', 'email']);
      assert.deepEqual(validateUser({ name: 'A', email: 'a@b', age: '3' }), ['age']);
    });

    it('validateUserUpdate only checks fields that are present', () => {
      assert.deepEqual(validateUserUpdate({}), []);
      assert.deepEqual(validateUserUpdate({ name: '' }), ['name']);
      assert.deepEqual(validateUserUpdate({ email: 'x', age: -1 }), ['email', 'age']);
      assert.deepEqual(validateUserUpdate({ name: 'Ok', email: 'a@b', age: 30 }), []);
    });
  });

  describe(`${label}: monorepo/packages/utils`, async () => {
    const { slugify } = await loadFixtureModule(root, 'monorepo/packages/utils/src/index.js');

    it('slugifies', () => {
      assert.equal(slugify('  Platform Team! '), 'platform-team');
    });
  });
}

behaviorSuites('original', FIXTURES_DIR);

const cleaned = await cleanedFixturesCopy();
const aiCleaned = await cleanedFixturesCopy({ ai: true });
after(async () => {
  await removeTree(cleaned.tmp);
  await removeTree(aiCleaned.tmp);
});

describe('cleaned copy', () => {
  it('actually contains cleanups', () => {
    // signupLogic.js has a removable console.log; the others only have kept calls (console.warn) or none.
    assert.ok(cleaned.changed >= 1, `only ${cleaned.changed} runnable fixture files changed`);
  });
});

behaviorSuites('after deterministic cleanup', cleaned.root);

describe('AI-cleaned copy', () => {
  it('actually contains AI cleanups on top of the deterministic ones', () => {
    const differing = RUNNABLE.filter((rel) => aiCleaned.contents[rel] !== cleaned.contents[rel]);
    assert.ok(differing.length > 0, 'the mock model changed nothing beyond the deterministic rules');
  });
});

behaviorSuites('after deterministic + AI cleanup (mock model)', aiCleaned.root);
