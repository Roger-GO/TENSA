/**
 * Editable tables e2e: change the values of a case in its tables.
 *
 *   rate a line in the Lines table (a toast confirms it) -> run PF -> the loading is judged against it
 *   a run locks the table -> Reset run in its bar opens it again, edits discarded
 *   change a machine's inertia as H in the Machines table -> the case holds M = 2H
 *   filter a table
 *
 * It drives the real UI against a real `tensa serve` (nothing is mocked), so it is
 * the test that checks that what the table sends is what the server accepts and
 * what ANDES solves. `playwright.config.ts` says how to start the substrate.
 */
import { test, expect, type Page } from './fixtures';

const CASE_FILE = 'ieee14_full.xlsx';
const BUS_COUNT = 14;

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

/** Open the app and the IEEE 14 case, and wait until its diagram is up. */
async function openCase(page: Page) {
  await page.goto('/');
  const caseRow = page.getByTestId(`saved-cases-row-${CASE_FILE}`);
  await expect(caseRow).toBeVisible();
  // The UI opens its session in the background after the first paint, and a
  // click on a case before that does nothing. Click until the request goes out.
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
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(BUS_COUNT, { timeout: 90_000 });
}

/** Double-click a cell, type a value and press Enter. */
async function setCell(page: Page, grid: string, cellId: string, text: string) {
  const cell = page.getByTestId(`${grid}-grid-cell-${cellId}`);
  await cell.dblclick();
  const editor = page.getByTestId(`${grid}-grid-editor`);
  await expect(editor).toBeFocused();
  await editor.fill(text);
  await editor.press('Enter');
  await expect(editor).toBeHidden();
}

test('rate a line in its table, run PF, and the loading is judged against the rating', async ({
  page,
}) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));
  await openCase(page);

  await page.getByTestId('bottom-drawer-tab-lines').click();
  await expect(page.getByTestId('lines-grid-hint')).toContainText('Double-click a value');
  // The case rates no line: the rating reads a dash.
  const rating = page.getByTestId('lines-grid-cell-line-Line_1-rate_a');
  await expect(rating).toHaveText('—');

  await setCell(page, 'lines', 'line-Line_1-rate_a', '10');
  // The cell is marked as pending until the topology has been read again, then it
  // reads what the server holds.
  await expect(rating).toHaveText('10');
  await expect(rating).not.toHaveAttribute('data-pending', 'true');
  // A toast confirms the change, and says how to take it back.
  const confirmation = page
    .locator('[data-sonner-toast]')
    .filter({ hasText: 'Changed rate_a of Line Line_1' });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText('Undo (Ctrl+Z or Edit > Undo) takes it back');

  await page.getByTestId('run-pflow-button').click();
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: /PF converged in \d+ iterations/ }),
  ).toBeVisible({ timeout: 90_000 });

  // About 150 MW through a 10 MVA line is far over it.
  await expect(page.getByTestId('lines-grid-cell-line-Line_1-loading_check')).toHaveText(
    'Over rating',
  );

  // The run has locked the case: the table says so and opens no editor.
  await expect(page.getByTestId('lines-grid-hint')).toContainText('A run has fixed the system.');
  await page.getByTestId('lines-grid-cell-line-Line_1-x').dblclick();
  await expect(page.getByTestId('lines-grid-editor')).toBeHidden();

  // Reset run, from the table's bar, opens it again; the edit is discarded.
  await page.getByTestId('grid-reset-run').click();
  await expect(page.getByTestId('lines-grid-hint')).toContainText('Double-click a value');
  await expect(rating).toHaveText('—');

  expect(uncaughtErrors).toEqual([]);
});

test("change a machine's inertia as H in the Machines table, and the case holds M = 2H", async ({
  page,
}) => {
  await openCase(page);
  await page.getByTestId('bottom-drawer-tab-machines').click();
  const grid = page.getByTestId('machines-grid');
  await expect(grid).toBeVisible();
  await expect(page.getByTestId('machines-grid-model-GENROU')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  const h = page.getByTestId('machines-grid-cell-GENROU-GENROU_1-H');
  const m = page.getByTestId('machines-grid-cell-GENROU-GENROU_1-M');
  const before = Number(await m.textContent());
  expect(before).toBeGreaterThan(0);
  await expect(h).toHaveText(String(before / 2));

  await setCell(page, 'machines', 'GENROU-GENROU_1-H', '7.5');
  await expect(h).toHaveText('7.5');
  await expect(m).toHaveText('15');
  // The other machines are as they were.
  await expect(page.getByTestId('machines-grid-cell-GENROU-GENROU_2-M')).not.toHaveText('15');
});

test('an edit that breaks the reactance order is refused, and says why', async ({ page }) => {
  await openCase(page);
  await page.getByTestId('bottom-drawer-tab-machines').click();
  const xd = page.getByTestId('machines-grid-cell-GENROU-GENROU_1-xd');
  const before = await xd.textContent();

  // xd below xd1 breaks xd > xd1 > xd2 > xl.
  await setCell(page, 'machines', 'GENROU-GENROU_1-xd', '0.01');
  const alert = page.getByTestId('machines-grid-edit-error');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('GENROU reactances must satisfy xd > xd1 > xd2 > xl');
  await expect(xd).toHaveText(before ?? '');
});

test('filter a table by any cell', async ({ page }) => {
  await openCase(page);
  await expect(page.getByTestId(/^buses-grid-row-/)).toHaveCount(BUS_COUNT);
  await page.getByTestId('buses-grid-filter').fill('4');
  const rows = page.getByTestId(/^buses-grid-row-/);
  expect(await rows.count()).toBeLessThan(BUS_COUNT);
  await expect(page.getByTestId('buses-grid-filter-count')).toContainText(`of ${BUS_COUNT}`);
  await page.getByTestId('buses-grid-filter-clear').click();
  await expect(rows).toHaveCount(BUS_COUNT);
});
