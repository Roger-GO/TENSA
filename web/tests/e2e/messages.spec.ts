/**
 * Read what ANDES says while it works, in the Messages tab.
 *
 *   load IEEE 14 -> run a power flow that holds generators at their Q limits ->
 *   the tab carries a warning count -> the warning names the generators ->
 *   turn the information messages on -> filter them -> Clear
 *
 *   load IEEE 14 -> run a power flow with the defaults -> generators are past a Q
 *   limit but no warning names them -> the tab says why and runs it again with
 *   Q limits enforced from its button -> the warning appears and the note is gone
 *
 *   load Kundur -> run a time-domain simulation -> the line trip its case file
 *   schedules is listed among the information messages
 *
 *   run a power flow that warns -> open Kundur from the saved cases -> the old
 *   case's warning and its count are gone and the load's own messages are listed
 *
 * It drives the real UI against a real `tensa serve` (see `playwright.config.ts`):
 * the messages are what ANDES logged in the session's worker, carried back on the
 * worker's replies, kept by the server and read by the page. The unit tests check
 * each of those steps against stand-ins; this one checks that they meet.
 */
import { test, expect, type Page } from './fixtures';

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
  await page.goto('/');
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

test('a power flow that holds generators at a limit leaves a warning to read', async ({ page }) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));

  await openCase(page, 'ieee14_full.xlsx');

  // Nothing has been said that needs a look: no count beside the tab.
  const tab = page.getByTestId('bottom-drawer-tab-messages');
  await expect(tab).toBeVisible();
  await expect(page.getByTestId('messages-tab-count')).toHaveCount(0);

  // ---- run a power flow with the generators' Q limits on --------------------
  await page.getByRole('tab', { name: 'Analysis' }).click();
  await page.getByTestId('analysis-sub-tab-pf').click();
  await page.getByTestId('pflow-enforce-q-limits').check();
  await page.getByTestId('pflow-options-run').click();
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: /PF converged in \d+ iterations/ }),
  ).toBeVisible({ timeout: 90_000 });

  // ---- the tab says there is something to read ------------------------------
  const count = page.getByTestId('messages-tab-count');
  await expect(count).toHaveText('1');
  await expect(count).toHaveAttribute('data-severity', 'warning');

  await tab.click();
  const warning = page.getByTestId('message-row').filter({ hasText: 'Reactive limits' });
  await expect(warning).toHaveCount(1);
  await expect(warning).toHaveAttribute('data-level', 'warning');
  await expect(warning).toContainText('switched from PV to PQ');
  await expect(warning).toContainText(/PV \d+ at qmax/);
  await expect(warning.getByTestId('message-source')).toHaveText('Power flow');

  // ---- the information messages are one toggle away -------------------------
  // Only the warning shows at first; ANDES's own account of the run is hidden.
  await expect(page.getByTestId('message-row')).toHaveCount(1);
  await expect(page.getByTestId('messages-level-info-count')).not.toHaveText('0');
  await page.getByTestId('messages-level-info').click();
  const converged = page
    .getByTestId('message-row')
    .filter({ hasText: /Converged in \d+ iterations/ });
  await expect(converged).toHaveCount(1);
  await expect(converged).toHaveAttribute('data-level', 'info');
  expect(await page.getByTestId('message-row').count()).toBeGreaterThan(5);

  // A filter keeps the messages that hold every word typed.
  await page.getByTestId('messages-filter').fill('parsing input');
  await expect(page.getByTestId('message-row')).toHaveCount(1);
  await expect(page.getByTestId('message-row')).toContainText('Parsing input file');
  await expect(page.getByTestId('message-row').getByTestId('message-source')).toHaveText(
    'Load case',
  );
  await page.getByTestId('messages-filter-clear').click();

  // ---- Clear empties the server's log as well as the tab ----------------------
  await page.getByTestId('messages-clear').click();
  await expect(page.getByTestId('message-row')).toHaveCount(0);
  await expect(page.getByTestId('messages-tab-count')).toHaveCount(0);
  // The log goes on from where the clear left it: the next run adds only what it says.
  await page.getByTestId('run-pflow-button').click();
  await expect(page.getByTestId('messages-tab-count')).toHaveText('1', { timeout: 90_000 });
  await expect(page.getByTestId('message-row').filter({ hasText: 'Parsing input' })).toHaveCount(0);
  await expect(page.getByTestId('message-row').filter({ hasText: /Converged in/ })).toHaveCount(1);
  expect(uncaughtErrors).toEqual([]);
});

test('the events of a time-domain run are listed once it has run', async ({ page }) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));

  await openCase(page, 'kundur_full.xlsx');

  await page.getByTestId('run-mode-tds').click();
  await page.getByTestId('run-tds-button').click();
  await expect(page.getByTestId('tds-run-status-badge')).toContainText(/done/i, {
    timeout: 120_000,
  });

  // Kundur's own case file trips a line at 2 s. ANDES reports it as information.
  await page.getByTestId('bottom-drawer-tab-messages').click();
  await page.getByTestId('messages-level-info').click();
  const trip = page.getByTestId('message-row').filter({ hasText: /status changed to 0 at t=2/ });
  await expect(trip).toHaveCount(1, { timeout: 30_000 });
  await expect(trip.getByTestId('message-source')).toHaveText('Time domain');
  await expect(
    page.getByTestId('message-row').filter({ hasText: /Simulation to t=[\d.]+ sec completed/ }),
  ).toHaveCount(1);

  expect(uncaughtErrors).toEqual([]);
});

test('a power flow that leaves generators past a limit says why no warning names them', async ({
  page,
}) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));

  await openCase(page, 'ieee14_full.xlsx');

  // The defaults do not enforce Q limits: the Violations tab lists generators past one.
  await page.getByTestId('run-pflow-button').click();
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: /PF converged in \d+ iterations/ }),
  ).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('violations-tab-count')).toBeVisible();

  // The Messages tab has no warning for them, and says why.
  await page.getByTestId('bottom-drawer-tab-messages').click();
  await expect(page.getByTestId('messages-tab-count')).toHaveCount(0);
  const note = page.getByTestId('messages-qlimit-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('did not enforce Q limits');
  await expect(note).toContainText(/\d+ generators are past a reactive limit/);

  // One button runs the power flow again with Q limits enforced.
  await page.getByTestId('messages-qlimit-run').click();
  await expect(page.getByTestId('messages-tab-count')).toHaveText('1', { timeout: 90_000 });
  const warning = page.getByTestId('message-row').filter({ hasText: 'Reactive limits' });
  await expect(warning).toHaveCount(1);
  await expect(warning).toContainText('switched from PV to PQ');
  await expect(note).toHaveCount(0);

  expect(uncaughtErrors).toEqual([]);
});

test('opening another case leaves the old case’s messages behind', async ({ page }) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));

  await openCase(page, 'ieee14_full.xlsx');
  await page.getByRole('tab', { name: 'Analysis' }).click();
  await page.getByTestId('analysis-sub-tab-pf').click();
  await page.getByTestId('pflow-enforce-q-limits').check();
  await page.getByTestId('pflow-options-run').click();
  await expect(page.getByTestId('messages-tab-count')).toHaveText('1', { timeout: 90_000 });

  // Open Kundur from the saved cases; the session stays, the case is replaced.
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/case'),
      { timeout: 90_000 },
    ),
    page.getByTestId('saved-cases-row-kundur_full.xlsx').click(),
  ]);
  await expect(page.getByTestId('run-pflow-button')).toBeEnabled({ timeout: 90_000 });

  await page.getByTestId('bottom-drawer-tab-messages').click();
  await expect(page.getByTestId('messages-tab-count')).toHaveCount(0);
  await page.getByTestId('messages-level-info').click();
  await expect(
    page.getByTestId('message-row').filter({ hasText: 'Parsing input file "kundur_full.xlsx"' }),
  ).toHaveCount(1);
  await expect(page.getByTestId('message-row').filter({ hasText: 'ieee14_full' })).toHaveCount(0);
  await expect(page.getByTestId('message-row').filter({ hasText: 'Reactive limits' })).toHaveCount(
    0,
  );
  await expect(page.getByTestId('message-row').filter({ hasText: /Converged in/ })).toHaveCount(0);

  expect(uncaughtErrors).toEqual([]);
});
