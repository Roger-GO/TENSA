/**
 * Example cases e2e: the dialog that lists the catalog, adds a case to the workspace and opens it.
 *
 *   Project tab -> Example cases: the cases, their sources and licences, Cite copies the references
 *   Open on a card -> the dialog closes and the case is on the diagram
 *   the command palette finds it; Escape closes it and the keyboard focus goes back
 *   a gallery case (WECC 179-bus, not seeded): Add copies it into the workspace, the card turns to Added, and
 *   Open puts its 179 buses on the diagram
 *   a small gallery case (PJM 5-bus): Add and Open put its 5 buses on the diagram, its four TG2 governors are
 *   in the Governors table, and the line trip the file holds is in the list of disturbances
 *   the wind turbine gallery case (IEEE 14-bus with a type-3 wind turbine): Add and Open put its 14 buses on
 *   the diagram, and the chain of the unit at bus 8 holds the converter, its two controls and the four models of
 *   the turbine, none of them an orphan badge
 *   the steady-state gallery case (IEEE 118-bus): the dialog lists it in a group of its own, Add and Open put its
 *   118 buses on the diagram as a static case, and a power flow leaves the six generators past a reactive limit
 *   that its catalog entry names
 *   the Exciters and Governors tables hold every exciter and governor the catalog counts for the case: the
 *   IEEE 39 governors (TGOV1N), the exciters of Kundur (EXDC2) and the 29 exciters and 29 governors of WECC
 *   a case the list calls missing, which the server has: Add says it is there, and the card turns to Added
 *   a bundled case whose file in the workspace is another one: the card says so, and Replace puts the shipped one there
 *
 * It drives the real UI against a real `tensa serve` (nothing but the one list in the last test is
 * answered by the test), on a workspace the server seeded with the five first-run cases, all of
 * which have machines. The catalog is the server's own, so what is held of the cases is what
 * the dialog shows of any case: the size, the analyses, the links that open in a new tab, the
 * references and the buttons.
 */
import { test, expect, type Page } from './fixtures';
import { openCopy } from './sldDrawing';

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

  // The five cases of a first run are in the workspace, so each says so. All of them have
  // machines, so they are in the group of dynamic cases with the gallery's other cases that do;
  // the IEEE 118-bus case of the gallery has none, and is the one case of the steady-state group.
  await expect(dialog.getByTestId('example-group-dynamic')).toBeVisible();
  const steady = dialog.getByTestId('example-group-steady-state');
  await expect(steady).toBeVisible();
  await expect(steady.getByTestId(/^example-card-/)).toHaveCount(1);
  await expect(steady.getByTestId('example-card-ieee118')).toBeVisible();
  for (const id of ['ieee14', 'kundur', 'wscc9', 'ieee39', 'npcc']) {
    await expect(dialog.getByTestId(`example-card-${id}`)).toBeVisible();
    await expect(dialog.getByTestId(`example-added-${id}`)).toHaveText('Added');
  }
  // The gallery case is listed with its size, and is not one of them. Nor are the three small ones.
  await expect(dialog.getByTestId('example-card-wecc')).toBeVisible();
  await expect(dialog.getByTestId('example-size-wecc')).toHaveText('179 buses, 29 generators');
  await expect(dialog.getByTestId('example-size-kundur_pss')).toHaveText('10 buses, 4 generators');
  await expect(dialog.getByTestId('example-size-ieee14_fault')).toHaveText(
    '14 buses, 5 generators',
  );
  await expect(dialog.getByTestId('example-size-pjm5bus')).toHaveText('5 buses, 4 generators');
  await expect(dialog.getByTestId('example-size-ieee14_solar')).toHaveText(
    '14 buses, 5 generators',
  );
  await expect(dialog.getByTestId('example-size-ieee14_wt3')).toHaveText('14 buses, 5 generators');
  await expect(dialog.getByTestId('example-size-ieee118')).toHaveText('118 buses, 54 generators');
  // A line under the filter says why they do, though nothing was added in this session.
  await expect(dialog.getByTestId('example-cases-workspace-note')).toContainText(
    'already in your workspace and say Added',
  );
  await expect(dialog.getByTestId('example-size-ieee14')).toHaveText('14 buses, 5 generators');
  await expect(dialog.getByTestId('example-analysis-ieee14-eig')).toHaveText('Eigenvalues');
  await expect(dialog.getByTestId('example-size-wscc9')).toHaveText('9 buses, 3 generators');
  await expect(dialog.getByTestId('example-size-ieee39')).toHaveText('39 buses, 10 generators');
  await expect(dialog.getByTestId('example-size-npcc')).toHaveText('140 buses, 48 generators');
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
  await dialog.getByRole('button', { name: /^Cite: IEEE 14-bus, with machines/ }).click();
  await expect(dialog.getByTestId('example-cite-panel-ieee14')).toBeVisible();
  await dialog.getByRole('button', { name: /^Copy as BibTeX: IEEE 14-bus, with machines/ }).click();
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: 'Copied the BibTeX' }),
  ).toBeVisible();
  // The panel says it too, in a region a screen reader hears, and keeps saying it.
  await expect(dialog.getByTestId('example-copy-status-ieee14')).toHaveText('Copied as BibTeX.');
  const bibtex = await page.evaluate(() => navigator.clipboard.readText());
  expect(bibtex).toContain('@article{cui2021andes');
  expect(bibtex).toContain('10.1109/TPWRS.2020.3017019');
  await dialog.getByRole('button', { name: /^Copy as text: IEEE 14-bus, with machines/ }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('Hybrid Symbolic-Numeric Framework');

  // The filter narrows the list to what is typed.
  await page.getByRole('searchbox', { name: 'Filter the example cases' }).fill('kundur');
  await expect(dialog.getByTestId('example-card-kundur')).toBeVisible();
  await expect(dialog.getByTestId('example-card-kundur_pss')).toBeVisible();
  await expect(dialog.getByTestId('example-card-ieee14')).toBeHidden();
  await expect(dialog.getByTestId('example-cases-count')).toHaveText(/^2 of \d+$/);
  // The card that was hidden has what was opened in it when the filter lets it back.
  await page.getByRole('searchbox', { name: 'Filter the example cases' }).fill('');
  await expect(dialog.getByTestId('example-cite-panel-ieee14')).toBeVisible();
  expect(uncaughtErrors).toEqual([]);
});

test('Open on a card closes the dialog and puts the case on the diagram', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('example-cases-open').click();
  await page.getByRole('button', { name: /^Open: IEEE 14-bus, with machines/ }).click();

  await expect(page.getByTestId('example-cases-dialog')).toHaveCount(0);
  // The 14 buses of the case are drawn, and the Project tab names it as the loaded case.
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(14, { timeout: 90_000 });
  await expect(page.getByTestId('case-nav-loaded-name')).toHaveText('ieee14_full.xlsx');
  // ... and says how large it is, as the card did before it was opened.
  await expect(page.getByTestId('case-nav-loaded-size')).toHaveText('14 buses');

  // Asked again, the dialog says which case is the open one.
  await page.getByTestId('example-cases-open').click();
  await expect(page.getByTestId('example-open-now-ieee14')).toHaveText('Open now');
  await expect(page.getByRole('button', { name: /^Open: IEEE 14-bus, with machines/ })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: /^Open: Kundur two-area system, modified/ }),
  ).toBeEnabled();
});

test('a gallery case is added to the workspace from its card, and opened on the diagram', async ({
  page,
}) => {
  await openApp(page);
  await page.getByTestId('example-cases-open').click();
  const dialog = page.getByRole('dialog', { name: 'Example cases' });
  // The WECC case is not seeded, so its card offers Add. (Another run on the same workspace may
  // have added it: the card then says Added at once, and the add is skipped.)
  await expect(dialog.getByTestId('example-card-wecc')).toBeVisible();
  const add = dialog.getByTestId('example-add-wecc');
  if ((await add.count()) > 0) {
    await expect(add).toHaveText('Add to workspace');
    await add.click();
  }
  await expect(dialog.getByTestId('example-added-wecc')).toHaveText('Added');
  // What the server keeps of the case it was asked for: the file, and where it came from.
  const listed = (await (await page.request.get('/api/examples')).json()) as {
    examples: { id: string; in_workspace: boolean; differs: boolean }[];
  };
  expect(listed.examples.find((example) => example.id === 'wecc')).toMatchObject({
    in_workspace: true,
    differs: false,
  });
  await expect(page.getByTestId('saved-cases-row-wecc_full.xlsx')).toBeVisible();

  await dialog.getByTestId('example-open-wecc').click();
  await expect(page.getByTestId('example-cases-dialog')).toHaveCount(0);
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(179, { timeout: 90_000 });
  await expect(page.getByTestId('case-nav-loaded-name')).toHaveText('wecc_full.xlsx');
  await expect(page.getByTestId('case-nav-loaded-size')).toHaveText('179 buses');

  // Its tables hold what its entry counts: an exciter on each of the 29 machines (17 EXST1, 8
  // ESDC2A and 4 ESST3A) and an IEEEG1 governor on each.
  await page.getByTestId('bottom-drawer-tab-exciters').click();
  await expect(page.getByTestId('exciters-grid-model-EXST1')).toContainText('17');
  await expect(page.getByTestId('exciters-grid-model-ESDC2A')).toContainText('8');
  await expect(page.getByTestId('exciters-grid-model-ESST3A')).toContainText('4');
  await page.getByTestId('bottom-drawer-tab-governors').click();
  await expect(page.getByTestId('governors-grid-model-IEEEG1')).toContainText('29');
});

test('a small gallery case is added, opened with its governors and the trip its file holds', async ({
  page,
}) => {
  await openApp(page);
  await page.getByTestId('example-cases-open').click();
  const dialog = page.getByRole('dialog', { name: 'Example cases' });
  await expect(dialog.getByTestId('example-card-pjm5bus')).toBeVisible();
  const add = dialog.getByTestId('example-add-pjm5bus');
  if ((await add.count()) > 0) {
    await add.click();
  }
  await expect(dialog.getByTestId('example-added-pjm5bus')).toHaveText('Added');
  await dialog.getByTestId('example-open-pjm5bus').click();
  await expect(page.getByTestId('example-cases-dialog')).toHaveCount(0);
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(5, { timeout: 90_000 });
  await expect(page.getByTestId('case-nav-loaded-name')).toHaveText('pjm5bus.xlsx');

  // A TG2 governor on each of its four machines, which the table left out while the topology did
  // not list the model, and a GOV chip on each generator's symbol.
  await page.getByTestId('bottom-drawer-tab-governors').click();
  await expect(page.getByTestId('governors-grid-model-TG2')).toContainText('4');
  await expect(page.getByTestId(/^unit-chip-TG2-\d+$/)).toHaveCount(4);
  // The trip of the second line between buses 1 and 2 at 2 s is the file's, and says so.
  const trip = page.getByText('Toggle Line 6');
  await expect(trip).toBeVisible();
  await expect(page.getByText(/^Set by the case/).first()).toBeVisible();
});

test('the wind turbine gallery case is added and opened, with the four turbine models in the chain of its unit', async ({
  page,
}) => {
  await openApp(page);
  await page.getByTestId('example-cases-open').click();
  const dialog = page.getByRole('dialog', { name: 'Example cases' });
  await expect(dialog.getByTestId('example-card-ieee14_wt3')).toBeVisible();
  const add = dialog.getByTestId('example-add-ieee14_wt3');
  if ((await add.count()) > 0) {
    await add.click();
  }
  await expect(dialog.getByTestId('example-added-ieee14_wt3')).toHaveText('Added');
  await dialog.getByTestId('example-open-ieee14_wt3').click();
  await expect(page.getByTestId('example-cases-dialog')).toHaveCount(0);
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(14, { timeout: 90_000 });
  await expect(page.getByTestId('case-nav-loaded-name')).toHaveText('ieee14_wt3.xlsx');

  // The generator at bus 8 is one unit: its converter, the electrical and plant control of the
  // converter, and the drive train, aerodynamics, pitch and torque control of the turbine, each
  // under the one it names. The topology did not list the last four, so the unit showed a
  // converter and nothing of a turbine. A chain that is drawn out is kept with the case, so it
  // is drawn out in a copy of this run's own and the gallery's file keeps its layout.
  await openCopy(page, `wt3-e2e-${Date.now()}`);
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(14, { timeout: 90_000 });
  await page.getByRole('button', { name: 'Show the control chain of generator 5' }).click();
  await expect(page.getByTestId('unit-chain-5').getByRole('button')).toHaveText([
    'PV5',
    '└REGCA11REGC',
    '└REECA11REEC',
    '└REPCA11REPC',
    '└WTDTA11WTDT',
    '└WTARA11WTAR',
    '└WTPTA11WTPT',
    '└WTTQA11WTTQ',
  ]);
  // None of them is left in the gutter as a badge of its own.
  await expect(page.locator('[data-orphan="true"]')).toHaveCount(0);
  // The line trip and its reclose are the file's.
  await expect(page.getByText('Set by the case (Toggler_1)')).toBeVisible();
  await expect(page.getByText('Set by the case (Toggler_2)')).toBeVisible();
});

test('the steady-state gallery case is added and opened as a static case, and a power flow leaves six generators past a reactive limit', async ({
  page,
}) => {
  await openApp(page);
  await page.getByTestId('example-cases-open').click();
  const dialog = page.getByRole('dialog', { name: 'Example cases' });
  const steady = dialog.getByTestId('example-group-steady-state');
  // It says it supports a power flow and nothing else.
  await expect(steady.getByTestId('example-card-ieee118')).toContainText('Power flow');
  await expect(steady.getByTestId('example-card-ieee118')).not.toContainText('Time domain');
  const add = dialog.getByTestId('example-add-ieee118');
  if ((await add.count()) > 0) {
    await add.click();
  }
  await expect(dialog.getByTestId('example-added-ieee118')).toHaveText('Added');
  await dialog.getByTestId('example-open-ieee118').click();
  await expect(page.getByTestId('example-cases-dialog')).toHaveCount(0);
  await expect(page.getByTestId('case-nav-loaded-name')).toHaveText('case118.m', {
    timeout: 90_000,
  });
  await expect(page.getByText('118 buses', { exact: true })).toBeVisible();
  await expect(page.getByText('Static-only')).toBeVisible();

  await page.getByTestId('run-pflow-button').click();
  await expect(page.getByTestId('bottom-drawer-tab-violations')).toContainText('6', {
    timeout: 60_000,
  });
});

test('the Exciters and Governors tables list the exciters and governors the catalog counts, on IEEE 39 and Kundur', async ({
  page,
}) => {
  // IEEE 39 has a TGOV1N governor on each of its ten machines, which the table left out.
  await openApp(page);
  await page.getByTestId('saved-cases-row-ieee39_full.xlsx').click();
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(39, { timeout: 90_000 });
  await page.getByTestId('bottom-drawer-tab-governors').click();
  await expect(page.getByTestId('governors-grid-model-TGOV1N')).toContainText('10');
  await page.getByTestId('bottom-drawer-tab-exciters').click();
  await expect(page.getByTestId('exciters-grid-model-IEEEX1')).toContainText('10');

  // Kundur has an EXDC2 exciter on each of its four machines.
  await page.getByTestId('saved-cases-row-kundur_full.xlsx').click();
  await expect(page.getByTestId('case-nav-loaded-name')).toHaveText('kundur_full.xlsx');
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(10, { timeout: 90_000 });
  await page.getByTestId('bottom-drawer-tab-exciters').click();
  await expect(page.getByTestId('exciters-grid-model-EXDC2')).toContainText('4');
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
  // The dialog hands the keyboard back a tick after it has left the page, from the one place
  // where it keeps what had the focus when it opened, which the next opening writes too. Press
  // Enter before that tick and the first close takes the button's place there, so the second
  // close finds nothing and sends the keyboard to the Project tab. Wait until it is back.
  await page.waitForFunction(() => document.activeElement !== document.body);

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
