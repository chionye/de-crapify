import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createProjectContext } from '../src/context/index.js';
import { findKeepRanges } from '../src/keep.js';
import { parseCode } from '../src/parse.js';
import { runDeterministicRules } from '../src/rules/index.js';
import { narratingCommentsRule, restates, splitWords, stem } from '../src/rules/narrating-comments.js';
import { nestingRules } from '../src/rules/nesting.js';
import { returnVariableRule } from '../src/rules/return-variable.js';
import { applyEdits, makeTempTree, parseSnippet, removeTree } from './helpers.js';

const dirs = [];
after(async () => {
  for (const dir of dirs) await removeTree(dir);
});

/** Run one rule once and return the new source (which must parse). */
async function once(rule, source, file = 'a.ts') {
  const ast = await parseSnippet(source, file);
  const edits = rule({ ast, source, keepRanges: findKeepRanges(ast, source) });
  const output = applyEdits(source, edits);
  assert.ok(parseCode(output, file).ok, `output must parse:\n${output}`);
  return { output, reasons: edits.map((e) => e.reason) };
}

/** The whole Stage 1 engine (all rules, repeated passes). */
async function engine(source, file = 'src/a.ts') {
  const root = await makeTempTree({ 'package.json': '{}' });
  dirs.push(root);
  const filePath = path.join(root, file);
  const context = createProjectContext({ stopDir: root });
  const ast = await parseSnippet(source, filePath);
  return runDeterministicRules({ source, ast, filePath, ctx: await context.forFile(filePath), files: context.files, options: { keepConsole: new Set(['error', 'warn']) } });
}

describe('narrating comments: removes', () => {
  const removed = async (comment, statement, file = 'a.tsx') => {
    const source = `async function f() {\n  ${comment}\n  ${statement}\n}\n`;
    const { output } = await once(narratingCommentsRule, source, file);
    return output === `async function f() {\n  ${statement}\n}\n`;
  };

  it('comments that only restate the next statement', async () => {
    const cases = [
      ['// Set loading to true', 'setLoading(true);'],
      ['// Set the errors', 'setErrors(result);'],
      ['// Return the result', 'return result;'],
      ['// State for the email field', "const [email, setEmail] = useState('');"],
      ['// Increment the count', 'count++;'],
      ['// Create a new user', 'const user = new User();'],
      ['// Call the onSubmit function', 'await onSubmit(payload);'],
      ['// Check if user is logged in', 'if (user.isLoggedIn) return;'],
      ['// Loop over the items', 'for (const item of items) process(item);'],
      ['// Throw an error', "throw new Error('bad');"],
      ['// Fetch the users', 'const users = await fetchUsers();'],
      ['// Update the name', 'name = next;'],
    ];
    for (const [comment, statement] of cases) assert.ok(await removed(comment, statement), `${comment} / ${statement}`);
  });

  it('comments above declarations that restate the name', async () => {
    const source = '// Format a price\nexport function formatPrice(cents) {\n  return cents / 100;\n}\n// UserCard component that renders a user card\nexport const UserCard = () => null;\n// Props for the card\ninterface CardProps {}\n';
    const { output, reasons } = await once(narratingCommentsRule, source, 'a.tsx');
    assert.equal(output, 'export function formatPrice(cents) {\n  return cents / 100;\n}\nexport const UserCard = () => null;\ninterface CardProps {}\n');
    assert.equal(reasons[0], 'removed narrating comment `// Format a price`');
  });

  it('class members', async () => {
    const source = 'class A {\n  // Get the name\n  getName() {\n    return this.name;\n  }\n}\n';
    assert.equal((await once(narratingCommentsRule, source)).output, 'class A {\n  getName() {\n    return this.name;\n  }\n}\n');
  });
});

describe('narrating comments: keeps', () => {
  const kept = async (source, file = 'a.ts') => (await once(narratingCommentsRule, source, file)).output === source;

  it('comments that explain, flag, link, ask, or are directives', async () => {
    const comments = [
      '// TODO: set loading to true',
      '// Set loading to true because the spinner needs it',
      '// Set loading?',
      '// See https://example.com/set-loading',
      '// @deprecated set loading',
      '// eslint-disable-next-line set-loading',
      '// NOTE set loading',
      '// Always set loading first',
      '// Set loading to true so that the spinner shows',
    ];
    for (const comment of comments) assert.ok(await kept(`function f() {\n  ${comment}\n  setLoading(true);\n}\n`), comment);
  });

  it('comments that say more than the code', async () => {
    const cases = [
      ['// Retry three times on network failure', 'retry(fetchUser);'],
      ['// Prevent the default form submission', 'event.preventDefault();'],
      ['// Sort users by age', 'function process(users) {\n    return users.sort(byAge);\n  }'],
      ['// Set loading to true while we wait for the slow server to answer us', 'setLoading(true);'],
    ];
    for (const [comment, statement] of cases) assert.ok(await kept(`function f() {\n  ${comment}\n  ${statement}\n}\n`), comment);
  });

  it('multi-line comment blocks, comments followed by a blank line, trailing and block comments', async () => {
    assert.ok(await kept('function f() {\n  // Set loading\n  // to true\n  setLoading(true);\n}\n'));
    assert.ok(await kept('function f() {\n  // Set loading to true\n\n  setLoading(true);\n}\n'));
    assert.ok(await kept('function f() {\n  a(); // Set loading to true\n  setLoading(true);\n}\n'));
    assert.ok(await kept('function f() {\n  /* Set loading to true */\n  setLoading(true);\n}\n'));
  });

  it('comments marked de-crapify-keep, or above kept code', async () => {
    assert.ok(await kept('function f() {\n  // de-crapify-keep\n  setLoading(true);\n}\n'));
  });

  it('comments made only of filler words', async () => {
    assert.ok(await kept('function f() {\n  // Create the function here\n  go();\n}\n'));
  });
});

describe('narrating comments: word matching', () => {
  it('splits camelCase and acronyms, lowercases, and stems', () => {
    assert.deepEqual(splitWords('setIsLoading HTMLParser'), ['set', 'is', 'load', 'html', 'parser']);
    assert.deepEqual(['setting', 'items', 'entries', 'loaded', 'call', 'class', 'boxes', 'fetched'].map(stem), ['set', 'item', 'entry', 'load', 'call', 'class', 'box', 'fetch']);
  });

  it('restates() needs every meaningful word in the statement', async () => {
    const ast = await parseSnippet('setLoading(true);', 'a.ts');
    assert.ok(restates(' Set loading to true', ast.program.body[0]));
    assert.ok(!restates(' Set loading to false', ast.program.body[0]));
  });
});

describe('narrating comments: with console calls (engine)', () => {
  it('removes a logging comment together with the console call below it, leaving no double blank line', async () => {
    const { output, reasons } = await engine("a();\n\n// Log the current state\nconsole.log(state);\n\nb();\n");
    assert.equal(output, 'a();\n\nb();\n');
    assert.ok(reasons.includes('removed comment `// Log the current state` with the console call below it'));
  });

  it('keeps the comment when the console call stays, or the comment is not about logging', async () => {
    assert.equal((await engine('// Log the error\nconsole.error(e);\n')).output, '// Log the error\nconsole.error(e);\n');
    assert.equal((await engine('// Restore the session first\nconsole.log(state);\n')).output, '// Restore the session first\n');
  });
});

describe('needless nesting: merges nested ifs', () => {
  it('two and three levels, re-indenting the body', async () => {
    const source = 'function f() {\n  if (a) {\n    if (b) {\n      if (c) {\n        go();\n        stop();\n      }\n    }\n  }\n}\n';
    const { output, reasons } = await once(nestingRules, source);
    assert.equal(output, 'function f() {\n  if (a && b && c) {\n    go();\n    stop();\n  }\n}\n');
    assert.deepEqual(reasons, ['merged 3 nested `if`s into `if (a && b && c)`']);
  });

  it('parenthesizes operands that bind looser than &&', async () => {
    const source = 'if (a || b) {\n  if (c ?? d) {\n    if (e ? f : g) {\n      if (x === 1 && !y) {\n        go();\n      }\n    }\n  }\n}\n';
    assert.equal((await once(nestingRules, source)).output, 'if ((a || b) && (c ?? d) && (e ? f : g) && x === 1 && !y) {\n  go();\n}\n');
  });

  it('an inner if without braces', async () => {
    assert.equal((await once(nestingRules, 'if (a) {\n  if (b) go();\n}\n')).output, 'if (a && b) go();\n');
  });

  it('collapses `else { if }` into `else if`, keeping an inner else', async () => {
    const source = 'if (a) {\n  x();\n} else {\n  if (b) {\n    y();\n  } else {\n    z();\n  }\n}\n';
    assert.equal((await once(nestingRules, source)).output, 'if (a) {\n  x();\n} else if (b) {\n  y();\n} else {\n  z();\n}\n');
  });
});

describe('needless nesting: leaves alone', () => {
  const unchanged = async (source) => assert.equal((await once(nestingRules, source)).output, source, source);

  it('ifs with an else, or with other statements in the outer block', async () => {
    await unchanged('if (a) {\n  if (b) {\n    go();\n  }\n} else {\n  other();\n}\n');
    await unchanged('if (a) {\n  if (b) {\n    go();\n  } else {\n    other();\n  }\n}\n');
    await unchanged('if (a) {\n  prepare();\n  if (b) {\n    go();\n  }\n}\n');
  });

  it('comments that the merge would drop', async () => {
    await unchanged('if (a) {\n  // only for admins\n  if (b) {\n    go();\n  }\n}\n');
    await unchanged('if (a) {\n  x();\n} else {\n  // fallback\n  if (b) {\n    y();\n  }\n}\n');
  });

  it('bodies with multi-line template literals (re-indenting would change them)', async () => {
    await unchanged('if (a) {\n  if (b) {\n    log(`line one\n    line two`);\n  }\n}\n');
  });

  it('code that does not start its own line', async () => {
    await unchanged('if (a) { if (b) { go(); } }\n');
  });
});

describe('unneeded else after return/throw', () => {
  it('moves the else body out and re-indents it', async () => {
    const source = 'function f(a) {\n  if (a) {\n    return 1;\n  } else {\n    const b = 2;\n    if (b) {\n      go();\n    }\n    return b;\n  }\n}\n';
    const { output, reasons } = await once(nestingRules, source);
    assert.equal(output, 'function f(a) {\n  if (a) {\n    return 1;\n  }\n  const b = 2;\n  if (b) {\n    go();\n  }\n  return b;\n}\n');
    assert.deepEqual(reasons, ['removed unneeded `else` after `return`']);
  });

  it('splits an else-if chain, and handles throw and brace-less branches', async () => {
    assert.equal(
      (await once(nestingRules, 'function f(a) {\n  if (a) {\n    throw new Error();\n  } else if (b) {\n    go();\n  }\n}\n')).output,
      'function f(a) {\n  if (a) {\n    throw new Error();\n  }\n  if (b) {\n    go();\n  }\n}\n',
    );
    assert.equal((await once(nestingRules, 'function f(a) {\n  if (a) return 1;\n  else {\n    go();\n  }\n}\n')).output, 'function f(a) {\n  if (a) return 1;\n  go();\n}\n');
  });

  it('single-line and empty else bodies', async () => {
    assert.equal((await once(nestingRules, 'function f(a) {\n  if (a) {\n    return 1;\n  } else { go(); }\n}\n')).output, 'function f(a) {\n  if (a) {\n    return 1;\n  }\n  go();\n}\n');
    assert.equal((await once(nestingRules, 'function f(a) {\n  if (a) {\n    return 1;\n  } else {\n  }\n}\n')).output, 'function f(a) {\n  if (a) {\n    return 1;\n  }\n}\n');
  });

  it('leaves alone: branches that may fall through, else-if links, and comments between branches', async () => {
    const unchanged = async (source) => assert.equal((await once(nestingRules, source)).output, source, source);
    await unchanged('function f(a) {\n  if (a) {\n    go();\n  } else {\n    stop();\n  }\n}\n');
    await unchanged('function f(a) {\n  if (a) {\n    if (b) return 1;\n  } else {\n    stop();\n  }\n}\n');
    await unchanged('function f(a) {\n  if (a) {\n    return 1;\n  } // otherwise\n  else {\n    stop();\n  }\n}\n');
  });

  it('leaves alone: lifted names that clash with or would shadow other names', async () => {
    const unchanged = async (source) => assert.equal((await once(nestingRules, source)).output, source, source);
    // `b` is a parameter: lifting `const b` would redeclare it.
    await unchanged('function f(a, b) {\n  if (a) {\n    return 1;\n  } else {\n    const b = 2;\n    return b;\n  }\n}\n');
    // `status` is used later in the block (a global): lifting `const status` would shadow it.
    await unchanged('function f(a) {\n  if (a) {\n    return 1;\n  } else {\n    const status = 2;\n    use(status);\n  }\n  report(status);\n}\n');
    // Function declarations in blocks have legacy hoisting rules.
    await unchanged('function f(a) {\n  if (a) {\n    return 1;\n  } else {\n    function g() {}\n    g();\n  }\n}\n');
  });
});

describe('redundant return variable', () => {
  it('returns the value directly (const and never-reassigned let)', async () => {
    const source = 'function f() {\n  const result = compute(a, b);\n  return result;\n}\nfunction g() {\n  let total = a + b;\n  return total;\n}\n';
    const { output, reasons } = await once(returnVariableRule, source);
    assert.equal(output, 'function f() {\n  return compute(a, b);\n}\nfunction g() {\n  return a + b;\n}\n');
    assert.equal(reasons[0], 'returned `compute(a, b)` directly instead of through `result`');
  });

  it('keeps the parentheses of a multi-line JSX value', async () => {
    const source = 'function C() {\n  const el = (\n    <div>\n      hi\n    </div>\n  );\n  return el;\n}\n';
    assert.equal((await once(returnVariableRule, source, 'a.tsx')).output, 'function C() {\n  return (\n    <div>\n      hi\n    </div>\n  );\n}\n');
  });

  it('works without semicolons', async () => {
    assert.equal((await once(returnVariableRule, 'function f() {\n  const x = go()\n  return x\n}\n')).output, 'function f() {\n  return go()\n}\n');
  });

  it('leaves alone: annotated, reused, reassigned, separated, or commented', async () => {
    const unchanged = async (source) => assert.equal((await once(returnVariableRule, source)).output, source, source);
    await unchanged('function f() {\n  const x: number = go();\n  return x;\n}\n');
    await unchanged('function f() {\n  const x = go();\n  log(x);\n  return x;\n}\n');
    await unchanged('function f() {\n  let x = go();\n  x = x + 1;\n  return x;\n}\n');
    await unchanged('function f() {\n  const x = go();\n  // the cached value\n  return x;\n}\n');
    await unchanged('function f() {\n  const x = go(), y = 1;\n  return x;\n}\n');
    await unchanged('function f() {\n  const { x } = go();\n  return x;\n}\n');
    await unchanged('function f() {\n  const x = go();\n  return x + 1;\n}\n');
  });
});

describe('structural passes (engine)', () => {
  it('repeats until nothing changes: removing an else exposes a merge', async () => {
    const source = 'export function f(a: boolean, b: boolean) {\n  if (!a) {\n    return 0;\n  } else {\n    if (b) {\n      if (a) {\n        go();\n      }\n    }\n  }\n  return 1;\n}\n';
    const { output, reasons } = await engine(source);
    assert.equal(output, 'export function f(a: boolean, b: boolean) {\n  if (!a) {\n    return 0;\n  }\n  if (b && a) {\n    go();\n  }\n  return 1;\n}\n');
    assert.deepEqual(reasons, ['removed unneeded `else` after `return`', 'merged 2 nested `if`s into `if (b && a)`']);
  });

  it('never touches de-crapify-keep code', async () => {
    const source = '// de-crapify-keep\nexport function f(a: boolean, b: boolean) {\n  // Set loading to true\n  setLoading(true);\n  if (a) {\n    if (b) {\n      go();\n    }\n  }\n  const r = x();\n  return r;\n}\n';
    assert.equal((await engine(source)).output, source);
  });

  it('counts a reason only for edits that were applied, in the pass that applied them', async () => {
    // The comment only restates the code once `result` is folded into `return compute();`.
    const { output, reasons } = await engine('export function f() {\n  // Return the result\n  const result = compute();\n  return result;\n}\n');
    assert.equal(output, 'export function f() {\n  return compute();\n}\n');
    assert.deepEqual(reasons, ['returned `compute()` directly instead of through `result`', 'removed narrating comment `// Return the result`']);
  });
});
