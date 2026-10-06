import { parse } from '@babel/parser';

/** How many prose lines we're willing to trim from each end of an unfenced reply. */
const MAX_PROSE_LINES = 8;

/**
 * Get the code out of a model reply. Models often wrap code in markdown fences or add prose
 * ("Here is the cleaned-up code:") despite instructions.
 *
 * - If there are fenced blocks, take the longest one. An opening fence without a closing one
 *   (a truncated reply) takes everything after it.
 * - Otherwise, if the text doesn't parse, trim up to a few prose lines from the start and end until
 *   it does. A line only counts as prose if it reads like a sentence (see {@link isProseLine}), so
 *   code is never thrown away.
 *
 * Returns the code (trimmed), or null when nothing usable is left.
 *
 * @param {string} reply
 * @param {import('@babel/parser').ParserOptions} parserOptions
 * @returns {string | null}
 */
export function extractCode(reply, parserOptions) {
  const fenced = fencedBlocks(reply);
  let text = fenced.length > 0 ? fenced.sort((a, b) => b.length - a.length)[0] : reply;
  text = text.replace(/^\s*\n/, '').trimEnd();
  if (text.trim() === '') return null;
  if (parses(text, parserOptions)) return text.trim();
  return trimProse(text, parserOptions) ?? text.trim();
}

/**
 * Contents of ```fenced``` blocks (any language tag). An unclosed final fence runs to the end.
 * @param {string} text
 * @returns {string[]}
 */
export function fencedBlocks(text) {
  const blocks = [];
  const lines = text.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (current === null) {
        current = [];
      } else {
        blocks.push(current.join('\n'));
        current = null;
      }
    } else if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null && current.length > 0) blocks.push(current.join('\n'));
  return blocks;
}

/**
 * @param {string} text
 * @param {import('@babel/parser').ParserOptions} parserOptions
 */
function trimProse(text, parserOptions) {
  const lines = text.split('\n');
  let maxStart = 0;
  while (maxStart < Math.min(MAX_PROSE_LINES, lines.length) && isProseLine(lines[maxStart])) maxStart++;
  let maxEnd = 0;
  while (maxEnd < Math.min(MAX_PROSE_LINES, lines.length) && isProseLine(lines[lines.length - 1 - maxEnd])) maxEnd++;

  for (let start = 0; start <= maxStart; start++) {
    for (let end = 0; end <= maxEnd; end++) {
      if (start + end >= lines.length) continue;
      const candidate = lines.slice(start, lines.length - end).join('\n').trim();
      if (candidate && parses(candidate, parserOptions)) return candidate;
    }
  }
  return null;
}

const CODE_START = /^(?:(?:export|import|const|let|var|return|async|await|function|class|type|interface|enum|declare|abstract|if|for|while|switch|try|throw|yield|new|this|super)\b|\/\/|\/\*|\*|@)/;

/**
 * A blank line, or one that reads like a sentence: several words, none of `{ } ( ) ; =`, and not
 * starting with a keyword or comment marker. `Here is the cleaned-up code:` is prose; `const b`,
 * `return total` and `@observer` are not.
 * @param {string} line
 */
export function isProseLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return true;
  if (/[{}();=`]/.test(trimmed) || CODE_START.test(trimmed)) return false;
  return /\S\s+\S/.test(trimmed);
}

/**
 * If `code` has several top-level statements and exactly one of them declares `name`, return just
 * that statement (with the `//` comments directly above it). Otherwise return `code` unchanged.
 * Used to drop imports and neighbouring declarations a model echoed from the prompt.
 *
 * @param {string} code
 * @param {import('@babel/parser').ParserOptions} parserOptions
 * @param {string} name
 */
export function isolateDeclaration(code, parserOptions, name) {
  let ast;
  try {
    ast = parse(code, parserOptions);
  } catch {
    return code;
  }
  const body = ast.program.body;
  if (body.length < 2) return code;
  const matches = body.filter((statement) => declaredNamesOf(statement).join(', ') === name);
  if (matches.length !== 1) return code;
  const [statement] = matches;
  let start = /** @type {number} */ (statement.start);
  const comments = (ast.comments ?? []).filter((c) => c.type === 'CommentLine' && /** @type {number} */ (c.end) <= start).reverse();
  for (const comment of comments) {
    if (!/^[ \t]*\r?\n[ \t]*$/.test(code.slice(/** @type {number} */ (comment.end), start))) break;
    start = /** @type {number} */ (comment.start);
  }
  return code.slice(start, /** @type {number} */ (statement.end));
}

/** Names a top-level statement declares, unwrapping `export`. @param {any} statement @returns {string[]} */
function declaredNamesOf(statement) {
  let node = statement;
  if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') node = node.declaration;
  if (!node) return [];
  if (node.type === 'VariableDeclaration') return node.declarations.map((/** @type {any} */ d) => d.id?.name).filter(Boolean);
  if (node.id?.name) return [node.id.name];
  return statement.type === 'ExportDefaultDeclaration' ? ['default'] : [];
}

/** @param {string} code @param {import('@babel/parser').ParserOptions} parserOptions */
export function parses(code, parserOptions) {
  try {
    parse(code, parserOptions);
    return true;
  } catch {
    return false;
  }
}
