import path from 'node:path';
import { analyzeTopLevel, assignOwners, connectedGroups } from '../analysis/dep-graph.js';

/** Thresholds for the god-file rule. False alarms are costly here, so they lean conservative. */
export const GOD_FILE_LIMITS = Object.freeze({
  /** A component counts as "large" above this many lines. */
  COMPONENT_LINES: 40,
  /** Flag when at least this many large components share a file. */
  LARGE_COMPONENTS: 2,
  /** A group of related declarations counts as "large" above this many lines. */
  GROUP_LINES: 60,
  /** Flag when at least this many large, unrelated groups share a file. */
  LARGE_GROUPS: 3,
  /** Mentioned as context (never a reason on its own). */
  LONG_FILE_LINES: 400,
});

/**
 * Rule 4 (report only): files that cram several components or unrelated modules together, with a
 * suggested split from plain dependency analysis.
 *
 * @param {{ ast: import('@babel/types').File, source: string, filePath: string }} input
 * @returns {{ reports: import('./shared.js').RuleReport[] }}
 */
export function godFileRule({ ast, source, filePath }) {
  const decls = analyzeTopLevel(ast);
  const totalLines = source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
  const ext = path.extname(filePath);

  const components = decls.filter((d) => d.isComponent);
  const largeComponents = components.filter((d) => d.lines > GOD_FILE_LIMITS.COMPONENT_LINES);
  if (components.length > 1 && largeComponents.length >= GOD_FILE_LIMITS.LARGE_COMPONENTS) {
    const stay = pickComponentToKeep(components);
    const mains = [...new Set([stay, ...largeComponents])];
    const summary = components
      .slice()
      .sort((a, b) => b.lines - a.lines)
      .map((c) => `${c.name} ${c.lines} lines`)
      .join(', ');
    const message = [
      `${components.length} React components in one file (${summary})${contextNote(totalLines, decls.length)}.`,
      'Suggested split:',
      ...splitSuggestion(decls, mains, stay, ext),
    ].join('\n');
    return { reports: [{ type: 'godFile', line: 1, message }] };
  }

  const groups = connectedGroups(decls).map((members) => ({
    members,
    lines: members.reduce((sum, d) => sum + d.lines, 0),
    lead: members.slice().sort((a, b) => b.lines - a.lines)[0],
  }));
  const largeGroups = groups.filter((g) => g.lines > GOD_FILE_LIMITS.GROUP_LINES);
  if (largeGroups.length >= GOD_FILE_LIMITS.LARGE_GROUPS) {
    const stayGroup = largeGroups.find((g) => g.members.some((d) => d.defaultExport)) ?? largeGroups.slice().sort((a, b) => b.lines - a.lines)[0];
    const lines = [];
    for (const group of largeGroups) {
      if (group === stayGroup) continue;
      lines.push(`  - move ${nameList(group.members.map((d) => d.name))} to \`${group.lead.name}${ext}\``);
    }
    lines.push(`  - keep ${nameList(stayGroup.members.map((d) => d.name))} here`);
    const message = [
      `${largeGroups.length} unrelated groups of code in one file (${largeGroups.map((g) => `${g.lead.name}… ${g.lines} lines`).join(', ')})${contextNote(totalLines, decls.length)}.`,
      'Suggested split:',
      ...lines,
    ].join('\n');
    return { reports: [{ type: 'godFile', line: 1, message }] };
  }

  return { reports: [] };
}

/**
 * The component that stays: the default export, else the one rendering the most other components,
 * else the largest.
 * @param {import('../analysis/dep-graph.js').TopLevelDecl[]} components
 */
function pickComponentToKeep(components) {
  const defaultExport = components.find((c) => c.defaultExport);
  if (defaultExport) return defaultExport;
  const componentNames = new Set(components.map((c) => c.name));
  const score = (/** @type {import('../analysis/dep-graph.js').TopLevelDecl} */ c) => [...c.refs].filter((r) => componentNames.has(r)).length;
  return components.slice().sort((a, b) => score(b) - score(a) || b.lines - a.lines)[0];
}

/**
 * @param {import('../analysis/dep-graph.js').TopLevelDecl[]} decls
 * @param {import('../analysis/dep-graph.js').TopLevelDecl[]} mains
 * @param {import('../analysis/dep-graph.js').TopLevelDecl} stay
 * @param {string} ext
 */
function splitSuggestion(decls, mains, stay, ext) {
  const owner = assignOwners(decls, mains);
  const lines = [];
  for (const main of mains) {
    if (main === stay) continue;
    const helpers = decls.filter((d) => d !== main && owner.get(d) === main).map((d) => d.name);
    const helperText = helpers.length ? ` and ${nameList(helpers)} (used only by \`${main.name}\`)` : '';
    lines.push(`  - move \`${main.name}\`${helperText} to \`${main.name}${ext}\``);
  }
  const stayHelpers = decls.filter((d) => d !== stay && owner.get(d) === stay).map((d) => d.name);
  const stayText = stayHelpers.length ? ` and ${nameList(stayHelpers)} (used only by \`${stay.name}\`)` : '';
  lines.push(`  - keep \`${stay.name}\`${stayText} here`);

  const shared = decls.filter((d) => !owner.has(d) && usedByMoreThanOneMain(d, decls, owner));
  if (shared.length) {
    lines.push(`  - ${nameList(shared.map((d) => d.name))} ${shared.length === 1 ? 'is' : 'are'} used by several of these; consider a shared module`);
  }
  return lines;
}

/**
 * @param {import('../analysis/dep-graph.js').TopLevelDecl} decl
 * @param {import('../analysis/dep-graph.js').TopLevelDecl[]} decls
 * @param {Map<import('../analysis/dep-graph.js').TopLevelDecl, import('../analysis/dep-graph.js').TopLevelDecl>} owner
 */
function usedByMoreThanOneMain(decl, decls, owner) {
  const owners = new Set();
  for (const user of decls) {
    if (user.refs.has(decl.name) && owner.has(user)) owners.add(owner.get(user));
  }
  return owners.size > 1;
}

/** @param {number} totalLines @param {number} declCount */
function contextNote(totalLines, declCount) {
  const notes = [];
  if (totalLines > GOD_FILE_LIMITS.LONG_FILE_LINES) notes.push(`${totalLines} lines`);
  if (declCount > 10) notes.push(`${declCount} top-level declarations`);
  return notes.length ? `; ${notes.join(', ')}` : '';
}

/** `a`, `b` and `c` @param {string[]} names */
function nameList(names) {
  const quoted = names.map((n) => `\`${n}\``);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}
