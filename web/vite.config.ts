import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Default substrate port. Override with VITE_ANDES_PORT env var when running
// `tensa serve --port <N>` so dev proxy targets the right backend.
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
    // Loopback by default; set VITE_HOST=0.0.0.0 to expose the dev server on
    // your LAN (pair with `tensa serve --allow-origin http://<lan-ip>:5173`).
    host: process.env.VITE_HOST ?? '127.0.0.1',
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
    rollupOptions: {
      output: {
        // React is the biggest part of the entry chunk and changes far less
        // often than the app, so it gets a chunk of its own: the server hands
        // out hashed assets with a year-long cache lifetime, and a release that
        // only touches the app leaves this one cached. React is the only first
        // load library named here: a catch-all vendor chunk would pull the
        // libraries that the lazily loaded panels own (React Flow, uPlot,
        // Arrow) into the first load.
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return 'vendor-react';
          }
          // html-to-image is only reached by a dynamic import (a PNG export).
          // Named here because its own entry file is called ``index.js``, and a
          // second chunk called ``index-<hash>.js`` next to the app's is
          // confusing to read in the build output and in network traces.
          if (/[\\/]node_modules[\\/]html-to-image[\\/]/.test(id)) {
            return 'html-to-image';
          }
          return undefined;
        },
      },
    },
  },
});
