import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const cloudflareRocketLoaderGuard = {
  name: 'cloudflare-rocket-loader-guard',
  transformIndexHtml: {
    order: 'post' as const,
    handler: (html: string) => html.replace(/<script type="module"(?![^>]*data-cfasync)/g, '<script type="module" data-cfasync="false"'),
  },
};

export default defineConfig({
  plugins: [react(), cloudflareRocketLoaderGuard],
  server: {
    allowedHosts: ['.trycloudflare.com'],
  },
});
