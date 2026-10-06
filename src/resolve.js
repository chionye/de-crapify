import path from 'node:path';

/** Extensions tried when an import has none (or a non-code one, like `./x.config`). */
export const CODE_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];

/** React Native platform suffixes tried before each extension: `Button` → `Button.ios.tsx`. */
export const PLATFORM_SUFFIXES = ['.ios', '.android', '.native', '.web'];

/** TypeScript ESM: a `.js` specifier may refer to a `.ts` file, and so on. */
const TS_ESM_MAP = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/** Imports with these extensions are assets: only the exact file (or RN density/platform variants) counts. */
export const ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.bmp', '.tif', '.tiff', '.heic',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.css', '.scss', '.sass', '.less', '.styl', '.pcss',
  '.json', '.json5', '.md', '.mdx', '.txt', '.html', '.csv', '.xml', '.yaml', '.yml', '.toml',
  '.graphql', '.gql', '.glsl', '.wasm', '.pdf',
  '.mp3', '.mp4', '.wav', '.webm', '.ogg', '.m4a', '.mov', '.lottie',
  '.vue', '.svelte', '.astro',
]);

/**
 * Resolve an absolute import target (without query/loader parts) to an existing file, trying the
 * extensions, platform variants, TS ESM mapping and directory index files. Returns the file found,
 * or null.
 *
 * @param {string} target  Absolute path as written in the import, resolved against its base.
 * @param {{ files: import('./context/files.js').FileCache, moduleSuffixes?: string[] }} options
 * @returns {Promise<string | null>}
 */
export async function resolveFile(target, { files, moduleSuffixes = [] }) {
  const ext = path.extname(target);
  const suffixes = [...new Set(['', ...PLATFORM_SUFFIXES, ...moduleSuffixes.filter(Boolean)])];

  if (ASSET_EXTENSIONS.has(ext.toLowerCase())) {
    const stem = target.slice(0, -ext.length);
    const candidates = [target];
    for (const suffix of suffixes) {
      // RN picks `logo@2x.png` / `logo.ios.png` for `./logo.png`.
      for (const density of ['', '@1x', '@2x', '@3x']) candidates.push(`${stem}${density}${suffix}${ext}`);
    }
    return firstFile(candidates, files);
  }

  /** @type {string[]} */
  const candidates = [target];
  const mapped = /** @type {Record<string, string[]>} */ (TS_ESM_MAP)[ext];
  if (mapped) {
    const stem = target.slice(0, -ext.length);
    for (const suffix of suffixes) for (const to of mapped) candidates.push(`${stem}${suffix}${to}`);
  }
  for (const suffix of suffixes) for (const e of CODE_EXTENSIONS) candidates.push(`${target}${suffix}${e}`);
  const direct = await firstFile(candidates, files);
  if (direct) return direct;

  if (await files.isDirectory(target)) {
    const pkg = await files.readJson(path.join(target, 'package.json'));
    if (pkg && typeof pkg === 'object') {
      for (const field of ['types', 'typings', 'module', 'main', 'react-native', 'browser']) {
        if (typeof pkg[field] === 'string') {
          const found = await resolveFile(path.resolve(target, pkg[field]), { files, moduleSuffixes });
          if (found) return found;
        }
      }
    }
    const index = [];
    for (const suffix of suffixes) for (const e of CODE_EXTENSIONS) index.push(path.join(target, `index${suffix}${e}`));
    return firstFile(index, files);
  }
  return null;
}

/**
 * Strip webpack-style loader prefixes (`raw-loader!./x`) and query strings (`./icon.svg?react`).
 * @param {string} specifier
 */
export function stripLoaderAndQuery(specifier) {
  let s = specifier;
  const bang = s.lastIndexOf('!');
  if (bang !== -1) s = s.slice(bang + 1);
  const query = s.indexOf('?');
  if (query !== -1) s = s.slice(0, query);
  return s;
}

/**
 * The package name of a bare specifier: `lodash/groupBy` → `lodash`, `@scope/pkg/x` → `@scope/pkg`.
 * @param {string} specifier
 */
export function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * The DefinitelyTyped package for a package name: `lodash` → `@types/lodash`, `@a/b` → `@types/a__b`.
 * @param {string} name
 */
export function typesPackageFor(name) {
  return name.startsWith('@') ? `@types/${name.slice(1).replace('/', '__')}` : `@types/${name}`;
}

/** @param {string[]} candidates @param {import('./context/files.js').FileCache} files */
async function firstFile(candidates, files) {
  for (const c of candidates) {
    if (await files.isFile(c)) return c;
  }
  return null;
}
