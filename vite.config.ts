import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const cloudflareRocketLoaderGuard = {
  name: 'cloudflare-rocket-loader-guard',
  transformIndexHtml: {
    order: 'post' as const,
    handler: (html: string) => html.replace(/<script type="module"(?![^>]*data-cfasync)/g, '<script type="module" data-cfasync="false"'),
  },
};

export default defineConfig({
  plugins: [react(), cloudflareRocketLoaderGuard, {
    name: 'version-offline-shell',
    closeBundle() {
      const html = readFileSync('dist/index.html', 'utf8');
      const worker = readFileSync('public/sw.js', 'utf8');
      const version = createHash('sha256').update(html).update(worker).digest('hex').slice(0, 16);
      writeFileSync('dist/sw.js', worker.replace('__BUILD_ID__', version));
    },
  }],
  server: {
    allowedHosts: ['.trycloudflare.com'],
  },
});
