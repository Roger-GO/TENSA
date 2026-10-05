/**
 * Case upload e2e: add case files to the workspace from the browser.
 *
 *   drop a file on the window -> it is stored in the workspace and opens
 *   choose files with Add files -> they are listed; a taken name asks to replace
 *   open a case -> it is listed under Recent, and still is after a reload
 *
 * It drives the real UI against a real `tensa serve` (nothing is mocked), so it is
 * the test that checks the browser's own drag-and-drop and file chooser, which the
 * unit tests can only imitate, and that what the server stores is a case ANDES
 * loads. `playwright.config.ts` says how to start the substrate. Every test uses a
 * file name of its own, so repeated runs against one workspace do not collide.
 */
import { test, expect, type Page } from '@playwright/test';

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';

/** A three-bus MATPOWER case, the smallest thing ANDES loads and solves. */
const TINY_CASE = `function mpc = tiny3
mpc.version = '2';
mpc.baseMVA = 100;
mpc.bus = [
  1 3 0 0 0 0 1 1.0 0 110 1 1.1 0.9;
  2 2 0 0 0 0 1 1.0 0 110 1 1.1 0.9;
  3 1 90 30 0 0 1 1.0 0 110 1 1.1 0.9;
];
mpc.gen = [
  1 0 0 300 -300 1.0 100 1 250 10 0 0 0 0 0 0 0 0 0 0 0;
  2 80 0 300 -300 1.0 100 1 250 10 0 0 0 0 0 0 0 0 0 0 0;
];
mpc.branch = [
  1 2 0.01 0.1 0.02 250 250 250 0 0 1 -360 360;
  2 3 0.01 0.1 0.02 250 250 250 0 0 1 -360 360;
  1 3 0.01 0.1 0.02 250 250 250 0 0 1 -360 360;
];
`;

/** A name no other run has used. */
function uniqueName(stem: string, ext: string): string {
  return `${stem}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}${ext}`;
}

/** The browser's own DataTransfer, holding one file, as a drag from the desktop carries it. */
async function dragOfFile(page: Page, name: string, content: string) {
  return await page.evaluateHandle(
    ({ name: fileName, content: text }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([text], fileName));
      return transfer;
    },
    { name, content },
  );
}

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

const toast = (page: Page, text: string) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text });

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, 'dismissed');
    } catch {
      // Storage unavailable: the coach shows, which does not block the test.
    }
  }, FIRST_RUN_COACH_KEY);
});

test('drop a case file on the window: it is stored in the workspace and opens', async ({
  page,
}) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));
  const name = uniqueName('dropped', '.m');
  await openApp(page);

  // Dragging a file over the window shows the hint, and moving it away hides it.
  const transfer = await dragOfFile(page, name, TINY_CASE);
  await page.dispatchEvent('body', 'dragenter', { dataTransfer: transfer });
  await expect(page.getByTestId('workspace-drop-overlay')).toBeVisible();
  await page.dispatchEvent('body', 'dragleave', { dataTransfer: transfer });
  await expect(page.getByTestId('workspace-drop-overlay')).toBeHidden();

  // Dropping it adds the file under its own name...
  await page.dispatchEvent('body', 'dragenter', { dataTransfer: transfer });
  await page.dispatchEvent('body', 'drop', { dataTransfer: transfer });
  await expect(page.getByTestId('workspace-drop-overlay')).toBeHidden();
  await expect(toast(page, `Added ${name} to the workspace.`)).toBeVisible();
  await expect(page.getByTestId(`saved-cases-row-${name}`)).toBeVisible();
  // ...and, since nothing was open, opens it: its three buses are on the diagram.
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(3, { timeout: 90_000 });
  expect(uncaughtErrors).toEqual([]);
});

test('Add files lists the files, asks before replacing one, and refuses what is not a case', async ({
  page,
}) => {
  const bad = uniqueName('notes', '.txt');
  const dyr = uniqueName('chosen', '.dyr');
  const name = uniqueName('chosen', '.m');
  await openApp(page);
  const chooser = page.getByTestId('add-case-files-input');

  // Nothing but a case file is taken, and the page says so without sending it.
  await chooser.setInputFiles({ name: bad, mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(toast(page, `${bad} is not a case file`)).toBeVisible();
  await expect(page.getByTestId(`saved-cases-row-${bad}`)).toHaveCount(0);

  // A dynamic file is added, and stays unopened: it loads with a case.
  await chooser.setInputFiles({ name: dyr, mimeType: 'text/plain', buffer: Buffer.from('dyr') });
  await expect(toast(page, `Added ${dyr} to the workspace.`)).toBeVisible();
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(0);

  // The same name again is not replaced silently: the toast asks.
  await chooser.setInputFiles({ name: dyr, mimeType: 'text/plain', buffer: Buffer.from('new') });
  const taken = toast(page, `${dyr} is already in the workspace.`);
  await expect(taken).toBeVisible();
  await taken.getByRole('button', { name: 'Replace' }).click();
  await expect(toast(page, `Replaced ${dyr} in the workspace.`)).toBeVisible();

  // A case file is listed and, with nothing open, opens.
  await chooser.setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(TINY_CASE) });
  await expect(page.getByTestId(`saved-cases-row-${name}`)).toBeVisible();
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(3, { timeout: 90_000 });
});

test('an opened case is listed under Recent, and still is after a reload', async ({ page }) => {
  const name = uniqueName('recent', '.m');
  await openApp(page);
  // Nothing has been opened in this browser profile yet.
  await expect(page.getByTestId('saved-cases-recent-group')).toHaveCount(0);

  await page.getByTestId('add-case-files-input').setInputFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(TINY_CASE),
  });
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(3, { timeout: 90_000 });
  await expect(page.getByTestId(`saved-cases-recent-${name}`)).toBeVisible();

  // A reload starts an empty session, and the list still remembers the case.
  await page.reload();
  await expect(page.getByTestId('saved-cases-list')).toBeVisible();
  const recent = page.getByTestId(`saved-cases-recent-${name}`);
  await expect(recent).toBeVisible();
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(0);

  // Opening it from there loads that file. A click before the session exists does
  // nothing, so click until the case request actually goes out.
  await expect(async () => {
    const [request] = await Promise.all([
      page.waitForRequest(
        (r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/case'),
        { timeout: 2_000 },
      ),
      recent.click(),
    ]);
    expect(request.postDataJSON()).toEqual({ primary_path: name, addfiles: null });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(3, { timeout: 90_000 });
});
