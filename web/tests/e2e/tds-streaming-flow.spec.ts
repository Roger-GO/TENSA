/**
 * Flagship v0.2 e2e test (Unit 8). Encodes the wedge-demo critical path
 * for TDS streaming:
 *
 *   load IEEE 14 → switch to DisturbancePanel → add a fault → switch to
 *   TdsConfigPanel → set tf=2 + vars=[bus_v, gen_state] → click Run TDS →
 *   watch frames stream into the plot → click abort mid-run → verify
 *   aborted state.
 *
 * It runs against a real substrate. The unit tests in
 * ``tests/unit/components/{tds,plots,disturbance,shell}/`` cover the same
 * surfaces in isolation; this test exists to verify the integration
 * end-to-end.
 *
 * Skipped with ``test.fixme`` until it is ported. It was written against the
 * first UI (an auth-token modal and a file-picker form). The UI has no
 * authentication now and loads cases from the "Saved cases" list, so the
 * selectors below no longer match. ``load-pf-flow.spec.ts`` shows the current
 * way to open a case, and ``playwright.config.ts`` how to start the substrate.
 *
 * Manual smoke equivalent: walk the same steps in the UI; assert that the
 * run status badge shows "Aborted at t=…" and the plot panel retains the
 * partial trace.
 */
import { test, expect } from './fixtures';

test.fixme('flagship: load IEEE 14 → fault at t=1 → run TDS → abort mid-run → verify aborted state', async ({
  page,
}) => {
  await page.goto('/');

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

  // Switch to Analyze panel → TDS sub-mode (TDS config form moved
  // here in Unit 6 per KTD-6), set tf=2, enable gen_state.
  await page.getByTestId('panel-picker-tab-analyze').click();
  await page.getByTestId('analyze-sub-mode-tds').click();
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
});
