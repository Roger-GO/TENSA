import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Default substrate port. Override with VITE_ANDES_PORT env var when running
// `andes-app serve --port <N>` so dev proxy targets the right backend.
const ANDES_PORT = process.env.VITE_ANDES_PORT ?? '8000';
const ANDES_HOST = process.env.VITE_ANDES_HOST ?? '127.0.0.1';
const ANDES_TARGET = `http://${ANDES_HOST}:${ANDES_PORT}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // Forward API calls to the substrate. The substrate's routes are
      // mounted under `/api/*` (Unit 10 wheel-bundling adds the prefix).
      // For now, the substrate routes are at root paths; the rewrite below
      // strips `/api` so dev clients can use `/api/*` without backend changes.
      '/api': {
        target: ANDES_TARGET,
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/ws': {
        target: ANDES_TARGET,
        changeOrigin: true,
        ws: true,
        secure: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    emptyOutDir: true,
    target: 'es2022',
  },
});
