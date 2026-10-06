import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStats, formatSummary, recordAiRejection, reportCounts, totalAiRejected } from '../src/output/summary.js';
import { plainChalk } from './helpers.js';

const CWD = '/proj';

function filledStats() {
  const stats = createStats();
  stats.filesScanned = 12;
  stats.filesChanged = 3;
  stats.deterministicFixes = 7;
  stats.aiAccepted = 2;
  recordAiRejection(stats, 'invented identifier `formatUser`');
  recordAiRejection(stats, 'hook order changed');
  recordAiRejection(stats, 'hook order changed');
  stats.reports.push(
    { type: 'hallucinatedImport', file: '/proj/src/api.js', line: 3, message: "'react-super-forms' is not installed" },
    { type: 'unsafeConsole', file: '/proj/src/a.js', line: 9, message: 'console.log(fetchUser())' },
    { type: 'unsafeConsole', file: '/proj/src/b.js', line: 1, message: 'console.log(x++)' },
  );
  stats.skipped.push(
    { file: '/proj/src/vendor.min.js', reason: 'minified' },
    { file: '/proj/src/broken.js', reason: 'could not parse' },
  );
  stats.aiStatus = 'qwen2.5-coder:7b';
  stats.typecheckStatus = 'ran (tsconfig.app.json, tsconfig.node.json)';
  return stats;
}

describe('summary counters', () => {
  it('counts AI rejections by reason', () => {
    const stats = filledStats();
    assert.equal(totalAiRejected(stats), 3);
    assert.equal(stats.aiRejected.get('hook order changed'), 2);
  });

  it('counts reports by type, including zero counts', () => {
    assert.deepEqual(reportCounts(filledStats()), {
      hallucinatedImport: 1,
      unverifiedImport: 0,
      unsafeConsole: 2,
      godFile: 0,
    });
  });
});

describe('formatSummary', () => {
  it('shows every required line', () => {
    const text = formatSummary(filledStats(), { chalk: plainChalk, cwd: CWD });
    const expectRow = (label, value) => assert.match(text, new RegExp(`${label}\\s+${value}\\b`), label);
    expectRow('Files scanned', 12);
    expectRow('Files with changes', 3);
    expectRow('Deterministic fixes', 7);
    expectRow('AI fixes accepted', 2);
    expectRow('AI suggestions rejected', 3);
    assert.match(text, /2 × hook order changed/);
    assert.match(text, /1 × invented identifier `formatUser`/);
    expectRow('Likely hallucinated imports', 1);
    expectRow('Imports that could not be verified', 0);
    expectRow('Console calls not safe to remove', 2);
    expectRow('God files', 0);
    expectRow('Files skipped', 2);
    assert.match(text, /1 minified: src\/vendor\.min\.js/);
    assert.match(text, /1 could not parse: src\/broken\.js/);
    assert.match(text, /AI\s+qwen2\.5-coder:7b/);
    assert.match(text, /Typecheck\s+ran \(tsconfig\.app\.json, tsconfig\.node\.json\)/);
  });

  it('says "Files changed" in write mode', () => {
    assert.match(formatSummary(filledStats(), { chalk: plainChalk, cwd: CWD, write: true }), /Files changed\s+3/);
  });

  it('truncates long skipped lists unless verbose', () => {
    const stats = createStats();
    for (let i = 0; i < 8; i++) stats.skipped.push({ file: `/proj/f${i}.js`, reason: 'too large' });
    const short = formatSummary(stats, { chalk: plainChalk, cwd: CWD });
    assert.match(short, /8 too large: f0\.js, f1\.js, f2\.js, f3\.js, f4\.js, and 3 more/);
    const full = formatSummary(stats, { chalk: plainChalk, cwd: CWD, verbose: true });
    assert.match(full, /f7\.js/);
    assert.doesNotMatch(full, /more/);
  });

  it('lists reverted files only when there are some', () => {
    const stats = createStats();
    assert.doesNotMatch(formatSummary(stats, { chalk: plainChalk, cwd: CWD }), /reverted/);
    stats.reverted.push({ file: '/proj/a.ts', reason: 'new type errors' });
    assert.match(formatSummary(stats, { chalk: plainChalk, cwd: CWD }), /a\.ts: new type errors/);
  });

  it('keeps values aligned in one column', () => {
    const text = formatSummary(filledStats(), { chalk: plainChalk, cwd: CWD });
    // Rows are "  <label><padding><value>"; the value always starts after at least two spaces.
    const valueStarts = text
      .split('\n')
      .filter((l) => /^ {2}\S/.test(l))
      .map((l) => l.match(/^ {2}.*?\S {2,}/)?.[0].length);
    assert.ok(valueStarts.length > 10);
    assert.equal(new Set(valueStarts).size, 1, `values start at different columns: ${valueStarts}`);
  });
});
