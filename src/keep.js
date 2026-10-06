import { traverse } from './rules/shared.js';

const KEEP_COMMENT = /^\s*de-crapify-keep\b/;

/** Node types a keep marker can protect: statements/declarations and class/object members. */
function isProtectable(path) {
  return (
    path.isStatement() ||
    path.isClassMethod() ||
    path.isClassPrivateMethod() ||
    path.isClassProperty() ||
    path.isClassPrivateProperty() ||
    path.isClassAccessorProperty() ||
    path.isTSDeclareMethod() ||
    path.isObjectProperty() ||
    path.isObjectMethod()
  );
}

/**
 * Source ranges protected by `// de-crapify-keep` (or `/* de-crapify-keep *\/`) comments.
 * Nothing inside a protected range may be changed by any rule or the AI.
 *
 * A marker protects the statement that directly follows it (only whitespace or other comments in
 * between). A marker at the end of a line (`console.log(x); // de-crapify-keep`) also protects the
 * statement it trails, since that's what people usually mean by it.
 *
 * @param {import('@babel/types').File} ast
 * @param {string} source
 * @returns {import('./rules/shared.js').Range[]}
 */
export function findKeepRanges(ast, source) {
  const markers = (ast.comments ?? []).filter((c) => KEEP_COMMENT.test(c.value));
  if (markers.length === 0) return [];

  /** @type {{ start: number, end: number }[]} */
  const nodes = [];
  traverse(ast, {
    enter(path) {
      if (isProtectable(path) && path.node.start != null && path.node.end != null) {
        nodes.push({ start: path.node.start, end: path.node.end });
      }
    },
  });

  /** @type {import('./rules/shared.js').Range[]} */
  const ranges = [];
  for (const marker of markers) {
    const markerStart = /** @type {number} */ (marker.start);
    const markerEnd = /** @type {number} */ (marker.end);

    // The statement right after the marker: the outermost node starting at the first code position.
    const next = firstCodePosition(source, markerEnd, ast.comments ?? []);
    let following = null;
    for (const node of nodes) {
      if (node.start === next && (!following || node.end > following.end)) following = node;
    }
    if (following) ranges.push({ start: markerStart, end: following.end });

    // A trailing marker: code before it on the same line.
    const lineStart = source.lastIndexOf('\n', markerStart - 1) + 1;
    if (/\S/.test(source.slice(lineStart, markerStart))) {
      let trailed = null;
      for (const node of nodes) {
        const endsOnMarkerLine = node.end <= markerStart && !source.slice(node.end, markerStart).includes('\n');
        if (endsOnMarkerLine && (!trailed || node.start < trailed.start)) trailed = node;
      }
      if (trailed) ranges.push({ start: trailed.start, end: markerEnd });
    }
  }
  return ranges;
}

/**
 * Index of the first character after `from` that isn't whitespace or part of a comment.
 * @param {string} source
 * @param {number} from
 * @param {import('@babel/types').Comment[]} comments
 */
function firstCodePosition(source, from, comments) {
  let i = from;
  while (i < source.length) {
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }
    const comment = comments.find((c) => c.start === i);
    if (comment) {
      i = /** @type {number} */ (comment.end);
      continue;
    }
    break;
  }
  return i;
}
