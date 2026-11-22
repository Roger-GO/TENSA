/**
 * Model documentation e2e: ANDES's own text of a model, shown by the dialog
 * the element form and the command palette open.
 *
 *   open IEEE 14 -> Components -> GENROU -> the Add element form names GENROU
 *   -> the control beside the name, from the keyboard -> the dialog shows the
 *   text the server answered for GENROU, unchanged, in a block that scrolls
 *   inside a dialog that fits the window -> Escape closes it and gives the
 *   keyboard back to the control
 *   the command palette -> Model documentation... -> the list of every model
 *   the server answered, by group -> a search keeps the models whose names hold
 *   it -> a pick shows the text the server answered for that model
 *
 * It drives the real UI against a real `tensa serve`. The text is ANDES's, so
 * what is held of it is that the page shows what the server sent, read from the
 * page's own request, and that it names its model.
 */
import { test, expect, type Page } from './fixtures';
import { openCase } from './sldDrawing';

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';
const CASE_FILE = 'ieee14_full.xlsx';

// A laptop-width window, not a tall one: the dialog must fit it.
test.use({ viewport: { width: 1280, height: 720 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, 'dismissed');
    } catch {
      // Storage unavailable: the coach shows, which does not block the test.
    }
  }, FIRST_RUN_COACH_KEY);
});

/**
 * The answer to the page's own request for the documentation of `model`. The
 * worker serves one request at a time, so a pick made while the first model's
 * text is on its way is refused as busy once and sent again: the answer that
 * counts is the one with the text.
 */
function docResponse(page: Page, model: string) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname.endsWith(`/models/${model}/doc`) &&
      response.status() === 200,
    { timeout: 90_000 },
  );
}

/** The text of the block the dialog shows it in, exactly as the DOM holds it. */
async function shownText(page: Page, model: string): Promise<string> {
  const block = page.getByRole('region', { name: `Documentation of ${model}` });
  await expect(block).toBeVisible({ timeout: 90_000 });
  return await block.evaluate((el) => el.textContent ?? '');
}

/** The dialog is inside the window, and its text scrolls inside the block. */
async function expectFitsTheWindow(page: Page, model: string): Promise<void> {
  const dialog = (await page.getByTestId('model-doc-dialog').boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(dialog.y).toBeGreaterThanOrEqual(0);
  expect(dialog.y + dialog.height).toBeLessThanOrEqual(viewport.height);
  const block = page.getByRole('region', { name: `Documentation of ${model}` });
  const { scrollHeight, clientHeight, overflowY, whiteSpace } = await block.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowY: getComputedStyle(el).overflowY,
    whiteSpace: getComputedStyle(el).whiteSpace,
  }));
  expect(scrollHeight).toBeGreaterThan(clientHeight);
  expect(overflowY).toBe('auto');
  expect(whiteSpace).toBe('pre');
}

test('the Add element form opens the documentation of its model, as the server wrote it', async ({
  page,
}) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));
  await page.goto('/');
  await openCase(page, CASE_FILE);

  await page.getByRole('tab', { name: 'Components' }).click();
  await page.getByRole('button', { name: 'Add GENROU (synchronous)' }).click();
  const form = page.getByTestId('element-form-GENROU');
  await expect(form).toBeVisible();

  // The control is named for the model, and the keyboard reaches it.
  const control = form.getByRole('button', { name: 'Model documentation for GENROU' });
  await control.focus();
  await expect(control).toBeFocused();
  const answered = docResponse(page, 'GENROU');
  await page.keyboard.press('Enter');
  const response = await answered;
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { model: string; doc: string };
  expect(body.model).toBe('GENROU');

  const dialog = page.getByRole('dialog', { name: 'Model documentation GENROU' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('model-doc-list')).toHaveCount(0);
  const text = await shownText(page, 'GENROU');
  expect(text).toBe(body.doc);
  expect(text).toContain('GENROU');
  await expectFitsTheWindow(page, 'GENROU');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('model-doc-dialog')).toHaveCount(0);
  await expect(control).toBeFocused();
  expect(uncaughtErrors).toEqual([]);
});

test('the command palette lists every model by group, searches it and shows the one picked', async ({
  page,
}) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));
  const sessionCreated = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/sessions',
  );
  await page.goto('/');
  await sessionCreated;

  const listed = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      /^\/api\/sessions\/[^/]+\/models$/.test(new URL(response.url()).pathname) &&
      response.status() === 200,
    { timeout: 90_000 },
  );
  await page.keyboard.press('Control+k');
  await page.getByTestId('command-palette-input').fill('model documentation');
  const command = page.getByTestId('command-palette-item-help.model-doc');
  await expect(command).toContainText('Model documentation...');
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'Model documentation' });
  await expect(dialog).toBeVisible();
  const groups = ((await (await listed).json()) as { groups: Record<string, string[]> }).groups;
  const list = dialog.getByTestId('model-doc-list');
  // Every group the server answered, in its order, with every one of its models.
  await expect(list.getByRole('heading')).toHaveText(Object.keys(groups));
  await expect(list.getByRole('button')).toHaveText(Object.values(groups).flat());

  // The cursor is in the search box; what is typed keeps the models whose
  // names hold it, whatever the case, and the groups that have one.
  const search = dialog.getByRole('textbox', { name: 'Search models' });
  await expect(search).toBeFocused();
  await search.pressSequentially('tgov');
  const matching = Object.entries(groups)
    .map(
      ([group, models]) => [group, models.filter((m) => m.toLowerCase().includes('tgov'))] as const,
    )
    .filter(([, models]) => models.length > 0);
  expect(matching.length).toBeGreaterThan(0);
  await expect(list.getByRole('heading')).toHaveText(matching.map(([group]) => group));
  await expect(list.getByRole('button')).toHaveText(matching.flatMap(([, models]) => models));
  expect(matching.flatMap(([, models]) => models)).toContain('TGOV1');

  const answered = docResponse(page, 'TGOV1');
  await list.getByRole('button', { name: 'TGOV1', exact: true }).click();
  const response = await answered;
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { model: string; doc: string };
  await expect(list.getByRole('button', { name: 'TGOV1', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const text = await shownText(page, 'TGOV1');
  expect(text).toBe(body.doc);
  expect(text).toContain('TGOV1');
  await expectFitsTheWindow(page, 'TGOV1');
  expect(uncaughtErrors).toEqual([]);
});
