/**
 * Results that outlive a reload of the page.
 *
 *   load Kundur -> run a power flow -> run a time-domain simulation -> name the
 *   run -> reload the page -> no "leave site?" prompt -> the case is open again
 *   -> a tab with no case says what the browser kept -> History still lists the
 *   run, as an earlier one -> pin it -> the plot draws it -> the Compare tab
 *   still has the power flow -> delete the run -> reload -> it is gone for good
 *
 * It drives the real UI against a real `tensa serve` (see `playwright.config.ts`)
 * in a real browser, which is the point: the results are kept in the browser's
 * IndexedDB, and the unit tests run against a stand-in for it. This one checks
 * that a run's samples really come back from the browser's own storage, that the
 * page asks nothing on the way out once they are there, and that what is deleted
 * from the list is deleted from the browser too.
 *
 * A second test opens two tabs, because the tabs on one address share that
 * storage: the second tab starts with the first one's run and deletes it, and
 * the first tab, which still lists it, then asks before it is left. The tabs
 * tell each other over the browser's own `BroadcastChannel`, which the unit
 * tests stand in for as well.
 *
 * Kundur's own case file trips a line at 2 s, so a short run has something to
 * show without a fault being added.
 */
import { test, expect, reloadWithCase, type BrowserContext, type Page } from './fixtures';

const CASE_FILE = 'kundur_full.xlsx';

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';

/** Keep the first-run coach off a page, before it loads. */
async function dismissFirstRunCoach(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, 'dismissed');
    } catch {
      // Storage unavailable: the coach shows, which does not block the test.
    }
  }, FIRST_RUN_COACH_KEY);
}

test.beforeEach(async ({ page }) => {
  await dismissFirstRunCoach(page);
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

/**
 * Open the run history. At the width the tests run at, the History button is in
 * the top bar's More menu (see `topBarLayout.ts`).
 */
async function openHistory(page: Page): Promise<void> {
  await page.getByTestId('topbar-menu-more-trigger').click();
  await page.getByTestId('topbar-menu-more-navigation.history').click();
  await expect(page.getByTestId('history-drawer')).toBeVisible();
}

/** Close the run history, which is a dialog over the page. */
async function closeHistory(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('history-drawer')).toBeHidden();
}

/** How many runs the browser's own storage holds, read behind the UI's back. */
async function runsInBrowserStorage(page: Page): Promise<number> {
  return await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open('tensa-results');
        open.onerror = () => resolve(-1);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('run-data')) {
            db.close();
            resolve(0);
            return;
          }
          const count = db.transaction(['run-data'], 'readonly').objectStore('run-data').count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
          count.onerror = () => {
            db.close();
            resolve(-1);
          };
        };
      }),
  );
}

/**
 * A tab that opens with no case, on the same address: what the page shows
 * before a case is opened, with what the browser kept. A reload opens the
 * case again, so the tab that was reloaded does not show it.
 */
async function tabWithNoCase(context: BrowserContext): Promise<Page> {
  const fresh = await context.newPage();
  await dismissFirstRunCoach(fresh);
  await fresh.goto('/');
  await expect(fresh.getByTestId(`saved-cases-row-${CASE_FILE}`)).toBeVisible();
  return fresh;
}

test('a run and a power flow are still there after the page is reloaded', async ({
  page,
  context,
}) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));
  // A page that still held unsaved work would ask before it is left. Record it,
  // and let the page go so a failure reads as one and not as a hung reload.
  const leavePrompts: string[] = [];
  page.on('dialog', (dialog) => {
    leavePrompts.push(dialog.type());
    void dialog.accept();
  });

  await page.goto('/');
  await openCase(page, CASE_FILE);
  await page.getByRole('tab', { name: 'Analysis' }).click();

  // ---- a power flow, kept for comparison -------------------------------------
  await page.getByTestId('analysis-sub-tab-pf').click();
  await page.getByTestId('pflow-options-run').click();
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: /PF converged in \d+ iterations/ }),
  ).toBeVisible({ timeout: 90_000 });

  // ---- a short time-domain run -------------------------------------------------
  await page.getByTestId('analysis-sub-tab-tds').click();
  await page.locator('#tds-config-tf').fill('3');
  await page.getByTestId('run-mode-tds').click();
  await page.getByTestId('run-tds-button').click();
  await expect(page.getByTestId('tds-run-status-badge')).toContainText(/done/i, {
    timeout: 120_000,
  });
  const plot = page.getByTestId('time-series-plot');
  await expect(plot).toBeVisible();
  const runId = await plot.getAttribute('data-run-id');
  expect(runId).toBeTruthy();

  // ---- name it, so it is plain that the name is kept too -----------------------
  await openHistory(page);
  await page.getByTestId(`history-run-row-rename-${runId}`).click();
  await page.getByTestId(`history-run-row-name-input-${runId}`).fill('Line trip, base case');
  await page.getByTestId(`history-run-row-name-input-${runId}`).press('Enter');
  await expect(page.getByTestId(`history-run-row-label-${runId}`)).toHaveText(
    'Line trip, base case',
  );
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('history-drawer')).toBeHidden();

  // The browser has the run before the page is left.
  await expect.poll(() => runsInBrowserStorage(page)).toBe(1);

  // ---- reload ------------------------------------------------------------------
  await reloadWithCase(page);
  // The run was safely kept, so the page had nothing to ask on the way out.
  expect(leavePrompts).toEqual([]);

  // The case is open again, in a new session that has run nothing.
  await expect(page.getByTestId('run-pflow-button')).toBeEnabled({ timeout: 90_000 });
  await expect(page.getByRole('complementary', { name: 'Case navigation' })).toContainText(
    /Loaded case\s*kundur_full\.xlsx/,
  );

  // ---- the page says what it kept, wherever an earlier run is looked for --------
  // Where the eye lands in a tab with no case: the page shown before one is opened.
  const fresh = await tabWithNoCase(context);
  await expect(fresh.getByTestId('kept-results-note')).toContainText(
    'Kept in this browser: 1 time-domain run and 1 power flow.',
  );
  await fresh.getByTestId('kept-results-open-history').click();
  await expect(fresh.getByTestId(`history-run-row-${runId}`)).toBeVisible();
  await fresh.close();
  await page.bringToFront();
  // The Activity tab lists the jobs of this page load: the case that was
  // opened again, and no run. It says that this is no loss, and leads to the runs.
  await page.getByRole('tab', { name: 'Activity' }).click();
  await page.getByTestId('activity-panel-subtab-history').click();
  await expect(page.getByTestId('activity-panel-content-history')).toContainText('Load case');
  await expect(page.getByTestId('activity-panel-content-history')).not.toContainText('TDS');
  await expect(page.getByTestId('activity-panel-history-note')).toContainText(
    'A reload empties this list but not your results',
  );
  await page.getByTestId('activity-panel-run-history').click();
  await expect(page.getByTestId(`history-run-row-${runId}`)).toBeVisible();
  await closeHistory(page);
  // The Run menu, and the empty plot.
  await page.getByTestId('topbar-menu-run-trigger').click();
  await expect(page.getByTestId('topbar-menu-run-history')).toHaveText('Run history (1)');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Analysis' }).click();
  await page.getByTestId('analysis-sub-tab-plot').click();
  await expect(page.getByTestId('time-series-plot-empty')).toContainText(
    '1 earlier run is kept in the run history',
  );
  await page.getByTestId('time-series-plot-open-history').click();
  await expect(page.getByTestId(`history-run-row-${runId}`)).toBeVisible();
  await closeHistory(page);

  await openHistory(page);
  const row = page.getByTestId(`history-run-row-${runId}`);
  await expect(row).toBeVisible();
  await expect(page.getByTestId(`history-run-row-label-${runId}`)).toHaveText(
    'Line trip, base case',
  );
  await expect(page.getByTestId(`history-run-row-state-${runId}`)).toHaveText('done');
  // An earlier run, not the active one: the session that computed it is gone.
  await expect(page.getByTestId(`history-run-row-earlier-badge-${runId}`)).toBeVisible();
  await expect(row).toContainText(/\d+ rows/);
  await expect(row).not.toContainText(' 0 rows');

  // ---- pin it, and the plot draws it from what the browser kept ------------------
  await page.getByTestId(`history-run-row-pin-${runId}`).click();
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Analysis' }).click();
  await page.getByTestId('analysis-sub-tab-plot').click();
  const restored = page.getByTestId('time-series-plot');
  await expect(restored).toBeVisible();
  await expect(restored).toHaveAttribute('data-run-id', runId!);
  const voltages = page.getByTestId('time-series-plot-group-bus_v');
  await expect(voltages).toBeVisible();
  // uPlot drew the series: under the pointer its legend gives each bus a number,
  // where a series with no samples reads "--".
  await voltages.getByRole('group', { name: /chart/ }).hover();
  await expect(voltages.locator('.u-legend .u-series').nth(1)).toHaveText(/^Bus_\d+_v[\d.]+$/);

  // ---- the power flow is still there to compare with ------------------------------
  await page.getByTestId('analysis-sub-tab-compare').click();
  await expect(page.getByTestId('pflow-compare-empty')).toContainText(
    'One power flow is kept so far (PF #1 · kundur_full',
  );

  // ---- what is deleted from the list is deleted from the browser -----------------
  await openHistory(page);
  await page.getByTestId(`history-run-row-delete-${runId}`).click();
  await expect(page.getByTestId(`history-run-row-${runId}`)).toHaveCount(0);
  await expect.poll(() => runsInBrowserStorage(page)).toBe(0);

  await reloadWithCase(page);
  // The case is open again, and its history has nothing to list.
  await openHistory(page);
  await expect(page.getByTestId(`history-run-row-${runId}`)).toHaveCount(0);
  await closeHistory(page);
  // In a tab with no case History is off again, and says why. The power flow
  // is still kept, so the note is there for it alone.
  const empty = await tabWithNoCase(context);
  await empty.getByTestId('topbar-menu-more-trigger').click();
  await expect(empty.getByTestId('topbar-menu-more-navigation.history')).toBeDisabled();
  await expect(empty.getByTestId('topbar-menu-more-navigation.history-reason')).toContainText(
    'No runs yet',
  );
  await empty.keyboard.press('Escape');
  await expect(empty.getByTestId('kept-results-note')).toContainText(
    'Kept in this browser: 1 power flow.',
  );
  await expect(empty.getByTestId('kept-results-open-history')).toHaveCount(0);
  await empty.close();

  expect(leavePrompts).toEqual([]);
  expect(uncaughtErrors).toEqual([]);
});

test('a tab asks before it is left once another tab has deleted its run', async ({
  page,
  context,
}) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));
  const leavePrompts: string[] = [];
  page.on('dialog', (dialog) => {
    leavePrompts.push(dialog.type());
    void dialog.accept();
  });

  await page.goto('/');
  await openCase(page, CASE_FILE);
  await page.getByRole('tab', { name: 'Analysis' }).click();
  await page.getByTestId('analysis-sub-tab-tds').click();
  await page.locator('#tds-config-tf').fill('3');
  await page.getByTestId('run-mode-tds').click();
  await page.getByTestId('run-tds-button').click();
  await expect(page.getByTestId('tds-run-status-badge')).toContainText(/done/i, {
    timeout: 120_000,
  });
  const runId = await page.getByTestId('time-series-plot').getAttribute('data-run-id');
  expect(runId).toBeTruthy();
  await expect.poll(() => runsInBrowserStorage(page)).toBe(1);

  // ---- a second tab on the same address starts with the run, and deletes it ------
  const second = await context.newPage();
  second.on('pageerror', (error) => uncaughtErrors.push(error.message));
  await dismissFirstRunCoach(second);
  await second.goto('/');
  await openHistory(second);
  await expect(second.getByTestId(`history-run-row-${runId}`)).toBeVisible();
  await second.getByTestId(`history-run-row-delete-${runId}`).click();
  await expect(second.getByTestId(`history-run-row-${runId}`)).toHaveCount(0);
  await expect.poll(() => runsInBrowserStorage(second)).toBe(0);

  // ---- the first tab still lists it, and is now the only place it is in ----------
  await page.bringToFront();
  await openHistory(page);
  await expect(page.getByTestId(`history-run-row-${runId}`)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('history-drawer')).toBeHidden();

  // So it asks before it goes, and once it has gone the run is gone with it.
  await reloadWithCase(page);
  expect(leavePrompts).toEqual(['beforeunload']);
  await openHistory(page);
  await expect(page.getByTestId(`history-run-row-${runId}`)).toHaveCount(0);
  await closeHistory(page);

  expect(uncaughtErrors).toEqual([]);
});
