/**
 * Flagship e2e test: the shortest path from an empty workspace to a result.
 *
 *   open the app -> load IEEE 14 -> run PF -> SLD overlay + Buses table
 *
 * It drives the real UI against a real `tensa serve` (nothing is mocked), so it
 * is the one test that checks the UI, the HTTP API, the worker process and ANDES
 * agree with each other. `playwright.config.ts` says how to start the substrate.
 * There is no authentication to set up. A fresh workspace is seeded with
 * `ieee14_full.xlsx` when the server starts, so the test needs no fixtures. The
 * unit tests under `tests/unit/` cover the same components in isolation.
 */
import { test, expect, type Page } from '@playwright/test';

const CASE_FILE = 'ieee14_full.xlsx';
const BUS_COUNT = 14;

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';

/** The V (pu) cell of a Buses table row, found by its column so a new column moves nothing. */
function busVoltageCell(page: Page, busIdx: number) {
  return page.getByTestId(`buses-grid-cell-${busIdx}-v`);
}

test.beforeEach(async ({ page }) => {
  // A fresh browser profile gets a floating coach card next to the case list.
  // Dismiss it up front so every run starts from the same screen.
  await page.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, 'dismissed');
    } catch {
      // Storage unavailable: the coach shows, which does not block the test.
    }
  }, FIRST_RUN_COACH_KEY);
});

test('flagship: load IEEE 14 -> run PF -> annotated SLD + 14-row buses table', async ({ page }) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));

  await page.goto('/');

  // Nothing is loaded yet, so there is nothing to run.
  const runPf = page.getByTestId('run-pflow-button');
  await expect(runPf).toBeDisabled();

  // ---- load the case ------------------------------------------------------
  // The UI opens its session in the background after the first paint, and a
  // click on a case before that does nothing. Click until the case request
  // actually goes out (a click that did nothing times out and tries again).
  const caseRow = page.getByTestId(`saved-cases-row-${CASE_FILE}`);
  await expect(caseRow).toBeVisible();
  await expect(async () => {
    await Promise.all([
      page.waitForRequest(
        (request) =>
          request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/case'),
        { timeout: 2_000 },
      ),
      caseRow.click(),
    ]);
  }).toPass({ timeout: 30_000 });

  // The first load generates ANDES code for the models in the case, which is
  // slow on a cold cache.
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(BUS_COUNT, { timeout: 90_000 });
  await expect(runPf).toBeEnabled();

  // Before PF the table lists every bus but has no voltages to show.
  await expect(page.getByTestId(/^buses-grid-row-/)).toHaveCount(BUS_COUNT);
  await expect(busVoltageCell(page, 1)).toHaveText('—');

  // ---- run the power flow -------------------------------------------------
  await runPf.click();
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: /PF converged in \d+ iterations/ }),
  ).toBeVisible({ timeout: 90_000 });

  // Every bus now has a plausible per-unit voltage in the table, and the
  // single-line diagram shows the same number next to the bus.
  for (let idx = 1; idx <= BUS_COUNT; idx += 1) {
    const cell = busVoltageCell(page, idx);
    await expect(cell).toHaveText(/^\d\.\d{3}$/);
    const volts = Number(await cell.textContent());
    expect(volts).toBeGreaterThan(0.9);
    expect(volts).toBeLessThan(1.1);
    await expect(page.getByTestId(`bus-voltage-${idx}`)).toHaveText(`${volts.toFixed(3)} pu`);
  }

  expect(uncaughtErrors).toEqual([]);
});
