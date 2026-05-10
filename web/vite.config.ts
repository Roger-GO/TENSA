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
      // Forward API calls to the substrate. The substrate mounts every
      // router under ``/api/*`` (Unit 10), so we forward the prefix as-is
      // — no rewrite.
      '/api': {
        target: ANDES_TARGET,
        changeOrigin: true,
        secure: false,
      },
      // WebSocket proxy for TDS streaming (v0.2). The substrate mounts the
      // WS router at ``/api/ws/{session_id}``, but the browser opens the
      // socket at the page-origin path ``/ws/{id}`` — we rewrite to add
      // the ``/api`` prefix so RunStream can use the same relative-URL
      // convention as the HTTP client (where ``/api`` is baked into
      // ``API_PREFIX`` in ``client.ts``).
      '/ws': {
        target: ANDES_TARGET,
        changeOrigin: true,
        ws: true,
        secure: false,
        rewrite: (p: string) => `/api${p}`,
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
