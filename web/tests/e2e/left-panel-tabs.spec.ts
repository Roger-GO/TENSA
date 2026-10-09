/**
 * The left sidebar has two tabs, and remembers which one was open.
 *
 *   a first visit -> the sidebar is on Project, with the saved cases, and the
 *   first-run card covers neither it nor its tabs -> Components -> the palette:
 *   every kind the Add element form has, under its group, with a line each ->
 *   search "exciter" -> the four exciters and how many that is -> search
 *   something no kind is known under -> it says so, and Show all components
 *   brings the list back -> Tab stops at one row and the next Tab leaves the
 *   list -> reload -> still on Components -> Project -> reload -> still on
 *   Project
 *
 *   open IEEE 14 -> Components -> click GENROU -> the Add element form is on
 *   GENROU -> drag PQ load onto the diagram -> a draft of it stands there, with
 *   its form in the Inspector and no Add element form -> run a power flow -> the
 *   palette says the run has locked the system, and its rows are disabled
 *
 *   no case open -> the hint of the case card opens the Components tab, which
 *   takes the keyboard focus and says a click starts a blank system -> click
 *   Bus -> a blank system, with the form on Bus
 *
 *   open Kundur -> change a value in a table -> Components -> reload -> still
 *   on Components, and Kundur is open again by itself, with its disturbance,
 *   the edit and a notice that says the edit was put back -> Change case ->
 *   reload -> no case is opened for one the user closed
 *
 * It drives the real UI against a real `tensa serve` (see `playwright.config.ts`).
 * The unit tests check the tabs and the palette each on their own; this one
 * checks that the tab survives a real reload, that a real drag reaches the
 * diagram, and that the panels fit a laptop-width window. It adds nothing to a
 * case file, so the cases keep their layout for the other specs.
 */
import { test, expect, reloadWithCase, type Page } from './fixtures';
import { openCase } from './sldDrawing';

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';
const CASE_FILE = 'ieee14_full.xlsx';
/** A case whose file sets a disturbance, so the Disturbances section has a line to show. */
const CASE_WITH_EVENT = 'kundur_full.xlsx';

/** How many kinds the palette lists: `ELEMENT_KINDS` in `elementKinds.ts`. */
const KINDS = 17;

// A laptop-width window: the sidebar is at its usual fifth of it, 256 px.
test.use({ viewport: { width: 1280, height: 720 } });

/** Keep the first-run coach away, for the tests that are not about it. */
async function dismissCoach(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, 'dismissed');
    } catch {
      // Storage unavailable: the coach shows, which does not block the test.
    }
  }, FIRST_RUN_COACH_KEY);
}

const projectTab = (page: Page) => page.getByRole('tab', { name: 'Project' });
const componentsTab = (page: Page) => page.getByRole('tab', { name: 'Components' });
const paletteRows = (page: Page) => page.locator('[data-component-kind]');

test('the sidebar opens on Project, the palette is searched, and the tab is remembered', async ({
  page,
}) => {
  await page.goto('/');

  // ---- A first visit: Project, with the saved cases ------------------------
  await expect(projectTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId(`saved-cases-row-${CASE_FILE}`)).toBeVisible();
  await expect(page.getByTestId('component-library')).toBeHidden();

  // Both names are whole at this width.
  for (const tab of [projectTab(page), componentsTab(page)]) {
    const cut = await tab
      .locator('span')
      .evaluate((label) => label.scrollWidth > label.clientWidth);
    expect(cut).toBe(false);
  }

  // The first-run card points at the sidebar, so it stands beside it, in a
  // wide window too, where the sidebar is wider.
  for (const width of [1280, 1600]) {
    await page.setViewportSize({ width, height: 720 });
    const rail = (await page.getByTestId('app-shell-left-sidebar').boundingBox())!;
    const coach = (await page.getByTestId('first-run-coach').boundingBox())!;
    expect(coach.x, `at ${width} px`).toBeGreaterThanOrEqual(rail.x + rail.width);
  }
  await page.setViewportSize({ width: 1280, height: 720 });

  // ---- Components: the palette ---------------------------------------------
  await componentsTab(page).click();
  await expect(componentsTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('component-library')).toBeVisible();
  await expect(page.getByTestId(`saved-cases-row-${CASE_FILE}`)).toBeHidden();
  await expect(paletteRows(page)).toHaveCount(KINDS);
  await expect(page.getByRole('region', { name: 'Generators' }).getByRole('button')).toHaveText([
    /PV generator/,
    /Slack generator/,
    /GENROU/,
    /GENCLS/,
  ]);
  await expect(page.getByRole('button', { name: 'Add Bus' })).toContainText(
    'A node of the network.',
  );
  // Nothing is wider than the sidebar: no row is cut off or scrolls sideways.
  const overflows = await page
    .getByTestId('component-library-list')
    .evaluate((list) => list.scrollWidth > list.clientWidth);
  expect(overflows).toBe(false);

  // ---- Search ----------------------------------------------------------------
  const search = page.getByRole('textbox', { name: 'Search components' });
  await search.pressSequentially('exciter');
  await expect(paletteRows(page)).toHaveCount(4);
  await expect(page.getByTestId('component-library-count')).toHaveText(`4 of ${KINDS} components`);
  await expect(page.getByRole('button', { name: 'Add SEXS exciter (simple)' })).toBeVisible();

  await search.fill('');
  await search.pressSequentially('flux capacitor');
  await expect(paletteRows(page)).toHaveCount(0);
  await expect(page.getByTestId('component-library-empty')).toContainText(
    'No component matches “flux capacitor”.',
  );
  await page.getByRole('button', { name: 'Show all components' }).click();
  await expect(paletteRows(page)).toHaveCount(KINDS);
  await expect(search).toBeFocused();

  // ---- The keyboard: the rows are one stop for Tab, the arrows walk them -----
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Add Bus' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Add Line' })).toBeFocused();
  await page.keyboard.press('Tab');
  const leftThePalette = await page.evaluate(
    () => document.activeElement?.closest('[data-testid="component-library"]') === null,
  );
  expect(leftThePalette).toBe(true);
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Add Line' })).toBeFocused();

  // ---- The tab is the user's: it is the same after a reload -----------------
  await page.reload();
  await expect(componentsTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('component-library')).toBeVisible();
  await expect(page.getByTestId(`saved-cases-row-${CASE_FILE}`)).toBeHidden();

  await projectTab(page).click();
  await expect(page.getByTestId(`saved-cases-row-${CASE_FILE}`)).toBeVisible();
  await page.reload();
  await expect(projectTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId(`saved-cases-row-${CASE_FILE}`)).toBeVisible();
});

test('a row of the palette opens the form on its model by a click and places a draft by a drag, until a run locks the system', async ({
  page,
}) => {
  await dismissCoach(page);
  await page.goto('/');
  await openCase(page, CASE_FILE);

  await componentsTab(page).click();
  await expect(page.getByTestId('component-library-hint')).toHaveText(
    'Click a component to add it with a form, or drag it onto the diagram to add it as a draft. A device dropped on the bar or the name of a bus is connected to that bus. A line or transformer dropped on a bus starts there: click the bus it goes to.',
  );

  // ---- A click ---------------------------------------------------------------
  await page.getByRole('button', { name: 'Add GENROU (synchronous)' }).click();
  const panel = page.getByTestId('add-element-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('add-element-kind')).toHaveValue('GENROU');
  await expect(page.getByTestId('element-form-GENROU')).toBeVisible();
  await page.getByTestId('add-element-close').click();
  await expect(panel).toBeHidden();

  // ---- A drag onto the diagram ----------------------------------------------
  // Dropped in the upper left of the diagram, clear of the form's own place.
  await page
    .getByRole('button', { name: 'Add PQ load' })
    .dragTo(page.getByTestId('sld-canvas-surface'), { targetPosition: { x: 120, y: 160 } });
  // It is on the diagram at once, as a draft, and its form is the Inspector's.
  await expect(page.getByTestId('draft-node-draft-1')).toBeVisible();
  await expect(page.getByTestId('draft-inspector-header')).toContainText('PQ load');
  await expect(panel).toBeHidden();
  await page.getByRole('button', { name: 'Delete draft' }).click();
  await expect(page.getByTestId('draft-node-draft-1')).toHaveCount(0);

  // ---- A run locks the system, and the palette says so ----------------------
  await page.getByTestId('run-pflow-button').click();
  await expect(page.getByTestId('component-library-hint')).toContainText(
    'A run has fixed the system.',
    { timeout: 60_000 },
  );
  const bus = page.getByRole('button', { name: 'Add Bus' });
  await expect(bus).toHaveAttribute('aria-disabled', 'true');
  await bus.click({ force: true });
  await expect(panel).toBeHidden();
});

test('with no case open, the case card leads to the palette, and a row starts a blank system', async ({
  page,
}) => {
  await dismissCoach(page);
  await page.goto('/');
  await expect(page.getByTestId('case-nav-empty')).toContainText('No case loaded.');

  // From the keyboard: the link is hidden with its panel, and the tab it
  // opened has the focus, so the next Tab goes into the palette.
  await page.getByRole('button', { name: 'Components tab' }).press('Enter');
  await expect(componentsTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(componentsTab(page)).toBeFocused();
  await expect(page.getByTestId('component-library-hint')).toHaveText(
    'Click a component, or drag it onto the diagram, to start a blank system with it.',
  );

  await page.getByRole('button', { name: 'Add Bus' }).click();
  await expect(page.getByTestId('add-element-panel')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('add-element-kind')).toHaveValue('Bus');
  // With a system to add to, the palette says what a click does now.
  await expect(page.getByTestId('component-library-hint')).toHaveText(
    'Click a component to add it with a form, or drag it onto the diagram to add it as a draft. A device dropped on the bar or the name of a bus is connected to that bus. A line or transformer dropped on a bus starts there: click the bus it goes to.',
  );
  await projectTab(page).click();
  await expect(page.getByRole('complementary', { name: 'Case navigation' })).toContainText(
    'New system',
  );
});

test('a reload opens the case again, on whichever tab the sidebar is, with the edits made to it', async ({
  page,
}) => {
  await dismissCoach(page);
  // The page asks before it is left while an edit is unsaved; the test lets it go.
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto('/');
  await openCase(page, CASE_WITH_EVENT);
  const sidebar = page.getByRole('complementary', { name: 'Case navigation' });
  const disturbances = page.getByTestId('left-sidebar-section-disturbances');
  const toast = (text: string | RegExp) =>
    page.locator('[data-sonner-toast]').filter({ hasText: text });
  await expect(disturbances).toContainText('Toggle Line Line_8');

  // An edit that no file holds: the limit of a bus, changed in its table.
  await page.getByTestId('bottom-drawer-tab-buses').click();
  const limit = page.getByTestId('buses-grid-cell-1-vmax');
  await limit.dblclick();
  const editor = page.getByTestId('buses-grid-editor');
  await expect(editor).toBeFocused();
  await editor.fill('1.07');
  await editor.press('Enter');
  await expect(limit).toHaveText('1.07');
  await expect(limit).not.toHaveAttribute('data-pending', 'true');

  await componentsTab(page).click();
  // With a case open the palette says nothing about cases.
  await expect(page.getByTestId('component-library-no-case')).toHaveCount(0);

  // ---- A reload: the tab is kept, and so is the case ------------------------
  await reloadWithCase(page);
  await expect(componentsTab(page)).toHaveAttribute('aria-selected', 'true');
  // No button to press and no note to read: the diagram is back.
  await expect(page.getByTestId(/^bus-node-\d+$/).first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('component-library-no-case')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Reopen / })).toHaveCount(0);
  // The edit was put back on the case, and the page says so.
  await expect(toast('Edits restored')).toContainText(
    'The page was reloaded. 1 change replayed onto a fresh copy of the case.',
    { timeout: 30_000 },
  );
  await expect(limit).toHaveText('1.07');

  await projectTab(page).click();
  await expect(sidebar).toContainText(/Loaded case\s*kundur_full\.xlsx/);
  await expect(disturbances).toContainText('Toggle Line Line_8');
  await expect(page.getByTestId(`saved-cases-recent-${CASE_WITH_EVENT}`)).toBeVisible();

  // ---- A second reload opens it again, with the same edit --------------------
  await reloadWithCase(page);
  await expect(sidebar).toContainText(/Loaded case\s*kundur_full\.xlsx/, { timeout: 90_000 });
  await expect(limit).toHaveText('1.07', { timeout: 30_000 });

  // ---- A case the user closed is not opened by a reload ----------------------
  await page.getByRole('button', { name: 'Change case' }).click();
  await page.getByRole('button', { name: 'Discard & change case' }).click();
  const card = page.getByTestId('case-nav-empty');
  await expect(card).toContainText('No case loaded.');
  await page.reload();
  await expect(card).toContainText('No case loaded.');
  await expect(page.getByTestId(`saved-cases-row-${CASE_WITH_EVENT}`)).toBeVisible();
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(0);
});
