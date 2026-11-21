/**
 * The top bar fits the window: after a power flow has run (the run badge and the
 * units toggle are showing), and while a time-domain run streams (the longest the
 * bar gets: the Abort button, the "Streaming" status and the job chip show too), no
 * control is scrolled out of sight at 1280 or 1440 px, the widths of a laptop, where
 * the right end of the bar (Search, Theme, History, Help) used to be cut off, nor at
 * any step of `topBarLayout.ts` or the pixel below it. Both checks run with the run
 * control in its time-domain mode, where Check initialisation is offered in the menu
 * beside the Run button, and with the engine picker showing the longest engine label:
 * the two controls that, added without a measurement, made the bar scroll again.
 * Each fit test checks every width twice, as drawn and with the bar's text spaced out
 * until its content is 5 percent wider (`WIDENING`), because the widths measured on one
 * machine were too thin for the fonts of GitHub's Linux runner; and it reports every
 * width that fails in one go.
 *
 * What does not fit inline is in the More menu (`TopBarMoreMenu`), which is there
 * below the width the layout constants give and gone from it up. jsdom applies no
 * CSS, so this is the one place the widths are checked. It drives the real UI
 * against a real `tensa serve`, like the flagship spec; `playwright.config.ts` says
 * how to start the substrate.
 *
 * The last test is about what is drawn over the bar: the toasts come up in the
 * corner its right-hand menus open into, and must leave both the bar and an open
 * menu in reach.
 */
import { test, expect, type Page } from './fixtures';
import { MEDIUM_PX, NARROW_PX, WIDE_PX } from '../../src/components/shell/topBarLayout';
import { DEFAULT_ENGINE, engineLabel } from '../../src/lib/engines';

const CASE_FILE = 'ieee14_full.xlsx';

/**
 * The widths each test checks: the two of a laptop, each step of `topBarLayout.ts` and
 * the pixel below it (the widest the bar is at before the step hands controls over),
 * and a full HD window.
 */
const STEP_WIDTHS = [
  ...new Set([
    1280,
    1440,
    NARROW_PX - 1,
    NARROW_PX,
    1600,
    MEDIUM_PX - 1,
    MEDIUM_PX,
    1920,
    WIDE_PX - 1,
    WIDE_PX,
  ]),
].sort((a, b) => a - b);

/** The engines whose labels the picker can show: those the client names, and the server's. */
const KNOWN_ENGINES = [DEFAULT_ENGINE, 'sienna'];

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

/**
 * Put the longest engine label in the engine picker's trigger, the widest the picker
 * gets. The server of the tests runs one engine, so the label is written into the page:
 * each label the client or the server knows is measured in the trigger's own font, and
 * the widest is shown. Called before each width is checked, in case a render put the
 * live label back.
 */
async function showLongestEngineLabel(page: Page, engines: readonly string[]): Promise<void> {
  const labels = [...new Set(engines.map(engineLabel))];
  const shown = await page.getByTestId('engine-picker-trigger').evaluate((trigger, all) => {
    const span = trigger.querySelector('span');
    if (span === null) throw new Error('the engine picker has no label');
    const probe = span.cloneNode() as HTMLElement;
    span.after(probe);
    let widest = span.textContent ?? '';
    let widestPx = -1;
    for (const label of all) {
      probe.textContent = label;
      const px = probe.getBoundingClientRect().width;
      if (px > widestPx) {
        widestPx = px;
        widest = label;
      }
    }
    probe.remove();
    span.textContent = widest;
    return widest;
  }, labels);
  await expect(page.getByTestId('engine-picker-trigger')).toHaveText(shown);
}

/**
 * How much wider the second pass of the fit tests makes the bar's content. The widths
 * of `topBarLayout.ts` were measured on Windows, and GitHub's Linux runner draws the
 * same bar about 5 percent wider (1.045 to 1.05 in the run that showed it): a margin
 * set from one machine's fonts was too thin for the other's. The second pass spaces
 * the bar's text out until its content is this much wider than as drawn, so a bar
 * that still fits has room for fonts that much wider than the ones it is drawn in, and
 * a margin too thin fails on any machine and not only on the runner.
 */
const WIDENING = 1.05;

const WIDER_TEXT_STYLE_ID = 'top-bar-fit-wider-text';

/** Space out the text of the bar by `spacing` (em), or put it back with `null`. */
async function spaceText(page: Page, spacing: number | null): Promise<void> {
  await page.evaluate(
    ({ id, spacing }) => {
      document.getElementById(id)?.remove();
      if (spacing === null) return;
      const style = document.createElement('style');
      style.id = id;
      style.textContent = `[data-testid="top-bar"] * { letter-spacing: ${spacing}em !important; }`;
      document.head.appendChild(style);
    },
    { id: WIDER_TEXT_STYLE_ID, spacing },
  );
}

/**
 * Space the text out, a hundredth of an em at a time, until the content of the bar as
 * it is now is `WIDENING` wider; answer the spacing, in em. Text is only part of the
 * bar (its glyphs, paddings and the Run button's least width are not), so the spacing
 * it takes depends on what the bar shows.
 */
async function spaceTextOutToWidening(page: Page): Promise<number> {
  await spaceText(page, null);
  const drawn = await contentWidth(page);
  for (let hundredths = 1; hundredths <= 30; hundredths += 1) {
    const spacing = hundredths / 100;
    await spaceText(page, spacing);
    if ((await contentWidth(page)) >= drawn * WIDENING) return spacing;
  }
  throw new Error(`spacing the text out by 0.3em does not widen the bar's content ${WIDENING}x`);
}

/** The width the bar's content takes, in px: what it holds without the two spacers. */
async function contentWidth(page: Page): Promise<number> {
  return page.getByTestId('top-bar').evaluate((bar) => {
    let spacers = 0;
    for (const child of Array.from(bar.children)) {
      if (child.tagName === 'DIV' && child.getAttribute('aria-hidden') === 'true') {
        spacers += child.getBoundingClientRect().width;
      }
    }
    return bar.scrollWidth - spacers;
  });
}

/**
 * Check the bar at each width and say everything that is wrong, so that one run shows
 * every width that overflows and by how much, not only the first: the bar's overflow,
 * Help cut off, and More cut off where it is there. `beforeEach` runs at each width
 * once the window has its size (the run that must still be going, say).
 */
async function fitProblems(
  page: Page,
  widths: readonly number[],
  engines: readonly string[],
  pass: string,
  beforeEach?: (width: number) => Promise<void>,
): Promise<string[]> {
  const problems: string[] = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await beforeEach?.(width);
    await showLongestEngineLabel(page, engines);
    const over = await overflow(page);
    // The figures for the report, so a run shows how much room each width has left.
    const content = Math.round(await contentWidth(page));
    test.info().annotations.push({
      type: 'top bar width',
      description: `${pass}: ${width}px, content ${content}px, room ${width - content}px`,
    });
    if (over !== 0) {
      problems.push(
        `${pass}: the bar scrolls at ${width}px by ${over}px (content ${Math.round(await contentWidth(page))}px)`,
      );
    }
    if (!(await onScreen(page, 'topbar-menu-help-trigger'))) {
      problems.push(`${pass}: Help is cut off at ${width}px`);
    }
    if (width < WIDE_PX && !(await onScreen(page, 'topbar-menu-more-trigger'))) {
      problems.push(`${pass}: More is cut off at ${width}px`);
    }
  }
  return problems;
}

/**
 * The bar at every width, as drawn and with its text spaced out until its content is
 * `WIDENING` wider (measured at the widest width checked, where the bar shows the
 * most), with every problem of both passes in one assertion.
 */
async function expectFitsWithRoomToSpare(
  page: Page,
  widths: readonly number[],
  engines: readonly string[],
  state: string,
  beforeEach?: (width: number) => Promise<void>,
): Promise<void> {
  const problems = await fitProblems(page, widths, engines, `${state}, as drawn`, beforeEach);
  await page.setViewportSize({ width: Math.max(...widths), height: 900 });
  await showLongestEngineLabel(page, engines);
  try {
    const spacing = await spaceTextOutToWidening(page);
    problems.push(
      ...(await fitProblems(
        page,
        widths,
        engines,
        `${state}, text spaced out by ${spacing}em (content ${WIDENING}x)`,
        beforeEach,
      )),
    );
  } finally {
    await spaceText(page, null);
  }
  expect(problems, problems.join('\n')).toEqual([]);
}

/** Every engine the server lists, with the ones the client names itself. */
async function enginesKnown(page: Page): Promise<string[]> {
  const response = await page.request.get('/api/engines');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { engines: Array<{ name: string }> };
  return [...KNOWN_ENGINES, ...body.engines.map((engine) => engine.name)];
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
  const engines = await enginesKnown(page);

  // The run control in its time-domain mode, with Check initialisation offered in its
  // menu: the widest the centre of the bar is while nothing runs.
  await page.getByTestId('run-mode-tds').click();
  await page.getByTestId('run-actions-trigger').click();
  await expect(page.getByTestId('tds-init-check')).toBeVisible();
  await expect(page.getByTestId('tds-init-check')).not.toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('run-actions-content')).toBeHidden();

  await expectFitsWithRoomToSpare(page, [1100, ...STEP_WIDTHS], engines, 'after a power flow');

  // What is inline and what is in More, at each width.
  for (const width of [1100, ...STEP_WIDTHS]) {
    await page.setViewportSize({ width, height: 900 });
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
  const engines = await enginesKnown(page);

  // The run is what makes the bar this long: it must still be going at each width.
  await expectFitsWithRoomToSpare(page, STEP_WIDTHS, engines, 'while streaming', (width) =>
    expect(abort, `the run ended before ${width}px was checked`).toHaveText('Abort'),
  );

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

test('top bar: a toast leaves the bar and an open menu in reach', async ({ page }) => {
  await loadCaseAndRunPf(page); // leaves its toasts up
  const toast = page.locator('[data-sonner-toast]').first();

  // Rest the pointer on the toast. A toast under the pointer does not time out, so
  // the toasts are there for everything that follows, however long it takes.
  await toast.hover();
  await expect(toast).toHaveAttribute('data-expanded', 'true');

  // None lies over the bar.
  const bar = await page.getByTestId('top-bar').boundingBox();
  if (bar === null) throw new Error('the top bar is not laid out');
  await expect
    .poll(async () => (await toast.boundingBox())?.y ?? 0, {
      message: 'a toast lies over the top bar',
    })
    .toBeGreaterThanOrEqual(bar.y + bar.height);

  // Move the pointer to the right end of the toast, where no menu reaches, and open
  // the Export menu from the keyboard, so the pointer stays on the toast. The menu
  // opens into the corner the toasts are in.
  const box = await toast.boundingBox();
  if (box === null) throw new Error('the toast is gone from under the pointer');
  await toast.hover({ position: { x: box.width - 12, y: box.height / 2 } });
  await page.getByTestId('topbar-menu-export-trigger').focus();
  await page.keyboard.press('Enter');
  const entries = page.getByTestId('topbar-menu-export-content').getByRole('menuitem');
  await expect(entries.first()).toBeVisible();
  const places = await entries.evaluateAll((items) => {
    const toasts = Array.from(document.querySelectorAll('[data-sonner-toast]')).map((el) =>
      el.getBoundingClientRect(),
    );
    return items.map((item) => {
      const rect = item.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        entry: item.getAttribute('data-testid'),
        sharesItsPlaceWithAToast: toasts.some(
          (t) => x >= t.left && x <= t.right && y >= t.top && y <= t.bottom,
        ),
        inReach: hit !== null && item.contains(hit),
      };
    });
  });
  // The test needs a toast where an entry is, or it shows nothing.
  expect(places.filter((place) => place.sharesItsPlaceWithAToast)).not.toEqual([]);
  expect(places.filter((place) => !place.inReach)).toEqual([]);

  // And a click on an entry lands on it.
  await page.getByTestId('topbar-menu-export-reports').click();
  await expect(page.getByTestId('report-dialog')).toBeVisible();
});
