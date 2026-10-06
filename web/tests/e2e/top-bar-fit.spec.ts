/**
 * The top bar fits the window: after a power flow has run (the run badge and the
 * units toggle are showing), and while a time-domain run streams (the longest the
 * bar gets: the Abort button, the "Streaming" status and the job chip show too), no
 * control is scrolled out of sight at 1280 or 1440 px, the widths of a laptop, where
 * the right end of the bar (Search, Theme, History, Help) used to be cut off.
 *
 * What does not fit inline is in the More menu (`TopBarMoreMenu`), which is there
 * below the width the layout constants give and gone from it up. jsdom applies no
 * CSS, so this is the one place the widths are checked. It drives the real UI
 * against a real `tensa serve`, like the flagship spec; `playwright.config.ts` says
 * how to start the substrate.
 */
import { test, expect, type Page } from './fixtures';

const CASE_FILE = 'ieee14_full.xlsx';

/** `WIDE_PX` of `src/components/shell/topBarLayout.ts`: from here the bar is all inline. */
const WIDE_PX = 1820;

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

/** How far the bar's content runs past its right edge, in px (0 when it all fits). */
async function overflow(page: Page): Promise<number> {
  return page.getByTestId('top-bar').evaluate((bar) => bar.scrollWidth - bar.clientWidth);
}

/** True when the control is on screen: laid out, and inside the viewport's width. */
async function onScreen(page: Page, testId: string): Promise<boolean> {
  const box = await page.getByTestId(testId).boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  return box !== null && box.x >= 0 && box.x + box.width <= width;
}

async function loadCaseAndRunPf(page: Page): Promise<void> {
  await page.goto('/');
  const caseRow = page.getByTestId(`saved-cases-row-${CASE_FILE}`);
  await expect(caseRow).toBeVisible();
  // A click before the background session exists does nothing: click until the case
  // request goes out.
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
  await expect(page.getByTestId(/^bus-node-\d+$/).first()).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('run-pflow-button').click();
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: /PF converged in \d+ iterations/ }),
  ).toBeVisible({ timeout: 90_000 });
}

test('top bar: nothing is cut off at laptop widths, and More holds what does not fit', async ({
  page,
}) => {
  await loadCaseAndRunPf(page);
  const help = 'topbar-menu-help-trigger';

  for (const width of [1100, 1280, 1440, 1600, 1819, WIDE_PX, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await overflow(page), `the bar scrolls at ${width}px`).toBe(0);
    expect(await onScreen(page, help), `Help is cut off at ${width}px`).toBe(true);
    const more = page.getByTestId('topbar-menu-more-trigger');
    if (width < WIDE_PX) {
      await expect(more).toBeVisible();
      expect(await onScreen(page, 'topbar-menu-more-trigger')).toBe(true);
      await expect(page.getByTestId('command-palette-hint')).toBeHidden();
    } else {
      await expect(more).toBeHidden();
      await expect(page.getByTestId('command-palette-hint')).toBeVisible();
      expect(await onScreen(page, 'history-drawer-toggle')).toBe(true);
    }
  }
});

test('top bar: nothing is cut off while a time-domain run streams, the longest the bar gets', async ({
  page,
}) => {
  await loadCaseAndRunPf(page);
  // A run long enough to still be streaming when the last width has been checked (the
  // solver covers a few simulated seconds per second), at one frame per simulated
  // second so the page stays free to answer the checks below. The widths in
  // `topBarLayout.ts` are sized for this state.
  await page.getByTestId('bottom-drawer-tab-analysis').click();
  await page.getByTestId('analysis-sub-tab-tds').click();
  await page.getByTestId('field-tds-config-tf').fill('1000');
  await page.getByTestId('field-tds-config-max-rate').fill('1');
  await page.getByTestId('run-mode-tds').click();
  await page.getByTestId('run-tds-button').click();
  const abort = page.getByTestId('run-tds-button');
  await expect(abort).toHaveText('Abort', { timeout: 60_000 });
  await expect(page.getByTestId('tds-run-status-badge')).toHaveAttribute('data-state', 'streaming');
  await expect(page.getByTestId('in-flight-chip')).toBeVisible();

  for (const width of [1280, 1440, 1600, 1819, WIDE_PX]) {
    await page.setViewportSize({ width, height: 900 });
    // The run is what makes the bar this long: it must still be going at each width.
    await expect(abort, `the run ended before ${width}px was checked`).toHaveText('Abort');
    expect(await overflow(page), `the bar scrolls at ${width}px while streaming`).toBe(0);
    expect(await onScreen(page, 'topbar-menu-help-trigger'), `Help is cut off at ${width}px`).toBe(
      true,
    );
    if (width < WIDE_PX) {
      expect(
        await onScreen(page, 'topbar-menu-more-trigger'),
        `More is cut off at ${width}px`,
      ).toBe(true);
    }
  }

  await abort.click();
  await expect(page.getByTestId('tds-run-status-badge')).toHaveAttribute('data-state', 'aborted', {
    timeout: 30_000,
  });
});

test('top bar: at 1280 px the More menu opens Search, History and Theme, and its items work', async ({
  page,
}) => {
  await loadCaseAndRunPf(page);
  await page.setViewportSize({ width: 1280, height: 900 });

  // Search, Theme and History are not in the bar; the menu has them.
  await expect(page.getByTestId('theme-toggle')).toBeHidden();
  await expect(page.getByTestId('history-drawer-toggle')).toBeHidden();
  await page.getByTestId('topbar-menu-more-trigger').click();
  const menu = page.getByTestId('topbar-menu-more-content');
  await expect(menu.getByRole('menuitem')).toHaveCount(9);

  // The units toggle left the bar too: its stand-in switches the units.
  await expect(page.getByTestId('units-toggle')).toBeHidden();
  await menu.getByTestId('topbar-menu-more-actual-units').click();
  await page.setViewportSize({ width: 1920, height: 900 });
  await expect(page.getByRole('radio', { name: 'Actual units' })).toHaveAttribute(
    'data-state',
    'on',
  );
});
