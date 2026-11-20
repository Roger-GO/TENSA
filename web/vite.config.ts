import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { ENTRY_CHUNK_LIMIT_KB, entryChunkLimit } from './vite-plugins/entryChunkLimit.ts';

// Default substrate port. Override with VITE_ANDES_PORT env var when running
// `tensa serve --port <N>` so dev proxy targets the right backend.
const ANDES_PORT = process.env.VITE_ANDES_PORT ?? '8000';
const ANDES_HOST = process.env.VITE_ANDES_HOST ?? '127.0.0.1';
const ANDES_TARGET = `http://${ANDES_HOST}:${ANDES_PORT}`;

// The chunk React is split into, which every visit loads and a release that
// leaves React alone keeps cached; the first load's limit leaves it out.
const REACT_CHUNK = 'vendor-react';
// The same for the library the shell lays its panels out with.
const PANELS_CHUNK = 'vendor-panels';

export default defineConfig({
  // The last one fails the build when the first load outgrows its limit.
  plugins: [
    react(),
    tailwindcss(),
    entryChunkLimit(ENTRY_CHUNK_LIMIT_KB, [REACT_CHUNK, PANELS_CHUNK]),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
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
      // The API reference (Swagger UI) and the schema it reads sit at the root,
      // outside ``/api``. The Help menu links to ``/docs``, which would otherwise
      // fall through to this dev server's own index page.
      '/docs': { target: ANDES_TARGET, changeOrigin: true, secure: false },
      '/openapi.json': { target: ANDES_TARGET, changeOrigin: true, secure: false },
    },
  },
  worker: {
    rolldownOptions: {
      // The ELK worker's script is a CommonJS module, so its bundle returns
      // the module's exports, and Rolldown warns that nothing can reach them
      // without a global name to put them under. Nothing is to: a worker
      // answers through messages.
      checks: { missingNameOptionForIifeExport: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    emptyOutDir: true,
    target: 'es2022',
    rolldownOptions: {
      // `@/api/queries` re-exports one module per domain and runs nothing of
      // its own. Unless it says so, Rolldown takes every module it re-exports
      // as a dependency of whatever imports it, and the first screen, which
      // imports a few hooks from it, would load the hooks of every panel.
      treeshake: {
        moduleSideEffects: (id) =>
          /[\\/]src[\\/]api[\\/]queries[\\/]index\.ts$/.test(id) ? false : undefined,
      },
      output: {
        codeSplitting: {
          // A group takes the modules its test matches and every module they
          // import that a group of a higher priority has not taken. React's
          // comes first, so a library built on React never takes it into its
          // own chunk.
          groups: [
            // React is the biggest part of the first load and changes far
            // less often than the app, so it gets a chunk of its own: the
            // server hands out hashed assets with a year-long cache lifetime,
            // and a release that only touches the app leaves this one cached.
            // React and the panels of the shell are the only first load
            // libraries named here: a catch-all vendor chunk would pull the
            // libraries that the lazily loaded panels own (React Flow, uPlot,
            // Arrow) into the first load.
            {
              name: REACT_CHUNK,
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 4,
            },
            // react-resizable-panels lays out the shell (the sidebar, the
            // diagram, the Inspector and the drawer), so it is on the first
            // screen and cannot wait, and it changes no more often than
            // React: a chunk of its own stays cached across releases. Version
            // 4 of it is twice the size of version 2 (50 kB), which counted
            // with the app would have taken all the room the first load had.
            {
              name: PANELS_CHUNK,
              test: /[\\/]node_modules[\\/]react-resizable-panels[\\/]/,
              priority: 3,
            },
            // React Flow, with the d3 modules it pans, zooms and drags by, is
            // a third of what the diagram loads and changes as seldom as
            // React. In a chunk of its own it stays cached across releases,
            // and the chunk of the diagram itself is the app's code alone.
            // Only the diagram imports it, so it is fetched with the diagram
            // and not before. Its stylesheet stays with the diagram's.
            {
              name: 'vendor-flow',
              test: (id) =>
                !id.endsWith('.css') &&
                /[\\/]node_modules[\\/](@xyflow[\\/](react|system)|d3-[a-z]+|classcat)[\\/]/.test(
                  id,
                ),
              priority: 3,
            },
            // html-to-image is only reached by a dynamic import (a PNG
            // export). Named here because its own entry file is called
            // ``index.js``, and a second chunk called ``index-<hash>.js`` next
            // to the app's is confusing to read in the build output and in
            // network traces.
            {
              name: 'html-to-image',
              test: /[\\/]node_modules[\\/]html-to-image[\\/]/,
              priority: 2,
            },
            // What the first screen shares with the lazily loaded parts.
            // Rolldown otherwise makes a chunk for each set of chunks that
            // share modules, and the first load came to some forty files,
            // several of them under a kilobyte; here it is one.
            {
              name: 'shared',
              tags: ['$initial'],
              minShareCount: 2,
              priority: 1,
            },
          ],
        },
      },
    },
  },
});
