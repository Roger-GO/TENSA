/**
 * A first time-domain run: where its end time is set, where its record ends,
 * and what the plot draws when earlier runs are pinned.
 *
 *   load Kundur -> the Disturbances list says when a run ends -> its link opens
 *   the TDS tab -> end time 2 s -> run -> Export plot as CSV ends at 2 s -> pin
 *   the run -> Reset run -> end time 3 s -> run -> the plot draws both, the new
 *   one marked active under its own label -> Export plot holds the new run, to
 *   3 s -> reload -> the pin is back -> a third run is drawn beside it
 *
 * It drives the real UI against a real `tensa serve` (see `playwright.config.ts`).
 * The unit tests hold each part against a stand-in: the plot against a store
 * filled by hand, the server's thinning of the stream against rows made up for
 * it. This one checks them through the stream the UI really asks for, where a
 * row is the mean of the steps of a thirtieth of a second.
 *
 * Kundur's own case file trips a line at 2 s. That put a step at 1.9999 s into
 * the last thirtieth of a run to 2 s, and the record of such a run ended at
 * 1.9889 s, the mean of the three steps in it. It is also why a run needs no
 * fault added here to have something to show.
 */
import { readFile } from 'node:fs/promises';
import { test, expect, type Page, reloadWithCase } from './fixtures';

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

/** Open a case from the saved-cases list (see load-pf-flow.spec.ts for why this retries). */
async function openCase(page: Page, caseFile: string): Promise<void> {
  const caseRow = page.getByTestId(`saved-cases-row-${caseFile}`);
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
}

/** Run a time-domain simulation with the settings as they are, to its end. */
async function runTds(page: Page, tf: number): Promise<void> {
  await page.getByTestId('run-mode-tds').click();
  await page.getByTestId('run-tds-button').click();
  await expect(page.getByTestId('tds-run-status-badge')).toContainText(`Done at t=${tf}.00`, {
    timeout: 120_000,
  });
}

/** Pick CSV in the plot's export menu and read the file the browser is handed. */
async function exportPlotCsv(
  page: Page,
  path: string,
): Promise<{ fileName: string; times: number[] }> {
  await page.getByRole('button', { name: 'Export plot', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-menu-csv').click(),
  ]);
  await download.saveAs(path);
  const lines = (await readFile(path, 'utf8')).trim().split(/\r?\n/);
  // A comment, the heading, then `time,variable,value`.
  expect(lines[1]).toBe('time,variable,value');
  return {
    fileName: download.suggestedFilename(),
    times: lines.slice(2).map((line) => Number(line.split(',')[0])),
  };
}

test('a run ends where it was told to, and is drawn beside the runs pinned before it', async ({
  page,
}, testInfo) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));
  // The reload below must not ask: both runs are kept by then.
  const leavePrompts: string[] = [];
  page.on('dialog', (dialog) => {
    leavePrompts.push(dialog.type());
    void dialog.accept();
  });

  await page.goto('/');
  await openCase(page, CASE_FILE);

  // ---- the end time, from where a run is set up ----------------------------------
  const runEnd = page.getByTestId('scheduled-disturbances-run-end');
  await expect(runEnd).toContainText('A TDS run ends at 10 s.');
  await page.getByRole('button', { name: 'Change the end time' }).click();
  await expect(page.getByTestId('tds-config-panel')).toBeVisible();
  await expect(page.getByLabel('tf — end time (s)')).toHaveValue('10');
  await page.getByLabel('tf — end time (s)').fill('2');
  await expect(runEnd).toContainText('A TDS run ends at 2 s.');

  // ---- the record ends at 2 s, not at the mean of its last steps -------------------
  await runTds(page, 2);
  const plot = page.getByTestId('time-series-plot');
  await expect(plot).toHaveAttribute('data-overlay-count', '1');
  const firstRunId = await plot.getAttribute('data-run-id');
  expect(firstRunId).toBeTruthy();
  const first = await exportPlotCsv(page, testInfo.outputPath('first.csv'));
  expect(first.times[0]).toBe(0);
  expect(first.times.at(-1)).toBe(2);

  // ---- pin it, and the next run is drawn beside it under its own label -------------
  await page.getByTestId('plot-run-history').click();
  await expect(page.getByTestId('history-drawer')).toBeVisible();
  await page.getByTestId(`history-run-row-pin-${firstRunId}`).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('history-drawer')).toBeHidden();
  await page.getByTestId('run-tds-button').click();
  await expect(page.getByTestId('run-tds-button')).toHaveText(/run tds/i, { timeout: 60_000 });
  await page.getByTestId('analysis-sub-tab-tds').click();
  await page.getByLabel('tf — end time (s)').fill('3');
  await runTds(page, 3);

  await expect(plot).toHaveAttribute('data-overlay-count', '2');
  const secondRunId = await plot.getAttribute('data-run-id');
  expect(secondRunId).not.toBe(firstRunId);
  // The plot's own legend: the variable picker under it lists the runs too.
  const legend = page.getByTestId('time-series-plot-legend');
  await expect(legend.getByTestId(`run-legend-name-${firstRunId}`)).toHaveText('TDS #1 · tf=2s');
  await expect(legend.getByTestId(`run-legend-name-${secondRunId}`)).toHaveText('TDS #2 · tf=3s');
  await expect(legend.getByTestId(`run-legend-active-${secondRunId}`)).toHaveText('active');
  await expect(legend.getByTestId(`run-legend-active-${firstRunId}`)).toHaveCount(0);
  await expect(legend.getByTestId(`run-legend-chip-${secondRunId}`)).toHaveAttribute(
    'data-pinned',
    'false',
  );

  // The file is named for the run just made, and holds it.
  const second = await exportPlotCsv(page, testInfo.outputPath('second.csv'));
  expect(second.fileName).toContain(`_${secondRunId!.slice(0, 8)}_`);
  expect(second.times.at(-1)).toBe(3);

  // ---- a pin outlives the page, and a run made after the reload still shows --------
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const open = indexedDB.open('tensa-results');
            open.onerror = () => resolve(-1);
            open.onsuccess = () => {
              const count = open.result
                .transaction(['run-data'], 'readonly')
                .objectStore('run-data')
                .count();
              count.onsuccess = () => {
                open.result.close();
                resolve(count.result);
              };
              count.onerror = () => resolve(-1);
            };
          }),
      ),
    )
    .toBe(2);
  // The page opens the case again by itself.
  await reloadWithCase(page);
  await page.getByRole('button', { name: 'Change the end time' }).click();
  await page.getByLabel('tf — end time (s)').fill('1');
  await runTds(page, 1);

  await expect(plot).toHaveAttribute('data-overlay-count', '2');
  const thirdRunId = await plot.getAttribute('data-run-id');
  expect([firstRunId, secondRunId]).not.toContain(thirdRunId);
  await expect(legend.getByTestId(`run-legend-name-${firstRunId}`)).toHaveText('TDS #1 · tf=2s');
  await expect(legend.getByTestId(`run-legend-name-${thirdRunId}`)).toHaveText('TDS #3 · tf=1s');
  await expect(legend.getByTestId(`run-legend-active-${thirdRunId}`)).toHaveText('active');

  expect(leavePrompts).toEqual([]);
  expect(uncaughtErrors).toEqual([]);
});
