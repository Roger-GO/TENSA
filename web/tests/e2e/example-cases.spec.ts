/**
 * Example cases e2e: the dialog that lists the catalog, adds a case to the workspace and opens it.
 *
 *   Project tab -> Example cases: the cases, their sources and licences, Cite copies the references
 *   Open on a card -> the dialog closes and the case is on the diagram
 *   the command palette finds it; Escape closes it and the keyboard focus goes back
 *   a case the list calls missing, which the server has: Add says it is there, and the card turns to Added
 *
 * It drives the real UI against a real `tensa serve` (nothing but the one list in the last test is
 * answered by the test), on a workspace the server seeded with the three first-run cases. The
 * catalog is the server's own, so what is held of the three cases is what the dialog shows of any
 * case: the size, the analyses, the links that open in a new tab, the references and the buttons.
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

  // The three cases of a first run are in the workspace, so each says so; the two with
  // machines are dynamic and the third is a network for power flow.
  await expect(dialog.getByTestId('example-group-dynamic')).toBeVisible();
  await expect(dialog.getByTestId('example-group-steady-state')).toBeVisible();
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
  await expect(dialog.getByTestId('example-analysis-wscc9-tds')).toHaveCount(0);

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
