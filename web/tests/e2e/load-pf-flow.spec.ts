/**
 * Flagship v0.1 e2e test (Unit 9). Encodes the wedge-demo critical path:
 *
 *   paste token → load IEEE 14 → run PF → assert overlays + table.
 *
 * Requires a running `andes-app serve` substrate AND a Vite dev server
 * — the Playwright config's `webServer` block starts the Vite dev
 * server, but the substrate must be running independently (typically
 * on `http://127.0.0.1:8765`). Set `ANDES_TEST_TOKEN` to the value
 * from `~/.andes-app/run-<pid>.token` before running.
 *
 * The test is `test.fixme()` by default so CI runs it as expected-fail
 * until the operational glue (substrate orchestration in a fixture
 * workspace containing `ieee14.raw`) is in place. The unit tests in
 * `tests/unit/components/{inspector,pflow,sld}/` cover the same
 * surfaces in isolation; this test exists to verify the integration
 * end-to-end on a real substrate. To run locally:
 *
 *   1. cp ~/andes-project/.venv/lib/python3.12/site-packages/andes/cases/ieee14/ieee14.raw \
 *        web/tests/e2e/fixtures/
 *   2. andes-app serve --workspace web/tests/e2e/fixtures \
 *        --bind-port 8765 --bind-host 127.0.0.1
 *   3. ANDES_TEST_TOKEN=$(cat ~/.andes-app/run-<pid>.token) \
 *        E2E_NO_WEBSERVER=1 pnpm test:e2e
 *   4. Remove the `.fixme` qualifier on the test below.
 */
import { test, expect } from '@playwright/test';

test.fixme('flagship: load IEEE 14 → run PF → annotated SLD + 14-row table', async ({ page }) => {
  const token = process.env.ANDES_TEST_TOKEN;
  if (!token) throw new Error('Set ANDES_TEST_TOKEN before running this test');

  // Use the URL-fragment fast path so the modal autosubmits.
  await page.goto(`/#token=${token}`);

  // The modal should disappear after the smoke check resolves.
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10_000 });

  // Pick the workspace file and click Load.
  await page.getByRole('option', { name: 'ieee14.raw' }).click();
  await page.getByRole('button', { name: /^Load$/ }).click();

  // SLD canvas mounts; bus 1 should be visible.
  await expect(page.getByTestId('bus-node-1')).toBeVisible({ timeout: 30_000 });
  // 14-bus topology — a few sample assertions.
  for (const idx of ['1', '7', '14']) {
    await expect(page.getByTestId(`bus-node-${idx}`)).toBeVisible();
  }

  // Run PF.
  await page.getByTestId('run-pflow-button').click();

  // Success toast appears.
  await expect(page.getByTestId('pflow-success-toast')).toBeVisible({ timeout: 30_000 });
  // Overlay populated: bus voltage label visible on bus 1.
  await expect(page.getByTestId('bus-voltage-1')).toBeVisible();

  // Results table populated: 14 rows on the Buses tab.
  const buses = page.getByTestId(/^results-row-bus-/);
  await expect(buses).toHaveCount(14);
});
