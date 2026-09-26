import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173 },
  build: { outDir: 'dist', target: 'es2020', assetsInlineLimit: 0 }
});
