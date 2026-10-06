/**
 * Compare two power flows.
 *
 *   load IEEE 14 -> run a power flow -> run it again with the generators held
 *   at their reactive limits -> the Compare tab sets the two side by side and
 *   names the largest change -> the lines, the totals -> swap A and B
 *
 * It drives the real UI against a real `tensa serve` (see `playwright.config.ts`):
 * the two results are what ANDES solved, and the differences are taken in the
 * page. The unit tests check the subtraction and each control against stand-ins;
 * this one checks that a run reaches the history and the tab the way a user gets
 * there.
 */
import { test, expect, type Page } from './fixtures';

const CASE_FILE = 'ieee14_full.xlsx';

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

/** Run a power flow from the PF tab's own button and wait for it to converge. */
async function runPflow(page: Page, nth: number): Promise<void> {
  await page.getByTestId('pflow-options-run').click();
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: /PF converged in \d+ iterations/ }),
  ).toHaveCount(nth, { timeout: 90_000 });
}

test('two power flows: run, hold the generators at their Q limits, run again, compare', async ({
  page,
}) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));

  await page.goto('/');
  await openCase(page, CASE_FILE);

  await page.getByRole('tab', { name: 'Analysis' }).click();

  // ---- nothing to compare yet ----------------------------------------------
  await page.getByTestId('analysis-sub-tab-compare').click();
  await expect(page.getByTestId('pflow-compare-empty')).toContainText(
    'No power flow has converged yet',
  );

  // ---- the base case --------------------------------------------------------
  await page.getByTestId('analysis-sub-tab-pf').click();
  await runPflow(page, 1);
  // One result is not a comparison: the summary does not offer one yet.
  await expect(page.getByTestId('pflow-summary-compare')).toHaveCount(0);

  // ---- the same case with the reactive limits enforced -----------------------
  await page.getByTestId('pflow-enforce-q-limits').check();
  await runPflow(page, 2);

  // ---- the comparison, from the summary's own button -------------------------
  await page.getByTestId('pflow-summary-compare').click();
  await expect(page.getByTestId('pflow-compare')).toBeVisible();
  await expect(page.getByTestId('pflow-compare-select-a')).toContainText('PF #1');
  await expect(page.getByTestId('pflow-compare-select-b')).toContainText('PF #2');
  await expect(page.getByTestId('pflow-compare-select-b')).toContainText('ieee14_full');

  // Holding generators at a limit lets their bus voltages go, so the two differ.
  const headline = page.getByTestId('pflow-compare-headline');
  await expect(headline).toContainText(/Largest change: ΔV [+-]\d\.\d{4} pu at /);

  // Fourteen buses, each with both voltages and a signed difference.
  const grid = page.getByRole('table', { name: 'Buses: B compared with A' });
  await expect(grid.getByTestId(/^pflow-compare-grid-row-/)).toHaveCount(14);
  const first = grid
    .getByTestId(/^pflow-compare-grid-row-/)
    .first()
    .getByRole('cell');
  await expect(first.nth(2)).toHaveText(/^\d\.\d{4}$/);
  await expect(first.nth(3)).toHaveText(/^\d\.\d{4}$/);
  await expect(first.nth(4)).toHaveText(/^[+-]\d\.\d{5}$/);
  const largest = Math.abs(Number(await first.nth(4).textContent()));
  expect(largest).toBeGreaterThan(0.001);
  // The row on top is the one the headline names.
  expect(await headline.textContent()).toContain(largest.toFixed(4));

  // ---- the lines and the totals ----------------------------------------------
  await page.getByTestId('pflow-compare-table-lines').click();
  const lines = page.getByRole('table', { name: 'Lines: B compared with A' });
  await expect(lines.getByTestId(/^pflow-compare-grid-row-/)).toHaveCount(20);
  await page.getByTestId('pflow-compare-table-totals').click();
  const generation = page.getByTestId('pflow-compare-grid-row-generation').getByRole('cell');
  await expect(generation.nth(0)).toHaveText('Generation');
  await expect(generation.nth(1)).toHaveText(/^\d+\.\d{2}$/);

  // ---- swap: the reference becomes the run with the limits on ----------------
  await page.getByTestId('pflow-compare-table-buses').click();
  const before = await first.nth(4).textContent();
  await page.getByTestId('pflow-compare-swap').click();
  await expect(page.getByTestId('pflow-compare-select-a')).toContainText('PF #2');
  const flipped = before!.startsWith('-') ? before!.replace('-', '+') : before!.replace('+', '-');
  await expect(first.nth(4)).toHaveText(flipped);

  expect(uncaughtErrors).toEqual([]);
});
