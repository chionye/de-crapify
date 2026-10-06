/**
 * @typedef {'classic' | 'automatic'} JsxRuntime
 * @typedef {{ runtime: JsxRuntime, reason: string }} JsxRuntimeDecision
 */

const VITE_REACT_PLUGINS = ['@vitejs/plugin-react', '@vitejs/plugin-react-swc'];

/**
 * Decide the project's JSX runtime (spec steps 2–5; the per-file pragma is step 1, see
 * {@link resolveJsxRuntime}). When unsure, the answer is "classic": it only means the `React`
 * import is kept, which can never break code.
 *
 * @param {{ tsconfigJsx: string | null, declared: Map<string, string>, reactMajor: number | null }} input
 * @returns {JsxRuntimeDecision}
 */
export function detectProjectJsxRuntime({ tsconfigJsx, declared, reactMajor }) {
  if (tsconfigJsx === 'react') return { runtime: 'classic', reason: 'tsconfig "jsx": "react"' };
  if (tsconfigJsx === 'react-jsx' || tsconfigJsx === 'react-jsxdev') {
    return { runtime: 'automatic', reason: `tsconfig "jsx": "${tsconfigJsx}"` };
  }

  if (reactMajor !== null && reactMajor < 17) {
    return { runtime: 'classic', reason: `React ${reactMajor} (automatic runtime needs 17+)` };
  }

  if (reactMajor !== null && reactMajor >= 17) {
    if (declared.has('expo')) return { runtime: 'automatic', reason: `Expo with React ${reactMajor}` };
    if (declared.has('next')) return { runtime: 'automatic', reason: `Next.js with React ${reactMajor}` };
    // Vite's own esbuild JSX transform is classic; only the React plugins switch it to automatic.
    const vitePlugin = VITE_REACT_PLUGINS.find((p) => declared.has(p));
    if (declared.has('vite') && vitePlugin) {
      return { runtime: 'automatic', reason: `Vite (${vitePlugin}) with React ${reactMajor}` };
    }
  }

  return { runtime: 'classic', reason: 'could not determine the JSX runtime, so assuming classic, the safe choice' };
}

/**
 * A per-file `@jsxRuntime classic|automatic` pragma in a comment, or null.
 * @param {string} source
 */
export function jsxRuntimePragma(source) {
  const match = source.match(/(?:\/\/|\/\*|^\s*\*)[^\n]*@jsxRuntime\s+(classic|automatic)\b/m);
  return match ? /** @type {JsxRuntime} */ (match[1]) : null;
}

/**
 * The runtime for one file: its pragma if present, otherwise the project's.
 * @param {JsxRuntimeDecision} project
 * @param {string} source
 * @returns {JsxRuntimeDecision}
 */
export function resolveJsxRuntime(project, source) {
  const pragma = jsxRuntimePragma(source);
  return pragma ? { runtime: pragma, reason: `@jsxRuntime ${pragma} pragma` } : project;
}
