import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findKeepRanges } from '../src/keep.js';
import { consoleCallsRule, isSideEffectFree } from '../src/rules/console-calls.js';
import { applyEdits, parseSnippet } from './helpers.js';

const KEEP_DEFAULT = new Set(['error', 'warn']);

async function run(source, { keepConsole = KEEP_DEFAULT, file = 'a.tsx' } = {}) {
  const ast = await parseSnippet(source, file);
  const result = consoleCallsRule({ ast, source, keepConsole, keepRanges: findKeepRanges(ast, source) });
  return { ...result, output: applyEdits(source, result.edits) };
}

describe('console rule: removes', () => {
  it('standalone debug calls, as whole lines', async () => {
    const source = `function f(x) {\n  console.log('x', x);\n  console.debug(x);\n  console.info(\`v=\${x}\`);\n  console.trace();\n  console.dir(x, { depth: 2 });\n  console.table([x]);\n  return x;\n}\n`;
    const { output, reasons, reports } = await run(source);
    assert.equal(output, 'function f(x) {\n  return x;\n}\n');
    assert.equal(reasons.length, 6);
    assert.equal(reports.length, 0);
    assert.equal(reasons[0], "removed `console.log('x', x)`");
  });

  it('calls at the top level and in switch cases and static blocks', async () => {
    const source = `console.log('boot');\nswitch (a) {\n  case 1:\n    console.log(a);\n    break;\n}\nclass C { static { console.log('init'); } }\n`;
    const { output } = await run(source);
    assert.equal(output, 'switch (a) {\n  case 1:\n    break;\n}\nclass C { static { } }\n');
  });

  it('a call sharing its line with other code, leaving that code intact', async () => {
    const { output } = await run('const a = 1; console.log(a);\nfoo(); console.log(1); bar();\n');
    assert.equal(output, 'const a = 1;\nfoo(); bar();\n');
  });

  it('calls with safe arguments: members, spreads, objects, arrays, operators, TS casts', async () => {
    const source = [
      'console.log(user.name, user["id"], ...items);',
      'console.log({ a, b: c.d, ...rest }, [1, x, ...ys]);',
      "console.log('total: ' + n, !ok, typeof v, a ?? b, a ? b : c);",
      'console.log(value as string, other!, <T>x);',
      '',
    ].join('\n');
    const { output, reports } = await run(source, { file: 'a.ts' });
    assert.equal(reports.length, 0, JSON.stringify(reports));
    assert.equal(output, '');
  });

  it('CRLF line endings', async () => {
    const { output } = await run('a();\r\nconsole.log(1);\r\nb();\r\n');
    assert.equal(output, 'a();\r\nb();\r\n');
  });

  it("console['log'](...) with a string literal key", async () => {
    const { output } = await run("console['log']('x');\n");
    assert.equal(output, '');
  });
});

describe('console rule: never removes', () => {
  it('methods in --keep-console (default error, warn) or not debug methods', async () => {
    const source = "console.error('e');\nconsole.warn('w');\nconsole.group('g');\nconsole.time('t');\nconsole.assert(x);\n";
    const { output, reports } = await run(source);
    assert.equal(output, source);
    assert.equal(reports.length, 0, 'not reported either');
  });

  it('methods added to --keep-console', async () => {
    const source = "console.info('i');\nconsole.log('l');\n";
    const { output } = await run(source, { keepConsole: new Set(['info']) });
    assert.equal(output, "console.info('i');\n");
  });

  it('removes error/warn too when --keep-console is empty? no: only debug methods are ever removed', async () => {
    const source = "console.error('e');\n";
    assert.equal((await run(source, { keepConsole: new Set() })).output, source);
  });

  it('a call whose arguments may have side effects (reports it)', async () => {
    const cases = [
      'console.log(fetchUser());',
      'console.log(new Date());',
      'console.log(x++);',
      'console.log(x = 1);',
      'console.log(await load());',
      'console.log(tag`x`);',
      'console.log(`${f()}`);',
      'console.log({ [k()]: 1 });',
      'console.log(() => 1);',
      'console.log(delete o.x);',
      'console.log(a.b());',
    ];
    for (const line of cases) {
      const source = `async function f() {\n  ${line}\n}\n`;
      const { output, reports } = await run(source);
      assert.equal(output, source, line);
      assert.equal(reports.length, 1, line);
      assert.match(reports[0].message, /side effects/, line);
      assert.equal(reports[0].line, 2);
      assert.equal(reports[0].type, 'unsafeConsole');
    }
  });

  it('the body of a brace-less if/else/for/while/do (reports it)', async () => {
    const cases = [
      'if (debug) console.log(x);',
      'if (a) run(); else console.log(x);',
      'for (const i of xs) console.log(i);',
      'for (;;) console.log(1);',
      'while (a) console.log(a);',
      'do console.log(a); while (a);',
      'label: console.log(1);',
    ];
    for (const code of cases) {
      const source = `${code}\nnext();\n`;
      const { output, reports } = await run(source);
      assert.equal(output, source, code);
      assert.equal(reports.length, 1, code);
      assert.match(reports[0].message, /brace-less/, code);
    }
  });

  it('the body of an arrow function without braces (reports it)', async () => {
    const source = "const el = <Button onPress={() => console.log('pressed')} />;\n";
    const { output, reports } = await run(source);
    assert.equal(output, source);
    assert.match(reports[0].message, /arrow function without braces/);
  });

  it('a call that is part of a larger expression (reports it)', async () => {
    for (const code of ['debug && console.log(x);', 'const r = console.log(x);', 'foo(console.log(x));', 'a, console.log(x);']) {
      const { output, reports } = await run(`${code}\n`);
      assert.equal(output, `${code}\n`, code);
      assert.equal(reports.length, 1, code);
      assert.match(reports[0].message, /larger expression/, code);
    }
  });

  it('calls on a local `console` binding', async () => {
    const cases = [
      'function f(console) { console.log(1); }',
      "import console from './logger';\nconsole.log(1);",
      'const console = makeLogger();\nconsole.log(1);',
    ];
    for (const source of cases) {
      const { output, reports } = await run(`${source}\n`);
      assert.equal(output, `${source}\n`, source);
      assert.equal(reports.length, 0, source);
    }
  });

  it('calls inside a de-crapify-keep statement (and does not report them)', async () => {
    const source = `// de-crapify-keep\nfunction dump(x) {\n  console.log(x);\n  console.log(f());\n}\nconsole.log('gone');\n`;
    const { output, reports } = await run(source);
    assert.equal(output, `// de-crapify-keep\nfunction dump(x) {\n  console.log(x);\n  console.log(f());\n}\n`);
    assert.equal(reports.length, 0);
  });

  it('a call with a trailing keep comment', async () => {
    const source = "console.log('keep me'); // de-crapify-keep\nconsole.log('remove me');\n";
    assert.equal((await run(source)).output, source, 'the trailing marker protects its own line and the next statement');
  });

  it('other objects with a log method, or window.console', async () => {
    const source = "logger.log('x');\nwindow.console.log('x');\nconsole.log.apply(console, args);\n";
    const { output, reports } = await run(source);
    assert.equal(output, source);
    assert.equal(reports.length, 0);
  });
});

describe('isSideEffectFree', () => {
  it('accepts literals of every kind', async () => {
    const ast = await parseSnippet('f("s", 1, true, null, 10n, /re/, this);', 'a.js');
    const call = /** @type {any} */ (ast.program.body[0]).expression;
    assert.ok(call.arguments.every(isSideEffectFree));
  });
});

describe('console rule: ifs emptied by the removal', () => {
  it('removes an if that only contained removed console calls (and its comments)', async () => {
    const source = "a();\nif (__DEV__) {\n  // debug output\n  console.log('dev');\n  console.debug(state);\n}\nb();\n";
    const { output, reasons } = await run(source);
    assert.equal(output, 'a();\nb();\n');
    assert.equal(reasons.at(-1), 'removed `if (__DEV__)`, which only contained debug logging');
  });

  it('collapses nested ifs bottom-up', async () => {
    const source = "function f() {\n  if (debug) {\n    if (verbose) {\n      console.log('v');\n    }\n    console.log('d');\n  }\n  return 1;\n}\n";
    assert.equal((await run(source)).output, 'function f() {\n  return 1;\n}\n');
  });

  it('keeps the if when anything else is in it, it has an else, or the condition has side effects', async () => {
    const cases = [
      ["if (a) {\n  console.log(1);\n  work();\n}\n", 'if (a) {\n  work();\n}\n'],
      ["if (a) {\n  console.log(1);\n} else {\n  other();\n}\n", 'if (a) {\n} else {\n  other();\n}\n'],
      ["if (check()) {\n  console.log(1);\n}\n", 'if (check()) {\n}\n'],
      ["if (a) {\n  console.log(f());\n}\n", "if (a) {\n  console.log(f());\n}\n"],
    ];
    for (const [input, expected] of cases) assert.equal((await run(input)).output, expected, input);
  });

  it('never removes an if that was already empty, or one in an else-if chain', async () => {
    assert.equal((await run('if (a) {}\n')).output, 'if (a) {}\n');
    assert.equal((await run("if (a) {\n  x();\n} else if (b) {\n  console.log(1);\n}\n")).output, 'if (a) {\n  x();\n} else if (b) {\n}\n');
  });

  it('never removes a kept if', async () => {
    const source = "// de-crapify-keep\nif (a) {\n  console.log(1);\n}\n";
    assert.equal((await run(source)).output, source);
  });
});

describe('console rule: blank lines', () => {
  it('does not leave a double blank line where removed code separated two blank lines', async () => {
    assert.equal((await run("a();\n\nconsole.log(1);\n\nb();\n")).output, 'a();\n\nb();\n');
    assert.equal((await run("a();\n\nconsole.log(1);\nb();\n")).output, 'a();\n\nb();\n', 'a single blank line stays');
  });
});
