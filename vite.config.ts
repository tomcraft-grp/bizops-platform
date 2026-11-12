import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The production build is a single self-contained index.html (works from file://),
// so the prototype can be opened by double-clicking dist/index.html.
export default defineConfig({
  base: './',
  plugins: [react(), viteSingleFile()],
  server: { port: 5173 },
  build: { target: 'es2020', chunkSizeWarningLimit: 4000 },
});
