import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseJsonc } from './context/files.js';

/*
 * Type-checking uses the scanned project's own TypeScript, never one of ours. Two backends:
 *
 * - API (TypeScript ≤ 6): the classic compiler API, fed modified file contents in memory. Works in
 *   dry-run and write mode, and nothing touches disk.
 * - CLI (TypeScript 7+, the native compiler, which has no classic JS API): runs the project's `tsc`
 *   binary on files on disk. Only usable in write mode, where it temporarily writes each candidate
 *   version and always restores what was there. In dry-run mode it's skipped, and the summary says so.
 */

/**
 * Load the scanned project's own `typescript` package. Returns null if it isn't installed.
 * @param {string} fromDir
 * @returns {any}
 */
export function loadProjectTypeScript(fromDir) {
  try {
    const require = createRequire(path.join(fromDir, 'package.json'));
    return require(require.resolve('typescript'));
  } catch {
    return null;
  }
}

/**
 * Path of the project's `tsc` script (`typescript/bin/tsc`), or null.
 * @param {string} fromDir
 * @returns {string | null}
 */
export function resolveProjectTsc(fromDir) {
  try {
    const require = createRequire(path.join(fromDir, 'package.json'));
    const pkgPath = require.resolve('typescript/package.json');
    const bin = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).bin;
    const rel = typeof bin === 'string' ? bin : bin?.tsc;
    return rel ? path.resolve(path.dirname(pkgPath), rel) : null;
  } catch {
    return null;
  }
}

/** Whether a loaded `typescript` module has the classic in-memory compiler API. */
export function hasCompilerApi(/** @type {any} */ ts) {
  return Boolean(ts && typeof ts.createProgram === 'function' && typeof ts.getPreEmitDiagnostics === 'function');
}

/**
 * @typedef {object} Checker
 * @property {string[]} configs  Config files actually checked.
 * @property {(overrides: Map<string, string>) => Map<string, number>} errors
 *   Type errors (file|code|message → count) with some files' contents replaced.
 */

/* ------------------------------------------------------------------------------------------------ */
/* API backend                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

/**
 * @typedef {object} ConfigProject
 * @property {string} configPath
 * @property {any} parsed             ts.ParsedCommandLine
 * @property {any} [lastProgram]      Reused as `oldProgram` to speed up re-checks.
 */

/**
 * The configs to actually check for a tsconfig, using TypeScript's own config parsing. A
 * solution-style config (no input files, only `references`, like Vite's template) checks nothing,
 * so its references are used instead.
 *
 * @param {any} ts
 * @param {string} configPath
 * @returns {ConfigProject[]}
 */
export function resolveProjects(ts, configPath) {
  const parsed = parseConfig(ts, configPath);
  const refs = parsed.projectReferences ?? [];
  if (parsed.fileNames.length === 0 && refs.length > 0) {
    return refs.map((/** @type {any} */ ref) => {
      let refPath = ts.resolveProjectReferencePath ? ts.resolveProjectReferencePath(ref) : ref.path;
      if (!refPath.endsWith('.json')) refPath = path.join(refPath, 'tsconfig.json');
      return { configPath: refPath, parsed: parseConfig(ts, refPath) };
    });
  }
  return [{ configPath, parsed }];
}

/** @param {any} ts @param {string} configPath */
function parseConfig(ts, configPath) {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(`cannot read ${configPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`);
  return ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath), undefined, configPath);
}

/**
 * Type errors of one project with some files' contents replaced in memory.
 * @param {any} ts
 * @param {ConfigProject} proj
 * @param {Map<string, string>} overrides
 */
export function projectErrors(ts, proj, overrides) {
  const options = { ...proj.parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (/** @type {string} */ fileName, /** @type {any} */ languageVersion, /** @type {any[]} */ ...rest) => {
    const content = overrides.get(path.resolve(fileName));
    if (content !== undefined) return ts.createSourceFile(fileName, content, languageVersion, true);
    return getSourceFile(fileName, languageVersion, ...rest);
  };
  host.readFile = (/** @type {string} */ fileName) => overrides.get(path.resolve(fileName)) ?? readFile(fileName);

  const program = ts.createProgram({
    rootNames: proj.parsed.fileNames,
    options,
    host,
    projectReferences: proj.parsed.projectReferences,
    oldProgram: proj.lastProgram,
  });
  proj.lastProgram = program;

  /** @type {Map<string, number>} */
  const errors = new Map();
  for (const d of ts.getPreEmitDiagnostics(program)) {
    if (d.category !== ts.DiagnosticCategory.Error) continue;
    const file = d.file ? path.resolve(d.file.fileName) : '(global)';
    addError(errors, file, `TS${d.code}`, ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  }
  return errors;
}

/** @param {any} ts @param {string} configPath @returns {Checker} */
export function createApiChecker(ts, configPath) {
  const projects = resolveProjects(ts, configPath);
  return {
    configs: projects.map((p) => p.configPath),
    errors: (overrides) => mergeCounts(projects.map((p) => projectErrors(ts, p, overrides))),
  };
}

/* ------------------------------------------------------------------------------------------------ */
/* CLI backend                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The configs to check without the compiler API: the config itself, or its references when it's
 * solution-style (`"files": []`, no `include`, some `references`).
 * @param {string} configPath
 * @returns {string[]}
 */
export function cliConfigs(configPath) {
  let json;
  try {
    json = parseJsonc(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return [configPath];
  }
  const refs = Array.isArray(json?.references) ? json.references.filter((r) => typeof r?.path === 'string') : [];
  const noInputs = Array.isArray(json?.files) && json.files.length === 0 && !(Array.isArray(json.include) && json.include.length > 0);
  if (!noInputs || refs.length === 0) return [configPath];
  return refs.map((/** @type {{ path: string }} */ r) => {
    const p = path.resolve(path.dirname(configPath), r.path);
    return p.endsWith('.json') ? p : path.join(p, 'tsconfig.json');
  });
}

/**
 * Parse `tsc --pretty false` output into an error multiset.
 * Lines look like `src/a.ts(3,7): error TS2322: Type ...`, with indented continuation lines, or
 * `error TS5083: ...` for errors without a file.
 * @param {string} output
 * @param {string} cwd  Directory tsc ran in (file paths are relative to it).
 */
export function parseTscOutput(output, cwd) {
  /** @type {Map<string, number>} */
  const errors = new Map();
  /** @type {{ file: string, code: string, message: string } | null} */
  let current = null;
  const flush = () => {
    if (current) addError(errors, current.file, current.code, current.message);
    current = null;
  };
  for (const line of output.split(/\r?\n/)) {
    const located = line.match(/^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/);
    const global = line.match(/^error (TS\d+): (.*)$/);
    if (located) {
      flush();
      current = { file: path.resolve(cwd, located[1]), code: located[2], message: located[3] };
    } else if (global) {
      flush();
      current = { file: '(global)', code: global[1], message: global[2] };
    } else if (current && /^\s+\S/.test(line)) {
      current.message += `\n${line.trim()}`;
    } else {
      flush();
    }
  }
  flush();
  return errors;
}

/**
 * Runs the project's `tsc` on disk. `errors(overrides)` writes each override over the file,
 * checks, and always restores the previous content, so it's only used in write mode.
 *
 * @param {object} input
 * @param {string} input.tscPath
 * @param {string} input.configPath
 * @param {(tscPath: string, configPath: string) => string} [input.runTsc]  Injectable for tests.
 * @returns {Checker}
 */
export function createCliChecker({ tscPath, configPath, runTsc = runTscProcess }) {
  const configs = cliConfigs(configPath);
  return {
    configs,
    errors(overrides) {
      /** @type {Map<string, string | null>} */
      const saved = new Map();
      try {
        for (const [file, content] of overrides) {
          saved.set(file, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
          fs.writeFileSync(file, content);
        }
        return mergeCounts(configs.map((cfg) => parseTscOutput(runTsc(tscPath, cfg), path.dirname(cfg))));
      } finally {
        for (const [file, content] of saved) {
          if (content === null) fs.rmSync(file, { force: true });
          else fs.writeFileSync(file, content);
        }
      }
    },
  };
}

/** @param {string} tscPath @param {string} configPath */
function runTscProcess(tscPath, configPath) {
  try {
    return execFileSync(process.execPath, [tscPath, '--noEmit', '-p', configPath, '--pretty', 'false'], {
      cwd: path.dirname(configPath),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // tsc exits non-zero when there are errors; that's normal.
    const e = /** @type {any} */ (error);
    if (typeof e.stdout === 'string' && (e.stdout || e.status !== null)) return e.stdout;
    throw error;
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Orchestration                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Errors in `after` that weren't in `baseline` (counting duplicates).
 * @param {Map<string, number>} baseline
 * @param {Map<string, number>} after
 * @returns {string[]}
 */
export function newErrors(baseline, after) {
  const added = [];
  for (const [key, count] of after) {
    const extra = count - (baseline.get(key) ?? 0);
    for (let i = 0; i < extra; i++) added.push(key);
  }
  return added;
}

/**
 * @typedef {object} CheckedFile
 * @property {string} file
 * @property {string} before   Content on disk.
 * @property {string} stage1   After the deterministic rules.
 * @property {string} after    After AI cleanup (same as stage1 without AI).
 * @property {string | null} tsconfigPath  Nearest tsconfig.json, if any.
 */

/**
 * @typedef {object} TypecheckOutcome
 * @property {boolean} ran
 * @property {string} status                 One line for the summary.
 * @property {string[]} configs              Configs that were checked.
 * @property {{ file: string, revertedTo: 'stage1' | 'before', errors: string[] }[]} reverts
 */

/**
 * Check that the changed files don't introduce new type errors. Files that do are downgraded:
 * first their AI changes are dropped; if they still introduce errors, all their changes are.
 * Callers apply `reverts` to their results. Files on disk are left exactly as they were.
 *
 * @param {object} input
 * @param {CheckedFile[]} input.files            Changed files only.
 * @param {'dry-run' | 'write'} [input.mode]     The CLI backend only runs in write mode.
 * @param {string} input.cwd
 * @param {(fromDir: string) => any} [input.loadTypeScript]
 * @param {(fromDir: string) => string | null} [input.resolveTsc]
 * @param {(tscPath: string, configPath: string) => string} [input.runTsc]
 * @returns {TypecheckOutcome}
 */
export function typecheckChanges({ files, mode = 'dry-run', cwd, loadTypeScript = loadProjectTypeScript, resolveTsc = resolveProjectTsc, runTsc }) {
  const outcome = /** @type {TypecheckOutcome} */ ({ ran: false, status: '', configs: [], reverts: [] });
  if (files.length === 0) return { ...outcome, status: 'not run (no changes to check)' };
  const inTsProject = files.filter((f) => f.tsconfigPath);
  if (inTsProject.length === 0) return { ...outcome, status: 'not run (no tsconfig.json for the changed files)' };

  /** @type {Map<string, CheckedFile[]>} */
  const byConfig = new Map();
  for (const f of inTsProject) {
    const key = /** @type {string} */ (f.tsconfigPath);
    byConfig.set(key, [...(byConfig.get(key) ?? []), f]);
  }

  const missing = [];
  const skippedDryRun = [];
  for (const [configPath, group] of byConfig) {
    const dir = path.dirname(configPath);
    const ts = loadTypeScript(dir);
    /** @type {Checker | null} */
    let checker = null;
    if (hasCompilerApi(ts)) {
      checker = createApiChecker(ts, configPath);
    } else {
      const tscPath = resolveTsc(dir);
      if (!tscPath) {
        missing.push(configPath);
        continue;
      }
      if (mode !== 'write') {
        skippedDryRun.push(configPath);
        continue;
      }
      checker = createCliChecker({ tscPath, configPath, runTsc });
    }
    outcome.ran = true;
    outcome.configs.push(...checker.configs);
    checkGroup(checker, group, outcome);
  }

  const rel = (/** @type {string} */ p) => path.relative(cwd, p) || path.basename(p);
  const notes = [];
  if (skippedDryRun.length) {
    notes.push(`skipped ${skippedDryRun.map(rel).join(', ')} in dry run (TypeScript 7+ can only check files on disk; it runs with --write)`);
  }
  if (missing.length) notes.push(`skipped ${missing.map(rel).join(', ')} (TypeScript not installed)`);

  if (!outcome.ran) {
    if (skippedDryRun.length === 0) return { ...outcome, status: 'not run (TypeScript is not installed in the project)' };
    return { ...outcome, status: `not run: ${notes.join('; ')}` };
  }
  const parts = [`ran (${outcome.configs.map(rel).join(', ')})`];
  parts.push(outcome.reverts.length ? `${outcome.reverts.length} file(s) changed back because of new type errors` : 'no new errors');
  outcome.status = [...parts, ...notes].join('; ');
  return outcome;
}

/**
 * @param {Checker} checker
 * @param {CheckedFile[]} group
 * @param {TypecheckOutcome} outcome
 */
function checkGroup(checker, group, outcome) {
  const baseline = checker.errors(new Map());
  /** @type {Map<string, string>} the content each file currently ends up with */
  const current = new Map(group.map((f) => [f.file, f.after]));

  const overridesOf = (/** @type {CheckedFile[]} */ only) => {
    const map = new Map();
    for (const f of only) {
      const content = current.get(f.file);
      if (content !== undefined && content !== f.before) map.set(f.file, content);
    }
    return map;
  };
  const errorsWith = (/** @type {CheckedFile[]} */ only) => newErrors(baseline, checker.errors(overridesOf(only)));

  for (let round = 0; round <= group.length * 2; round++) {
    const changed = group.filter((f) => current.get(f.file) !== f.before);
    if (changed.length === 0) break;
    const combined = errorsWith(changed);
    if (combined.length === 0) break;

    // Find which files introduce errors on their own; if none does alone, they interact: blame all.
    const solo = new Map(changed.map((f) => [f, errorsWith([f])]));
    let offenders = changed.filter((f) => (solo.get(f) ?? []).length > 0);
    if (offenders.length === 0) offenders = changed;

    for (const f of offenders) {
      const level = current.get(f.file) === f.after && f.after !== f.stage1 ? 'stage1' : 'before';
      current.set(f.file, level === 'stage1' ? f.stage1 : f.before);
      const errors = (solo.get(f)?.length ? solo.get(f) : combined)?.map(describeError).slice(0, 3) ?? [];
      const existing = outcome.reverts.find((r) => r.file === f.file);
      if (existing) Object.assign(existing, { revertedTo: level, errors });
      else outcome.reverts.push({ file: f.file, revertedTo: level, errors });
    }
  }
}

/** @param {Map<string, number>} errors @param {string} file @param {string} code @param {string} message */
function addError(errors, file, code, message) {
  const key = `${file}|${code}|${message}`;
  errors.set(key, (errors.get(key) ?? 0) + 1);
}

/** @param {Map<string, number>[]} maps */
function mergeCounts(maps) {
  /** @type {Map<string, number>} */
  const merged = new Map();
  for (const map of maps) for (const [k, v] of map) merged.set(k, (merged.get(k) ?? 0) + v);
  return merged;
}

/** `a.ts: TS2322: Type 'string' is not assignable…` from an error key. @param {string} key */
function describeError(key) {
  const [file, code, ...message] = key.split('|');
  return `${path.basename(file)}: ${code}: ${message.join('|').split('\n')[0]}`;
}
