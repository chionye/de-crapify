import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { analyzeTopLevel, assignOwners, connectedGroups } from '../src/analysis/dep-graph.js';
import { GOD_FILE_LIMITS, godFileRule } from '../src/rules/god-files.js';
import { FIXTURES_DIR, parseSnippet } from './helpers.js';

/** A component of roughly `lines` lines that renders JSX and optionally uses some names. */
function component(name, lines, uses = []) {
  const body = Array.from({ length: Math.max(lines - 4, 0) }, (_, i) => `      <p>${name} line ${i}</p>`).join('\n');
  const calls = uses.map((u) => (/^[A-Z]/.test(u) ? `<${u} />` : `{${u}()}`)).join('');
  return `export function ${name}() {\n  return (\n    <div>${calls}\n${body}\n    </div>);\n}\n`;
}

function helper(name, lines = 3) {
  const body = Array.from({ length: Math.max(lines - 2, 1) }, (_, i) => `  const v${i} = ${i};`).join('\n');
  return `function ${name}() {\n${body}\n  return 1;\n}\n`;
}

async function run(source, file = 'Page.tsx') {
  const ast = await parseSnippet(source, file);
  return godFileRule({ ast, source, filePath: file }).reports;
}

describe('dependency analysis', () => {
  it('finds top-level declarations, components and references', async () => {
    const source = [
      "import { x } from 'x';",
      'export interface Props { a: string }',
      'const styles = { a: 1 };',
      'function format(v) { return x(v); }',
      'export const Card = ({ a }: Props) => <div style={styles}>{format(a)}</div>;',
      'export default function Page() { return <Card a="1" />; }',
      'const { A, B: [C] } = obj;',
      'export const Thing = memo(function Thing() { return <span />; });',
      'export const NotAComponent = makeStore();',
      'app.listen(3000);',
    ].join('\n');
    const decls = analyzeTopLevel(await parseSnippet(source, 'Page.tsx'));
    const byName = Object.fromEntries(decls.map((d) => [d.name, d]));
    assert.deepEqual(Object.keys(byName), ['Props', 'styles', 'format', 'Card', 'Page', 'A', 'Thing', 'NotAComponent']);
    assert.deepEqual(byName.A.names, ['A', 'C']);
    assert.deepEqual([...byName.Card.refs].sort(), ['Props', 'format', 'styles']);
    assert.deepEqual([...byName.Page.refs], ['Card']);
    assert.ok(byName.Card.isComponent && byName.Page.isComponent && byName.Thing.isComponent);
    assert.ok(!byName.Props.isComponent && !byName.NotAComponent.isComponent && !byName.styles.isComponent);
    assert.ok(byName.Page.defaultExport && byName.Card.exported && !byName.format.exported);
  });

  it('groups connected declarations and assigns helpers to their only user', async () => {
    const source = `${helper('a')}${helper('b')}function c() { return a() + b(); }\nfunction d() { return 1; }\nfunction e() { return d(); }\nfunction lone() {}\n`;
    const decls = analyzeTopLevel(await parseSnippet(source, 'x.ts'));
    const groups = connectedGroups(decls).map((g) => g.map((d) => d.name));
    assert.deepEqual(groups, [['a', 'b', 'c'], ['d', 'e'], ['lone']]);

    const byName = Object.fromEntries(decls.map((d) => [d.name, d]));
    const owner = assignOwners(decls, [byName.c, byName.e]);
    assert.equal(owner.get(byName.a), byName.c);
    assert.equal(owner.get(byName.d), byName.e);
    assert.equal(owner.has(byName.lone), false);
  });
});

describe('god-file rule: flags', () => {
  it('several large components, suggesting one file per component with its private helpers', async () => {
    const source = [
      helper('formatDate'),
      helper('shared'),
      component('UserCard', 50, ['formatDate', 'shared']),
      component('UserList', 45, ['UserCard', 'Settings', 'shared']),
      component('Badge', 10),
      component('Settings', 60, ['Badge']),
    ].join('\n');
    const reports = await run(source);
    assert.equal(reports.length, 1);
    const { message, type, line } = reports[0];
    assert.equal(type, 'godFile');
    assert.equal(line, 1);
    assert.match(message, /^4 React components in one file/);
    assert.match(message, /move `UserCard` and `formatDate` \(used only by `UserCard`\) to `UserCard.tsx`/);
    assert.match(message, /move `Settings` and `Badge` \(used only by `Settings`\) to `Settings.tsx`/);
    assert.match(message, /keep `UserList` here/, 'the component rendering the most others stays');
    assert.match(message, /`shared` is used by several of these/);
  });

  it('names the helpers that stay with the kept component', async () => {
    const source = `${helper('only')}\n${component('A', 50, ['only', 'B'])}\n${component('B', 50)}`;
    assert.match((await run(source))[0].message, /keep `A` and `only` \(used only by `A`\) here/);
  });

  it('keeps the default export in place', async () => {
    const source = `${component('A', 50)}\n${component('B', 50).replace('export function', 'export default function')}`;
    assert.match((await run(source))[0].message, /keep `B` here/);
  });

  it('several large unrelated groups of non-component code', async () => {
    const big = (name) => helper(name, GOD_FILE_LIMITS.GROUP_LINES + 5);
    const source = `${big('parseCsv')}${big('sendEmail')}${big('resizeImage')}`;
    const reports = await run(source, 'misc.ts');
    assert.equal(reports.length, 1);
    assert.match(reports[0].message, /3 unrelated groups/);
    assert.match(reports[0].message, /to `sendEmail.ts`/);
  });

  it('mentions file size as context only', async () => {
    const source = `${component('A', 200)}\n${component('B', 220)}`;
    assert.match((await run(source))[0].message, /; 4\d\d lines/);
  });
});

describe('god-file rule: does not flag', () => {
  it('one large component with small helpers or small sub-components', async () => {
    const source = `${component('Row', 10)}\n${component('Table', 120, ['Row'])}\n${helper('fmt')}`;
    assert.deepEqual(await run(source), []);
  });

  it('two components where only one is large', async () => {
    assert.deepEqual(await run(`${component('Big', 80)}\n${component('Small', 30)}`), []);
  });

  it('a long file that is a single component', async () => {
    assert.deepEqual(await run(component('Huge', 600)), []);
  });

  it('a utility file with many small independent helpers', async () => {
    const source = Array.from({ length: 25 }, (_, i) => `export function util${i}(x) { return x + ${i}; }\n`).join('');
    assert.deepEqual(await run(source, 'utils.ts'), []);
  });

  it('two large unrelated groups (below the threshold of three)', async () => {
    const source = `${helper('a', 80)}${helper('b', 80)}`;
    assert.deepEqual(await run(source, 'x.ts'), []);
  });

  it('large groups that share a helper (they are one group)', async () => {
    const source = `${helper('shared')}${['a', 'b', 'c'].map((n) => helper(n, 70).replace('return 1;', 'return shared();')).join('')}`;
    assert.deepEqual(await run(source, 'x.ts'), []);
  });
});

describe('god-file fixture', () => {
  it('flags Dashboard.tsx with the expected split, and not utils.ts', async () => {
    const dir = path.join(FIXTURES_DIR, 'god-file/src');
    const dashboard = await fs.readFile(path.join(dir, 'Dashboard.tsx'), 'utf8');
    const [report] = await run(dashboard, 'Dashboard.tsx');
    assert.match(report.message, /^4 React components/);
    assert.match(report.message, /move `StatsPanel` and `formatCurrency` \(used only by `StatsPanel`\) to `StatsPanel.tsx`/);
    assert.match(report.message, /move `ActivityFeed` and `timeAgo` \(used only by `ActivityFeed`\) to `ActivityFeed.tsx`/);
    assert.match(report.message, /move `SettingsForm` to `SettingsForm.tsx`/);
    assert.match(report.message, /keep `Dashboard` here/);

    const utils = await fs.readFile(path.join(dir, 'utils.ts'), 'utf8');
    assert.deepEqual(await run(utils, 'utils.ts'), []);
  });
});
