import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the e2e tests in `tests/e2e/`.
 *
 * The tests drive the real UI against a real `tensa serve`: nothing is mocked,
 * and there is no authentication to set up. What a run needs is a substrate to
 * talk to. Start it on a fresh workspace and the server seeds it with the
 * example cases the flagship test opens (`ieee14_full.xlsx`).
 *
 * Two ways to run them, from `web/`:
 *
 * 1. Against the built UI, served by the substrate itself. This is what CI does
 *    (`.github/workflows/web.yml`, job `e2e`): one server, one origin, and the
 *    same bundle a user gets from `pip install tensa`.
 *
 *      pnpm build
 *      tensa serve --port 8765 --workspace "$(mktemp -d)" --max-sessions 32
 *      E2E_BASE_URL=http://127.0.0.1:8765 E2E_NO_WEBSERVER=1 pnpm test:e2e
 *
 * 2. Against the Vite dev server, which the `webServer` block below starts. It
 *    proxies `/api` to the substrate (port 8000 unless `VITE_ANDES_PORT` says
 *    otherwise), and the substrate has to accept the dev server's origin.
 *
 *      tensa serve --port 8000 --workspace "$(mktemp -d)" --max-sessions 32 \
 *        --allow-origin http://127.0.0.1:5173
 *      pnpm test:e2e
 *
 * Every page load opens a session that stays for as long as its tab is open and
 * then idles out (three minutes by default), and the default cap is 4. Past that
 * the UI cannot open a case. The specs take `test` from `tests/e2e/fixtures.ts`,
 * which ends the sessions a test's pages opened once the test is over, so the
 * suite holds a few at a time; the commands above raise the cap for the tests
 * that hold several at once and for a run that is interrupted.
 *
 * If the port is taken, `tensa serve` says so and stops. Use another one: the
 * tests would otherwise run against whatever is listening there.
 *
 * The first load of a case generates ANDES code for its models, so the timeouts
 * below are generous for a cold cache.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 120_000,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
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
  // E2E_NO_WEBSERVER is for mode 1, where something else already serves the UI.
  webServer: process.env.E2E_NO_WEBSERVER
    ? undefined
    : {
        command: 'pnpm dev',
        port: 5173,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
});
