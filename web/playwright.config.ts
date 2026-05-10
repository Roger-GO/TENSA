import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for v0.1 e2e tests.
 *
 * The flagship test (`tests/e2e/load-pf-flow.spec.ts`, lands in Unit 9)
 * exercises: paste token → load IEEE 14 → run PF → assert overlays + table.
 * Requires the substrate to be running; orchestration of `andes-app serve`
 * happens in CI (`.github/workflows/web.yml`) — locally, the developer
 * starts the substrate manually before running e2e.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html']] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.E2E_NO_WEBSERVER
    ? undefined
    : {
        command: 'pnpm dev',
        port: 5173,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
});
