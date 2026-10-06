import { lineAwareRange, preview, walkNodes } from './shared.js';

/** Words that carry no information in a comment. */
const STOPWORDS = new Set(
  'a an the to of for in on at by with from and or is are be been this that these those it its if then else into as we our all each every some any when which what is was will can should'.split(' '),
);

/**
 * Generic words AI-written comments pad with ("Create the result variable"). They don't need to
 * appear in the code for the comment to count as narration.
 */
const GENERIC = new Set(
  'value values variable variables field fields function functions method methods result results data object array list new current given initial create creates initialize init define declare check call calls compute calculate store use make component components render renders state helper new handler handle logic code here now based'.split(' '),
);

/** Comments that say WHY, flag something, or are tooling directives: never removed. */
const KEEP_PATTERNS = [
  /\b(TODO|FIXME|HACK|NOTE|XXX|BUG|SAFETY|WARNING|WARN|IMPORTANT|NB)\b/,
  /@/,
  /https?:\/\//,
  /\?/,
  /\b(because|why|since|otherwise|workaround|so that|in order|unless|until|must|never|always|careful|beware|instead|caveat|assume|assumes|hack)\b/i,
  /^\s*(eslint|prettier|istanbul|c8|ts-|tslint|jshint|global |de-crapify)/i,
];

const MAX_WORDS = 10;

/**
 * Rule 5: remove a single `//` comment line that only restates the statement right below it, e.g.
 * `// Set loading to true` above `setLoading(true)`. Deliberately conservative: when in doubt, the
 * comment stays.
 *
 * @param {{ ast: import('@babel/types').File, source: string, keepRanges: import('./shared.js').Range[] }} input
 * @returns {import('./shared.js').Edit[]}
 */
export function narratingCommentsRule({ ast, source, keepRanges }) {
  const statements = statementsByStart(ast);
  /** @type {import('./shared.js').Edit[]} */
  const edits = [];
  for (const comment of ast.comments ?? []) {
    const target = commentTarget(comment, source, statements);
    if (!target || keepRanges.some((r) => r.start <= /** @type {number} */ (comment.start) && r.end >= /** @type {number} */ (comment.end))) continue;
    if (!restates(comment.value, target)) continue;
    edits.push({ ...lineAwareRange(source, /** @type {number} */ (comment.start), /** @type {number} */ (comment.end)), reason: `removed narrating comment \`// ${preview(comment.value, 50)}\`` });
  }
  return edits;
}

/**
 * Comments about logging directly above console calls that Rule 2 removes, e.g. `// Log the state`.
 *
 * @param {object} input
 * @param {import('@babel/types').File} input.ast
 * @param {string} input.source
 * @param {import('./shared.js').Edit[]} input.removed   The console rule's removals (whole lines).
 * @param {import('./shared.js').Range[]} input.keepRanges
 * @returns {import('./shared.js').Edit[]}
 */
export function loggingCommentEdits({ ast, source, removed, keepRanges }) {
  /** @type {import('./shared.js').Edit[]} */
  const edits = [];
  for (const comment of ast.comments ?? []) {
    if (comment.type !== 'CommentLine' || !isAloneOnLine(comment, source) || isInCommentBlock(comment, source)) continue;
    const lineEnd = source.indexOf('\n', /** @type {number} */ (comment.end));
    if (lineEnd === -1 || !removed.some((r) => r.start === lineEnd + 1)) continue;
    if (keepRanges.some((r) => r.start <= /** @type {number} */ (comment.start) && r.end >= /** @type {number} */ (comment.end))) continue;
    if (KEEP_PATTERNS.some((p) => p.test(comment.value))) continue;
    if (!/\b(log|logs|logging|debug|debugging|print|prints|console|output|trace|dump)\b/i.test(comment.value)) continue;
    edits.push({ ...lineAwareRange(source, /** @type {number} */ (comment.start), /** @type {number} */ (comment.end)), reason: `removed comment \`// ${preview(comment.value, 50)}\` with the console call below it` });
  }
  return edits;
}

/**
 * Whether every meaningful word of the comment appears in the statement's words.
 * @param {string} text
 * @param {import('@babel/types').Node} statement
 */
export function restates(text, statement) {
  if (KEEP_PATTERNS.some((p) => p.test(text))) return false;
  const words = splitWords(text);
  if (words.length === 0 || words.length > MAX_WORDS) return false;
  const content = words.filter((w) => !STOPWORDS.has(w) && !GENERIC.has(w));
  if (content.length === 0) return false;
  const available = statementWords(statement);
  return content.every((w) => available.has(w));
}

/**
 * Words of a piece of text or identifier, camelCase split, lowercased, stemmed.
 * `setIsLoading` → set, is, load; `HTMLParser` → html, parser.
 * @param {string} text
 */
export function splitWords(text) {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(stem);
}

/** Very small stemmer: folds plurals and -ing/-ed so "loading"/"load", "items"/"item" match. @param {string} word */
export function stem(word) {
  let w = word;
  let suffixRemoved = false;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith('ing')) [w, suffixRemoved] = [w.slice(0, -3), true];
  else if (w.length > 3 && w.endsWith('ed')) [w, suffixRemoved] = [w.slice(0, -2), true];
  else if (w.length > 3 && /(xes|ches|shes)$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  // "setting" → "sett" → "set", but "call" stays "call".
  if (suffixRemoved && w.length > 2 && /([b-df-hj-np-tv-z])\1$/.test(w)) w = w.slice(0, -1);
  return w;
}

/**
 * The words a comment may restate, from the "head" of the statement: for a declaration of a
 * function, just its name; for an `if` or loop, its condition or header; for anything else, the
 * whole statement (identifiers, string contents, and keywords like `return` or `throw`).
 * @param {import('@babel/types').Node} statement
 */
export function statementWords(statement) {
  const words = new Set();
  const addText = (/** @type {string} */ t) => {
    for (const w of splitWords(t)) words.add(w);
  };
  const addNode = (/** @type {any} */ node) =>
    walkNodes(node, (n) => {
      if (isFunctionLike(n)) return false; // a callback's body isn't what a one-line comment describes
      if (n.type === 'Identifier' || n.type === 'JSXIdentifier' || n.type === 'PrivateName') addText(n.name ?? n.id?.name ?? '');
      else if (n.type === 'StringLiteral') addText(n.value);
      else if (n.type === 'TemplateElement') addText(n.value.cooked ?? '');
      else if (n.type === 'BooleanLiteral') words.add(String(n.value));
      else if (n.type === 'NullLiteral') words.add('null');
      else if (n.type === 'NumericLiteral') words.add(String(n.value));
      else if (n.type === 'AwaitExpression') addText('await wait');
      else if (n.type === 'NewExpression') addText('new create');
      else if (n.type === 'AssignmentExpression') addText('set assign update');
      else if (n.type === 'UpdateExpression') addText(n.operator === '++' ? 'increment increase add' : 'decrement decrease');
    });

  let node = /** @type {any} */ (statement);
  if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
    addText('export');
    node = node.declaration ?? node;
  }
  switch (node.type) {
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
    case 'TSInterfaceDeclaration':
    case 'TSTypeAliasDeclaration':
    case 'TSEnumDeclaration':
    case 'ClassMethod':
    case 'ClassProperty':
    case 'ClassPrivateMethod':
    case 'ClassPrivateProperty':
      if (node.id) addNode(node.id);
      if (node.key) addNode(node.key);
      if (node.type === 'ClassProperty' && node.value && !isFunctionLike(node.value)) addNode(node.value);
      break;
    case 'VariableDeclaration':
      for (const d of node.declarations) {
        addNode(d.id);
        if (d.init) addNode(d.init);
      }
      break;
    case 'IfStatement':
      addText('if');
      addNode(node.test);
      break;
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
      addText('for loop iterate each over while');
      for (const key of ['init', 'test', 'update', 'left', 'right']) if (node[key]) addNode(node[key]);
      break;
    case 'ReturnStatement':
      addText('return');
      if (node.argument) addNode(node.argument);
      break;
    case 'ThrowStatement':
      addText('throw error');
      addNode(node.argument);
      break;
    case 'SwitchStatement':
      addText('switch');
      addNode(node.discriminant);
      break;
    case 'ExpressionStatement':
      addNode(node.expression);
      break;
    default:
      break;
  }
  return words;
}

/** @param {any} n */
function isFunctionLike(n) {
  return n && ['ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression', 'ClassBody', 'BlockStatement'].includes(n.type);
}

/**
 * The statement a comment sits directly above, or null if the comment isn't a lone `//` line
 * followed immediately (no blank line) by the start of a statement.
 * @param {import('@babel/types').Comment} comment
 * @param {string} source
 * @param {Map<number, import('@babel/types').Node>} statements
 */
function commentTarget(comment, source, statements) {
  if (comment.type !== 'CommentLine' || !isAloneOnLine(comment, source) || isInCommentBlock(comment, source)) return null;
  const lineEnd = source.indexOf('\n', /** @type {number} */ (comment.end));
  if (lineEnd === -1) return null;
  let next = lineEnd + 1;
  while (next < source.length && (source[next] === ' ' || source[next] === '\t')) next++;
  if (source[next] === '\n' || source[next] === '\r' || source.startsWith('//', next) || source.startsWith('/*', next)) return null;
  return statements.get(next) ?? null;
}

/** @param {import('@babel/types').Comment} comment @param {string} source */
function isAloneOnLine(comment, source) {
  const lineStart = source.lastIndexOf('\n', /** @type {number} */ (comment.start) - 1) + 1;
  return source.slice(lineStart, comment.start).trim() === '';
}

/** Part of a multi-line `//` comment block (the line above is also a comment): an explanation, keep it. */
function isInCommentBlock(/** @type {import('@babel/types').Comment} */ comment, /** @type {string} */ source) {
  const lineStart = source.lastIndexOf('\n', /** @type {number} */ (comment.start) - 1) + 1;
  if (lineStart === 0) return false;
  const prevStart = source.lastIndexOf('\n', lineStart - 2) + 1;
  return source.slice(prevStart, lineStart - 1).trim().startsWith('//');
}

/**
 * Statements and class members by start position (the outermost one when several start together).
 * @param {import('@babel/types').File} ast
 */
function statementsByStart(ast) {
  /** @type {Map<number, any>} */
  const map = new Map();
  walkNodes(ast.program, (n) => {
    const isStatement = /Statement$|Declaration$/.test(n.type) || ['ClassMethod', 'ClassProperty', 'ClassPrivateMethod', 'ClassPrivateProperty'].includes(n.type);
    if (isStatement && typeof n.start === 'number' && !map.has(n.start) && n.type !== 'BlockStatement') map.set(n.start, n);
  });
  return map;
}
