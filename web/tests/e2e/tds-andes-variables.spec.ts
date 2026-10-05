/**
 * Pick ANDES variables for a time-domain run, read them on the plot between two
 * cursors, and get their response metrics.
 *
 *   load Kundur -> TDS tab: find and add `omega GENROU` -> run TDS ->
 *   a chart of its own for the variable -> zoom time on every chart ->
 *   cursors A and B -> metrics table
 *
 * It drives the real UI against a real `tensa serve` (see
 * `playwright.config.ts`): the list of variables comes from the models the
 * substrate loaded, the run records them as columns of the stream, and the
 * metrics are computed by the substrate. The unit tests check each piece against
 * stand-ins; this one checks them against ANDES and a real browser, where uPlot
 * draws on a canvas and throws from a microtask if it is handed a range it
 * cannot number, which a stand-in cannot show.
 *
 * Kundur's own case file schedules a line trip at 2 s, so the run has something
 * to respond to without a fault being added.
 */
import { test, expect, type Locator } from '@playwright/test';

const CASE_FILE = 'kundur_full.xlsx';

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, 'dismissed');
    } catch {
      // Storage unavailable: the coach shows, which does not block the test.
    }
  }, FIRST_RUN_COACH_KEY);
});

/** Page coordinates of the point `fraction` of the way along `locator`, halfway down. */
async function pointOver(locator: Locator, fraction: number): Promise<[number, number]> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('the chart is not on the page');
  return [box.x + box.width * fraction, box.y + box.height / 2];
}

test('ANDES variables: pick omega GENROU -> run TDS -> zoom -> cursors -> response metrics', async ({
  page,
}) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));

  await page.goto('/');

  // ---- load the case (see load-pf-flow.spec.ts for why this retries) -------
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
  await expect(page.getByTestId('run-pflow-button')).toBeEnabled({ timeout: 90_000 });

  // ---- find the variables and add them -------------------------------------
  await page.getByRole('tab', { name: 'Analysis' }).click();
  await page.getByTestId('analysis-sub-tab-tds').click();
  await page.getByTestId('tds-config-dae-search').fill('omega genrou');
  const results = page.getByTestId('tds-config-dae-results');
  await expect(results.getByRole('checkbox')).toHaveCount(4);
  await expect(page.getByTestId('tds-config-dae-omega GENROU 1')).toBeVisible();
  await page.getByTestId('tds-config-dae-add-shown').click();
  await expect(page.getByTestId('tds-config-dae-count')).toHaveText('4 selected');

  // ---- run it --------------------------------------------------------------
  await page.getByTestId('run-mode-tds').click();
  await page.getByTestId('run-tds-button').click();
  await expect(page.getByTestId('tds-run-status-badge')).toContainText(/done/i, {
    timeout: 120_000,
  });

  // The ANDES variable has a chart of its own, beside the bus voltages, with the
  // four generators on it.
  const omega = page.getByTestId('time-series-plot-group-dae:omega');
  await expect(omega).toBeVisible();
  await expect(omega).toContainText('omega · ANDES variable');
  await expect(omega).toContainText('omega GENROU 4');
  await expect(page.getByTestId('time-series-plot-group-bus_v')).toBeVisible();

  // ---- zoom: a drag on one chart zooms time on all of them -------------------
  const over = omega.locator('.u-over');
  const busOver = page.getByTestId('time-series-plot-group-bus_v').locator('.u-over');
  const box = await over.boundingBox();
  expect(box).not.toBeNull();
  /** The time the pointer is at, read from a chart's legend, for the pointer 60% along `chart`. */
  const timeAtSixtyPercent = async (chart: typeof over) => {
    await chart.hover({ position: { x: box!.width * 0.6, y: box!.height / 2 } });
    const legend = (id: string) =>
      page.getByTestId(`time-series-plot-group-${id}`).locator('.u-legend .u-series').first();
    return [await legend('dae:omega').innerText(), await legend('bus_v').innerText()];
  };
  const whole = await timeAtSixtyPercent(over);
  await over.hover({ position: { x: box!.width * 0.3, y: box!.height / 2 } });
  await page.mouse.down();
  await page.mouse.move(...(await pointOver(over, 0.6)), { steps: 6 });
  await page.mouse.up();
  const zoomed = await timeAtSixtyPercent(over);
  // The two charts read the same time at the same pointer, and it is no longer the same time as before.
  expect(zoomed[0]).toBe(zoomed[1]);
  expect(zoomed[0]).not.toBe(whole[0]);
  // A double-click in another chart puts every chart back.
  await busOver.dblclick({ position: { x: box!.width / 2, y: box!.height / 2 } });
  expect(await timeAtSixtyPercent(over)).toEqual(whole);

  // ---- cursors: A, then B, and the readout reads the difference -------------
  await page.getByTestId('plot-cursors-toggle').click();
  await over.click({ position: { x: box!.width * 0.3, y: box!.height / 2 } });
  await expect(page.getByTestId('cursor-readout-a')).not.toContainText('–');
  await expect(page.getByTestId('cursor-readout-b')).toContainText('–');
  await over.click({ position: { x: box!.width * 0.7, y: box!.height / 2 } });
  const dt = await page.getByTestId('cursor-readout-dt').textContent();
  expect(Number(dt?.replace(/[^\d.-]/g, ''))).toBeGreaterThan(1);
  const row = page.getByTestId('cursor-readout-row-dae:omega:1');
  await expect(row).toContainText('omega GENROU 1');
  // A, B, B - A and the rate: four numbers that are not dashes.
  for (const cell of (await row.getByRole('cell').allTextContents()).slice(1)) {
    expect(cell).toMatch(/\d/);
  }

  // ---- response metrics between the cursors --------------------------------
  const toggle = page.getByTestId('plot-metrics-toggle');
  await toggle.scrollIntoViewIfNeeded();
  await toggle.click();
  const table = page.getByTestId('response-metrics-table');
  await expect(table).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('response-metrics-window')).toContainText('A to B');
  const nadir = page.getByTestId('response-metrics-nadir-omega GENROU 1');
  await expect(nadir).toContainText(/\d/);
  await expect(page.getByTestId('response-metrics-damping-omega GENROU 1')).toContainText(/ζ|–/);

  // A canvas chart fed a range it cannot number throws from a microtask: nothing
  // above would notice, and this does.
  expect(uncaughtErrors).toEqual([]);
});
