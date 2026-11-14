import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { BRAND, faviconDataUrl } from './src/brand';

// App version stamped into the build (attached to feedback so issues can be traced to a release): "0.1.0+abc1234".
const pkgVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;
const gitSha = (() => { try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } })();
const appVersion = gitSha ? `${pkgVersion}+${gitSha}` : pkgVersion;

// Fills the {{brand.*}} placeholders of index.html from src/brand.ts (title, meta tags, favicon): the name is defined in one place.
const brandHtml = (): Plugin => ({
  name: 'brand-html',
  transformIndexHtml: (html) => html.replaceAll('{{brand.name}}', BRAND.name).replaceAll('{{brand.shortName}}', BRAND.shortName).replaceAll('{{brand.tagline}}', BRAND.tagline).replaceAll('{{brand.favicon}}', faviconDataUrl()),
});

// The production build is a single self-contained index.html (works from file://),
// so the prototype can be opened by double-clicking dist/index.html.
export default defineConfig({
  base: './',
  plugins: [react(), brandHtml(), viteSingleFile()],
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  server: { port: 5173 },
  build: { target: 'es2020', chunkSizeWarningLimit: 4000 },
});
