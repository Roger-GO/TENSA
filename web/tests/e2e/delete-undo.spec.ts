/**
 * Delete and undo e2e: take elements of a case file out of the system and bring
 * them back.
 *
 *   delete a line the case file brought -> Undo brings it back -> Redo deletes it again
 *   delete a bus with what is on it, as one change -> Ctrl+Z brings it all back -> Ctrl+Y deletes it again
 *   delete the line the case itself trips -> the dialog warns, and the trip goes too
 *
 * It drives the real UI against a real `tensa serve` (nothing is mocked), so it is
 * the test that checks that the server takes a device off the system ANDES holds,
 * and that the system it builds for an undo is the one the diagram shows again.
 * `playwright.config.ts` says how to start the substrate.
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

/** Open the app and a case, and wait until its diagram is up. */
async function openCase(page: Page, caseFile: string, busCount: number) {
  await page.goto('/');
  const caseRow = page.getByTestId(`saved-cases-row-${caseFile}`);
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
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(busCount, { timeout: 90_000 });
}

function toast(page: Page, text: string | RegExp) {
  return page.locator('[data-sonner-toast]').filter({ hasText: text });
}

/** Select a line in the Lines table and press the Inspector's delete button. */
async function askToDeleteLine(page: Page, idx: string) {
  await page.getByTestId('bottom-drawer-tab-lines').click();
  await page.getByTestId(`lines-grid-row-line-${idx}`).click();
  await expect(page.getByTestId('right-inspector-header')).toContainText(idx);
  await page.getByTestId('delete-element-button').click();
  await expect(page.getByTestId('delete-element-dialog')).toBeVisible();
}

test('delete a line of the case file, take it back with Undo, and put it back with Redo', async ({
  page,
}) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));
  await openCase(page, 'ieee14_full.xlsx', 14);
  const line = page.getByTestId('lines-grid-row-line-Line_3');

  // Nothing has been edited: Undo is listed, greyed out, and says so.
  await page.getByTestId('topbar-menu-edit-trigger').click();
  await expect(page.getByTestId('topbar-menu-edit-undo')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('topbar-menu-edit-undo')).toContainText('Nothing to undo yet');
  await page.keyboard.press('Escape');

  await askToDeleteLine(page, 'Line_3');
  await expect(page.getByTestId('delete-element-dialog')).toContainText(
    'Undo in the Edit menu brings it back.',
  );
  await page.getByTestId('delete-confirm').click();
  await expect(toast(page, 'Deleted Line Line_3')).toBeVisible({ timeout: 30_000 });
  await expect(line).toHaveCount(0);

  // The Edit menu names what Undo would take back.
  await page.getByTestId('topbar-menu-edit-trigger').click();
  const undo = page.getByTestId('topbar-menu-edit-undo');
  await expect(undo).toHaveText(/Undo: delete Line Line_3/);
  await undo.click();
  await expect(toast(page, 'Undone: delete Line Line_3')).toBeVisible({ timeout: 30_000 });
  await expect(line).toHaveCount(1);

  // And what Redo would put back.
  await page.getByTestId('topbar-menu-edit-trigger').click();
  const redo = page.getByTestId('topbar-menu-edit-redo');
  await expect(redo).toHaveText(/Redo: delete Line Line_3/);
  await redo.click();
  await expect(toast(page, 'Redone: delete Line Line_3')).toBeVisible({ timeout: 30_000 });
  await expect(line).toHaveCount(0);

  // The case solves without the line.
  await page.getByTestId('run-pflow-button').click();
  await expect(toast(page, /PF converged in \d+ iterations/)).toBeVisible({ timeout: 90_000 });

  expect(uncaughtErrors).toEqual([]);
});

test('delete a bus with what is on it as one change, Ctrl+Z brings it all back, and Ctrl+Y deletes it again', async ({
  page,
}) => {
  await openCase(page, 'ieee14_full.xlsx', 14);
  // One of the two lines on bus 14. The table draws the rows in view only, so
  // the filter brings the row to where it can be counted.
  await page.getByTestId('bottom-drawer-tab-lines').click();
  await page.getByTestId('lines-grid-filter').fill('Line_13');
  const line = page.getByTestId('lines-grid-row-line-Line_13');
  await expect(line).toHaveCount(1);

  await page.getByTestId('bottom-drawer-tab-buses').click();
  await page.getByTestId('buses-grid-row-14').click();
  await expect(page.getByTestId('right-inspector-header')).toContainText('BUS14');
  await page.getByTestId('delete-element-button').click();
  await page.getByTestId('delete-confirm').click();

  // A load, a shunt and two lines are on bus 14: it cannot go alone.
  const dialog = page.getByTestId('delete-element-dialog');
  await expect(dialog).toContainText('4 elements depend on it', { timeout: 30_000 });
  for (const dependent of ['PQ-PQ_11', 'Shunt-Shunt_2', 'Line-Line_13', 'Line-Line_16']) {
    await expect(page.getByTestId(`delete-dependent-${dependent}`)).toBeVisible();
  }
  const all = page.getByTestId('delete-cascade');
  await expect(all).toHaveText('Delete all 5 elements');
  await all.click();

  await expect(toast(page, 'Deleted Bus 14')).toContainText('4 elements that depended on it', {
    timeout: 30_000,
  });
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(13);
  await page.getByTestId('bottom-drawer-tab-lines').click();
  await expect(line).toHaveCount(0);

  // One Undo for the five of them. The focus is on the page, not in a field.
  await page.getByTestId('bottom-drawer-tab-buses').click();
  await page.keyboard.press('Control+z');
  await expect(toast(page, 'Undone: delete Bus 14 and 4 more')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(14);
  await page.getByTestId('bottom-drawer-tab-lines').click();
  await expect(line).toHaveCount(1);

  // And one Redo, on the key Windows has for it, takes the five out again.
  await page.keyboard.press('Control+y');
  await expect(toast(page, 'Redone: delete Bus 14 and 4 more')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(13);
  await expect(line).toHaveCount(0);
});

test('deleting the line the case trips warns about the trip and takes it too', async ({ page }) => {
  // kundur_full.xlsx trips Line_8 at 2 s by itself.
  await openCase(page, 'kundur_full.xlsx', 10);
  const events = page.getByTestId('scheduled-disturbances');

  await askToDeleteLine(page, 'Line_8');
  await page.getByTestId('delete-confirm').click();
  const warning = page.getByTestId('delete-disturbances-warning');
  await expect(warning).toContainText('1 disturbance acts on it', { timeout: 30_000 });
  await expect(page.getByTestId('delete-disturbances-list')).toContainText(
    'Toggle of Line Line_8 at 2 s, set by the case file',
  );
  await page.getByTestId('delete-cascade').click();

  await expect(toast(page, 'Deleted Line Line_8')).toContainText('1 disturbance that acted on it', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('lines-grid-row-line-Line_8')).toHaveCount(0);
  await expect(events).not.toContainText('Line_8');

  // Undo brings the line back with its trip, which the sidebar lists again, and
  // Redo takes both away again.
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('lines-grid-row-line-Line_8')).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(events).toContainText('Toggle Line Line_8');
  await page.keyboard.press('Control+Shift+z');
  await expect(page.getByTestId('lines-grid-row-line-Line_8')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(events).not.toContainText('Line_8');
});
