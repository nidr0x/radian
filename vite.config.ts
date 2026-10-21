import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const cloudflareRocketLoaderGuard = {
  name: 'cloudflare-rocket-loader-guard',
  transformIndexHtml: {
    order: 'post' as const,
    handler: (html: string) => html.replace(/<script type="module"(?![^>]*data-cfasync)/g, '<script type="module" data-cfasync="false"'),
  },
};

/**
 * Files in dist that must never be precached:
 * - `_headers` / `_redirects`: Cloudflare Pages platform files, not shell assets; a failed fetch
 *   against them would reject the whole install via addAll.
 * - `sw.js`: the worker itself, Cache-Control: no-cache and versioned by its own marker.
 * - `index.html`: the shell is precached once as `/` during install, not by its file path.
 * - `exercises/atlas-*.png`: legacy duplicates of the shipped atlas `.webp` art (~2 MB each);
 *   keeping them out preserves the previous install payload.
 */
const neverPrecached = (file: string): boolean =>
  file === '_headers' || file === '_redirects' || file === 'sw.js' || file === 'index.html' || (file.startsWith('exercises/atlas-') && file.endsWith('.png'));

const collectDistFiles = (dir: string, base = ''): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? collectDistFiles(join(dir, entry.name), `${base}${entry.name}/`)
    : [`${base}${entry.name}`]);

export const buildPrecacheManifest = (distDir: string): { precache: string[]; excluded: string[] } => {
  const files = collectDistFiles(distDir);
  const excluded = files.filter(neverPrecached);
  const precache = ['/', ...files.filter((file) => !neverPrecached(file)).map((file) => `/${file}`).sort()];
  return { precache, excluded };
};

export default defineConfig({
  plugins: [react(), cloudflareRocketLoaderGuard, {
    name: 'version-offline-shell',
    closeBundle() {
      // Vitest pulls this config in for buildPrecacheManifest and its bundling triggers closeBundle; skip stamping there.
      if (process.env.VITEST) return;
      if (!existsSync('dist/index.html')) {
        throw new Error('[version-offline-shell] dist/index.html not found: the offline shell cannot be stamped. Run the build from the repository root and ensure index.html sits next to vite.config.ts.');
      }
      const html = readFileSync('dist/index.html', 'utf8');
      const worker = readFileSync('public/sw.js', 'utf8');
      if (!worker.includes('__BUILD_ID__') || !worker.includes('"__PRECACHE_MANIFEST__"')) {
        throw new Error('[version-offline-shell] public/sw.js is missing its __BUILD_ID__ or "__PRECACHE_MANIFEST__" marker: restore the placeholders before building.');
      }
      const { precache, excluded } = buildPrecacheManifest('dist');
      if (excluded.length > 0) {
        console.warn(`[version-offline-shell] excluded from precache (see neverPrecached in vite.config.ts): ${excluded.join(', ')}`);
      }
      const version = createHash('sha256').update(html).update(worker).digest('hex').slice(0, 16);
      writeFileSync('dist/sw.js', worker
        .replace('__BUILD_ID__', () => version)
        .replace('"__PRECACHE_MANIFEST__"', () => JSON.stringify(precache)));
    },
  }],
  server: {
    allowedHosts: ['.trycloudflare.com'],
  },
});
