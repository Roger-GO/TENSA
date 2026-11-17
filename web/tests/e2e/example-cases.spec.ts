/**
 * Example cases e2e: the dialog that lists the catalog, adds a case to the workspace and opens it.
 *
 *   Project tab -> Example cases: the cases, their sources and licences, Cite copies the references
 *   Open on a card -> the dialog closes and the case is on the diagram
 *   the command palette finds it; Escape closes it and the keyboard focus goes back
 *   a case the list calls missing, which the server has: Add says it is there, and the card turns to Added
 *   a bundled case whose file in the workspace is another one: the card says so, and Replace puts the shipped one there
 *
 * It drives the real UI against a real `tensa serve` (nothing but the one list in the last test is
 * answered by the test), on a workspace the server seeded with the three first-run cases, all of
 * which have machines. The catalog is the server's own, so what is held of the three cases is what
 * the dialog shows of any case: the size, the analyses, the links that open in a new tab, the
 * references and the buttons.
 */
import { test, expect, type Page } from './fixtures';

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';

/** Open the app and wait until it has a session, which opening a case needs. */
async function openApp(page: Page) {
  const sessionCreated = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/sessions',
  );
  await page.goto('/');
  await sessionCreated;
  await expect(page.getByTestId('saved-cases-list')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, 'dismissed');
    } catch {
      // Storage unavailable: the coach shows, which does not block the test.
    }
  }, FIRST_RUN_COACH_KEY);
});

test('the Project tab opens the example cases, with their sources, licences and references', async ({
  page,
  context,
}) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openApp(page);

  await page.getByRole('button', { name: 'Example cases…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Example cases' });
  await expect(dialog).toBeVisible();
  // The cursor is in the filter, ready to type.
  await expect(page.getByRole('searchbox', { name: 'Filter the example cases' })).toBeFocused();

  // The three cases of a first run are in the workspace, so each says so. All three have
  // machines, so the list has the one group of dynamic cases and none of steady-state ones.
  await expect(dialog.getByTestId('example-group-dynamic')).toBeVisible();
  await expect(dialog.getByTestId('example-group-steady-state')).toHaveCount(0);
  for (const id of ['ieee14', 'kundur', 'wscc9']) {
    await expect(dialog.getByTestId(`example-card-${id}`)).toBeVisible();
    await expect(dialog.getByTestId(`example-added-${id}`)).toHaveText('Added');
  }
  // A line under the filter says why they do, though nothing was added in this session.
  await expect(dialog.getByTestId('example-cases-workspace-note')).toContainText(
    'already in your workspace and say Added',
  );
  await expect(dialog.getByTestId('example-size-ieee14')).toHaveText('14 buses, 5 generators');
  await expect(dialog.getByTestId('example-analysis-ieee14-eig')).toHaveText('Eigenvalues');
  await expect(dialog.getByTestId('example-size-wscc9')).toHaveText('9 buses, 3 generators');
  await expect(dialog.getByTestId('example-analysis-wscc9-tds')).toHaveText('Time domain');
  await expect(dialog.getByTestId('example-analysis-wscc9-eig')).toHaveText('Eigenvalues');

  // What a link leaves of the window it is followed from: a new tab, with no hold on this one.
  for (const link of [
    dialog.getByTestId('example-source-ieee14'),
    dialog.getByTestId('example-licence-ieee14'),
  ]) {
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toHaveAttribute('href', /^https:\/\//);
  }

  // Cite shows the references and copies them, as text and as BibTeX.
  await dialog.getByRole('button', { name: /^Cite: IEEE 14-bus/ }).click();
  await expect(dialog.getByTestId('example-cite-panel-ieee14')).toBeVisible();
  await dialog.getByRole('button', { name: /^Copy as BibTeX: IEEE 14-bus/ }).click();
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: 'Copied the BibTeX' }),
  ).toBeVisible();
  // The panel says it too, in a region a screen reader hears, and keeps saying it.
  await expect(dialog.getByTestId('example-copy-status-ieee14')).toHaveText('Copied as BibTeX.');
  const bibtex = await page.evaluate(() => navigator.clipboard.readText());
  expect(bibtex).toContain('@article{cui2021andes');
  expect(bibtex).toContain('10.1109/TPWRS.2020.3017019');
  await dialog.getByRole('button', { name: /^Copy as text: IEEE 14-bus/ }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('Hybrid Symbolic-Numeric Framework');

  // The filter narrows the list to what is typed.
  await page.getByRole('searchbox', { name: 'Filter the example cases' }).fill('kundur');
  await expect(dialog.getByTestId('example-card-kundur')).toBeVisible();
  await expect(dialog.getByTestId('example-card-ieee14')).toBeHidden();
  await expect(dialog.getByTestId('example-cases-count')).toHaveText(/^1 of \d+$/);
  // The card that was hidden has what was opened in it when the filter lets it back.
  await page.getByRole('searchbox', { name: 'Filter the example cases' }).fill('');
  await expect(dialog.getByTestId('example-cite-panel-ieee14')).toBeVisible();
  expect(uncaughtErrors).toEqual([]);
});

test('Open on a card closes the dialog and puts the case on the diagram', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('example-cases-open').click();
  await page.getByRole('button', { name: /^Open: IEEE 14-bus/ }).click();

  await expect(page.getByTestId('example-cases-dialog')).toHaveCount(0);
  // The 14 buses of the case are drawn, and the Project tab names it as the loaded case.
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(14, { timeout: 90_000 });
  await expect(page.getByTestId('case-nav-loaded-name')).toHaveText('ieee14_full.xlsx');
  // ... and says how large it is, as the card did before it was opened.
  await expect(page.getByTestId('case-nav-loaded-size')).toHaveText('14 buses');

  // Asked again, the dialog says which case is the open one.
  await page.getByTestId('example-cases-open').click();
  await expect(page.getByTestId('example-open-now-ieee14')).toHaveText('Open now');
  await expect(page.getByRole('button', { name: /^Open: IEEE 14-bus/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Open: Kundur/ })).toBeEnabled();
});

test('the command palette finds the dialog, and Escape closes it and gives the keyboard back', async ({
  page,
}) => {
  await openApp(page);
  await page.keyboard.press('Control+k');
  await page.getByTestId('command-palette-input').fill('example');
  const command = page.getByTestId('command-palette-item-workspace.example-cases');
  await expect(command).toHaveText(/Example cases/);
  await page.keyboard.press('Enter');

  await expect(page.getByRole('dialog', { name: 'Example cases' })).toBeVisible();
  await expect(page.getByTestId('example-card-ieee14')).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Filter the example cases' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('example-cases-dialog')).toHaveCount(0);

  // The same dialog from the keyboard on the Project tab: the key that opened it opens it
  // again, and the focus comes back to the button.
  const button = page.getByTestId('example-cases-open');
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('example-cases-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('example-cases-dialog')).toHaveCount(0);
  await expect(button).toBeFocused();
});

test('Add on a case the list calls missing says the server has it, and the card turns to Added', async ({
  page,
}) => {
  // The list says WSCC 9 is not in the workspace, as it would for a workspace another tab changed;
  // the server, which holds the file, answers the add with a conflict. After that the list is
  // true again.
  let listIsStale = true;
  await page.route('**/api/examples', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      examples: { id: string; in_workspace: boolean }[];
    };
    if (listIsStale) {
      for (const example of body.examples) {
        if (example.id === 'wscc9') example.in_workspace = false;
      }
    }
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/examples/wscc9/add*', async (route) => {
    listIsStale = false;
    await route.continue();
  });
  await openApp(page);

  await page.getByTestId('example-cases-open').click();
  const add = page.getByRole('button', { name: /^Add to workspace: WSCC 9-bus/ });
  await expect(add).toBeVisible();
  await add.click();

  await expect(page.getByTestId('example-added-wscc9')).toHaveText('Added');
  await expect(page.getByTestId('example-note-wscc9')).toHaveText(
    'wscc9.xlsx is already in the workspace.',
  );
  // Focus goes to the button that replaced the one that was pressed.
  await expect(page.getByRole('button', { name: /^Open: WSCC 9-bus/ })).toBeFocused();
});

test('a WSCC 9 file that an earlier TENSA left in the workspace says it is a different file, and Replace puts this one there', async ({
  page,
}) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));
  await openApp(page);

  // What a workspace made by 0.5.0 holds under the name: another file. (Its bytes are not a
  // case, which nothing here opens.) The server compares them with the file it ships.
  const stale = await page.request.post('/api/workspace/files?name=wscc9.xlsx&overwrite=true', {
    data: Buffer.from('a network with no machines, as an earlier TENSA seeded it'),
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  expect(stale.ok()).toBe(true);

  try {
    await page.getByTestId('example-cases-open').click();
    const dialog = page.getByRole('dialog', { name: 'Example cases' });
    await expect(dialog.getByTestId('example-differs-wscc9')).toHaveText('Different file');
    await expect(dialog.getByTestId('example-added-wscc9')).toHaveCount(0);
    await expect(dialog.getByTestId('example-differs-note-wscc9')).toContainText(
      'The wscc9.xlsx in your workspace is not the file this version of TENSA ships',
    );
    // The two cases that hold the files that were shipped say Added, as before.
    await expect(dialog.getByTestId('example-added-ieee14')).toHaveText('Added');
    await expect(dialog.getByTestId('example-cases-workspace-note')).toContainText(
      'One case holds a file that is not the one this version of TENSA ships',
    );

    // Replace asks first, and Keep my file leaves the file as it is.
    await dialog.getByRole('button', { name: /^Replace with this version: WSCC 9-bus/ }).click();
    await expect(dialog.getByTestId('example-replace-confirm-wscc9')).toContainText(
      'Your file is overwritten and cannot be brought back.',
    );
    await expect(dialog.getByRole('button', { name: 'Keep my file' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Keep my file' }).click();
    await expect(dialog.getByTestId('example-replace-confirm-wscc9')).toHaveCount(0);
    await expect(dialog.getByTestId('example-differs-wscc9')).toBeVisible();

    // Confirmed, the shipped file goes over it: the card says Added, and so does the next read.
    await dialog.getByRole('button', { name: /^Replace with this version: WSCC 9-bus/ }).click();
    await dialog.getByTestId('example-replace-confirm-yes-wscc9').click();
    await expect(dialog.getByTestId('example-added-wscc9')).toHaveText('Added');
    await expect(dialog.getByTestId('example-differs-wscc9')).toHaveCount(0);
    await expect(dialog.getByTestId('example-note-wscc9')).toContainText('Replaced wscc9.xlsx.');
    await expect(dialog.getByRole('button', { name: /^Open: WSCC 9-bus/ })).toBeFocused();

    const listed = (await (await page.request.get('/api/examples')).json()) as {
      examples: { id: string; in_workspace: boolean; differs: boolean }[];
    };
    const wscc9 = listed.examples.find((example) => example.id === 'wscc9');
    expect(wscc9).toMatchObject({ in_workspace: true, differs: false });

    // Open loads it, and the nine buses of the case are drawn.
    await dialog.getByRole('button', { name: /^Open: WSCC 9-bus/ }).click();
    await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(9, { timeout: 90_000 });
  } finally {
    // Whatever happened above, the workspace the other specs share holds the shipped file.
    await page.request.post('/api/examples/wscc9/add?overwrite=true');
  }
  expect(uncaughtErrors).toEqual([]);
});
