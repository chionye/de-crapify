import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chalk } from 'chalk';

/** Chalk with colors off, for asserting on plain text. */
export const plainChalk = new Chalk({ level: 0 });
/** Chalk forced to basic ANSI colors, for asserting that colors are applied. */
export const colorChalk = new Chalk({ level: 1 });

/**
 * Create a temp directory populated from a `{ 'relative/path': 'content' }` map.
 * Returns the directory's real path (macOS /var → /private/var symlink resolved).
 *
 * @param {Record<string, string>} files
 */
export async function makeTempTree(files = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'de-crapify-test-')));
  await writeTree(dir, files);
  return dir;
}

/** @param {string} dir @param {Record<string, string>} files */
export async function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

/** @param {string} dir */
export async function removeTree(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

export const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** @param {string} dir */
export function gitInit(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
}

/** Collects output lines written through a RunIO. */
export function captureIO(cwd, chalk = plainChalk) {
  const out = [];
  const err = [];
  return {
    io: { out: (t) => out.push(t), err: (t) => err.push(t), chalk, cwd },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}

export const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures');

/**
 * Copy a fixture project into a fresh temp directory (so lookups that walk up the tree can't reach
 * de-crapify's own package.json / node_modules). Returns the copy's path.
 * @param {string} name
 */
export async function copyFixture(name) {
  const dir = await makeTempTree();
  const dest = path.join(dir, name);
  await fs.cp(path.join(FIXTURES_DIR, name), dest, { recursive: true });
  return dest;
}

/**
 * Create a fake installed package at `<dir>/node_modules/<name>` with the given package.json fields
 * and extra files.
 * @param {string} dir
 * @param {string} name
 * @param {Record<string, any>} [pkg]
 * @param {Record<string, string>} [files]
 */
export async function fakeInstall(dir, name, pkg = {}, files = {}) {
  const pkgDir = path.join(dir, 'node_modules', name);
  await writeTree(pkgDir, { 'package.json': JSON.stringify({ name, version: '1.0.0', ...pkg }), ...files });
  return pkgDir;
}

/**
 * Parse a snippet the way de-crapify would for `filePath` (extension picks the parser plugins).
 * Throws if it doesn't parse, so a broken test input fails loudly.
 * @param {string} source
 * @param {string} [filePath]
 */
export async function parseSnippet(source, filePath = 'snippet.tsx') {
  const { parseCode } = await import('../src/parse.js');
  const result = parseCode(source, filePath);
  if (!result.ok) throw result.error;
  return result.ast;
}

/**
 * Apply edits (removals, or replacements when `text` is set) to a source string, as the rules
 * engine does with magic-string. Edits must not overlap.
 * @param {string} source
 * @param {{ start: number, end: number, text?: string }[]} edits
 */
export function applyEdits(source, edits) {
  let out = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + (edit.text ?? '') + out.slice(edit.end);
  return out;
}

/** The line in our user message after which the chunk's code starts. */
const CODE_MARKER = 'Clean up this declaration and return only the code:\n\n';

/** The code a test "model" was asked to clean up (from the user message). @param {string} user */
export function codeFromPrompt(user) {
  const at = user.indexOf(CODE_MARKER);
  return at === -1 ? '' : user.slice(at + CODE_MARKER.length);
}

/**
 * A fake model that removes whole-line `//` comments, except directives and keep markers.
 * @param {string} code
 */
export function removeNarratingComments(code) {
  return code
    .split('\n')
    .filter((line) => !/^\s*\/\/(?!\s*(@ts-|eslint-|de-crapify-))/.test(line))
    .join('\n');
}

/**
 * A fetch that behaves like an Ollama server.
 * @param {object} [options]
 * @param {string[]} [options.models]  Installed models for /api/tags.
 * @param {(code: string, request: any) => string | { content: string, done_reason?: string } | Error} [options.reply]
 *   Builds the reply for each /api/chat call; return an Error to make that request fail.
 */
export function mockOllamaFetch({ models = ['qwen2.5-coder:7b'], reply = (code) => code } = {}) {
  /** @type {{ url: string, body: any }[]} */
  const calls = [];
  /** @type {typeof globalThis.fetch} */
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: models.map((name) => ({ name, model: name })) }), { status: 200 });
    }
    if (String(url).endsWith('/api/chat')) {
      const user = body.messages.find((m) => m.role === 'user').content;
      const out = reply(codeFromPrompt(user), body);
      if (out instanceof Error) throw out;
      const { content, done_reason = 'stop' } = typeof out === 'string' ? { content: out } : out;
      return new Response(JSON.stringify({ model: body.model, message: { role: 'assistant', content }, done: true, done_reason }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch, calls };
}
