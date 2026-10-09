import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
    // A timeout is a guard against a test that never ends; it says nothing
    // about speed, and what a test is to hold of speed it holds as work (the
    // steps of the router, say). Vitest's default of five seconds suits a
    // fast machine: CI runs the suite with coverage on, which makes the
    // routing of a diagram four to five times slower, on a runner of a few
    // cores, and ten tests of the diagram came within half of the five
    // seconds there (two went past them). The rule is that no test needs
    // more than a quarter of its timeout on such a runner, whether that is
    // this default or one a long test sets for itself. `taskset -c 0,1 pnpm
    // test:coverage --reporter=verbose` shows what each takes on two cores.
    testTimeout: 30_000,
    // Used by `pnpm test:coverage`. CI prints the text summary and uploads
    // coverage/ (HTML report + lcov) as a build artifact; no external service.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/main.tsx', 'src/api/generated.ts'],
    },
  },
});
