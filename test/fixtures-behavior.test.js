// Behavior tests for the runnable logic in test-fixtures/. They pin down what the messy fixture code
// does today, so the same assertions can be run against the cleaned-up output in later phases.
import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { FIXTURES_DIR } from './helpers.js';

/**
 * Import a fixture module. Takes an optional directory so later phases can point the same tests at
 * a cleaned-up copy.
 * @param {string} rel
 * @param {string} [root]
 */
export function loadFixtureModule(rel, root = FIXTURES_DIR) {
  return import(pathToFileURL(path.join(root, rel)).href);
}

beforeEach(() => {
  // The fixtures are full of debug logs; keep test output readable.
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
});

describe('react-classic/src/signupLogic.js', async () => {
  const { validateSignup, buildPayload } = await loadFixtureModule('react-classic/src/signupLogic.js');

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

describe('react-classic/src/formatters.js', async () => {
  const { formatPhone } = await loadFixtureModule('react-classic/src/formatters.js');

  it('formats 10-digit numbers and passes others through', () => {
    assert.equal(formatPhone('555-123-4567'), '(555) 123-4567');
    assert.equal(formatPhone('12345'), '12345');
  });
});

describe('react-automatic/src/todoLogic.js', async () => {
  const { addTodo, toggleTodo, visibleTodos, resetIds } = await loadFixtureModule('react-automatic/src/todoLogic.js');

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

describe('node-api/src/validation.js', async () => {
  const { validateUser, validateUserUpdate } = await loadFixtureModule('node-api/src/validation.js');

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

describe('monorepo/packages/utils', async () => {
  const { slugify } = await loadFixtureModule('monorepo/packages/utils/src/index.js');

  it('slugifies', () => {
    assert.equal(slugify('  Platform Team! '), 'platform-team');
  });
});
