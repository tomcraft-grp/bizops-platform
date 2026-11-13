import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// App version stamped into the build (attached to feedback so issues can be traced to a release): "0.1.0+abc1234".
const pkgVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;
const gitSha = (() => { try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } })();
const appVersion = gitSha ? `${pkgVersion}+${gitSha}` : pkgVersion;

// The production build is a single self-contained index.html (works from file://),
// so the prototype can be opened by double-clicking dist/index.html.
export default defineConfig({
  base: './',
  plugins: [react(), viteSingleFile()],
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  server: { port: 5173 },
  build: { target: 'es2020', chunkSizeWarningLimit: 4000 },
});
