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
      // router under ``/api/*`` (Unit 10), so we forward the prefix as-is.
      // ``ws: true`` upgrades + forwards the WebSocket endpoints under
      // ``/api/ws/...`` (the TDS run stream, ``/jobs/events``, and
      // ``/sweep/{id}``) through this SINGLE proxy. All stream clients connect
      // to the real ``/api/ws/...`` path (consistent dev + prod). The previous
      // separate ``/ws`` rewrite proxy did not reliably apply its path rewrite
      // on the WS upgrade, so TDS streaming silently hung in dev.
      '/api': {
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
