/**
 * Flagship v0.2 e2e test (Unit 8). Encodes the wedge-demo critical path
 * for TDS streaming:
 *
 *   paste token → load IEEE 14 → switch to DisturbancePanel → add a
 *   fault → switch to TdsConfigPanel → set tf=2 + vars=[bus_v,
 *   gen_state] → click Run TDS → watch frames stream into the plot →
 *   click abort mid-run → verify aborted state.
 *
 * Requires a running ``andes-app serve`` substrate AND a Vite dev
 * server. The Playwright config's ``webServer`` block starts the Vite
 * dev server, but the substrate must be running independently
 * (typically on ``http://127.0.0.1:8765``). Set ``ANDES_TEST_TOKEN`` to
 * the value from ``~/.andes-app/run-<pid>.token`` before running.
 *
 * The test is ``test.fixme()`` by default so CI runs it as expected-fail
 * until the operational glue (substrate orchestration in a fixture
 * workspace containing ``ieee14.raw``) is in place. The unit tests in
 * ``tests/unit/components/{tds,plots,disturbance,shell}/`` cover the
 * same surfaces in isolation; this test exists to verify the
 * integration end-to-end on a real substrate. To run locally:
 *
 *   1. cp ~/andes-project/.venv/lib/python3.12/site-packages/andes/cases/ieee14/ieee14.raw \
 *        web/tests/e2e/fixtures/
 *   2. andes-app serve --workspace web/tests/e2e/fixtures \
 *        --bind-port 8765 --bind-host 127.0.0.1
 *   3. ANDES_TEST_TOKEN=$(cat ~/.andes-app/run-<pid>.token) \
 *        E2E_NO_WEBSERVER=1 pnpm test:e2e
 *   4. Remove the ``.fixme`` qualifier on the test below.
 *
 * Manual smoke equivalent (when Playwright orchestration isn't
 * available): walk the same steps in the dev UI; assert that the run
 * status badge shows "Aborted at t=…" and the plot panel retains the
 * partial trace.
 */
import { test, expect } from '@playwright/test';

test.fixme(
  'flagship: load IEEE 14 → fault at t=1 → run TDS → abort mid-run → verify aborted state',
  async ({ page }) => {
    const token = process.env.ANDES_TEST_TOKEN;
    if (!token) throw new Error('Set ANDES_TEST_TOKEN before running this test');

    // URL-fragment fast path so the auth modal autosubmits.
    await page.goto(`/#token=${token}`);
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10_000 });

    // Load IEEE 14 from the workspace.
    await page.getByRole('option', { name: 'ieee14.raw' }).click();
    await page.getByRole('button', { name: /^Load$/ }).click();
    await expect(page.getByTestId('bus-node-1')).toBeVisible({ timeout: 30_000 });

    // Switch the right-dock top region to the DisturbancePanel.
    await page.getByTestId('panel-picker-tab-disturbance').click();
    await expect(page.getByTestId('disturbance-panel')).toBeVisible();

    // Add a fault on bus 4 at t=1, cleared at t=1.1.
    await page.getByTestId('add-disturbance-button').click();
    const dialog = page.getByTestId('add-event-dialog');
    await expect(dialog).toBeVisible();
    // Default kind is Fault — fill the fields.
    await dialog.getByTestId('field-fault-tf').fill('1');
    await dialog.getByTestId('field-fault-tc').fill('1.1');
    // Pick bus 4 from the dropdown (component-specific selector; the test
    // is fixme-gated until the fixture is wired).
    await dialog.getByLabel(/^Bus$/).selectOption('4');
    await dialog.getByTestId('add-event-save').click();
    await expect(dialog).not.toBeVisible();

    // Switch to TdsConfigPanel, set tf=2, enable gen_state.
    await page.getByTestId('panel-picker-tab-tds-config').click();
    await expect(page.getByTestId('tds-config-panel')).toBeVisible();
    const tfField = page.getByTestId('field-tds-config-tf');
    await tfField.fill('2');
    await page.getByTestId('tds-config-var-gen_state').check();

    // Click Run TDS.
    await page.getByTestId('run-tds-button').click();

    // App auto-switches to the Plot panel when the run starts.
    await expect(page.getByTestId('plot-panel-content')).toBeVisible({ timeout: 10_000 });
    // Status badge reflects streaming.
    await expect(page.getByTestId('run-status-badge')).toContainText(/streaming/i, {
      timeout: 10_000,
    });
    // At least one chart group rendered.
    await expect(page.getByTestId('time-series-plot')).toBeVisible();

    // Mid-run abort.
    await page.getByTestId('run-tds-button').click();
    await expect(page.getByTestId('run-status-badge')).toContainText(/aborted/i, {
      timeout: 30_000,
    });

    // Reset back to idle so a follow-on run is possible.
    await page.getByTestId('run-tds-button').click();
    await expect(page.getByTestId('run-tds-button')).toHaveText(/run tds/i);
  },
);
