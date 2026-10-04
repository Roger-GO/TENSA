/**
 * The built UI is split into chunks, and the server hands them out with the
 * headers that make the split pay off.
 *
 * What this checks, against the real bundle served by a real `tensa serve`:
 *
 * - the first load fetches the entry chunk and React, and none of the panels
 *   that come later (the diagram, the Analysis tab, the Arrow decoder, the
 *   command palette);
 * - the diagram's chunk arrives when a case is loaded and the Analysis tab's
 *   when that tab is opened, and the views inside the tab (EIG, CPF, SE) wait
 *   for their own sub-tab;
 * - the element tables load as their drawer tab is shown: the Buses table is the
 *   tab that is open from the start, so it follows the first paint, and the
 *   other four wait for their tab;
 * - every asset comes with `Cache-Control: immutable` (its name has a hash in
 *   it), and the large scripts come gzipped.
 *
 * It needs the built UI, so it only runs in the mode where the substrate serves
 * it (`E2E_NO_WEBSERVER`, see `playwright.config.ts`). Against the Vite dev
 * server there are no chunks to look at.
 */
import { test, expect, type Page } from '@playwright/test';

const CASE_FILE = 'ieee14_full.xlsx';
const BUS_COUNT = 14;

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';

test.skip(
  !process.env.E2E_NO_WEBSERVER,
  'checks the built bundle, which only the substrate serves (see playwright.config.ts)',
);

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, 'dismissed');
    } catch {
      // Storage unavailable: the coach shows, which does not block the test.
    }
  }, FIRST_RUN_COACH_KEY);
});

interface AssetHeaders {
  cacheControl: string | undefined;
  contentEncoding: string | undefined;
}

/** `/assets/SldCanvas-BZV40eAE.js` -> `SldCanvas`; the script and the style of a chunk share a name. */
function chunkName(pathname: string): string {
  return pathname.replace(/^\/assets\//, '').replace(/-[\w-]{8}\.(js|css)$/, '');
}

/** Record every `/assets/` response by chunk name, as it arrives. */
function watchAssets(page: Page): Map<string, AssetHeaders> {
  const assets = new Map<string, AssetHeaders>();
  page.on('response', (response) => {
    const { pathname } = new URL(response.url());
    if (!pathname.startsWith('/assets/')) return;
    const headers = response.headers();
    assets.set(chunkName(pathname), {
      cacheControl: headers['cache-control'],
      contentEncoding: headers['content-encoding'],
    });
  });
  return assets;
}

test('the first load fetches the entry chunks; the diagram and the Analysis tab load when used', async ({
  page,
}) => {
  const assets = watchAssets(page);
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));

  await page.goto('/');
  const caseRow = page.getByTestId(`saved-cases-row-${CASE_FILE}`);
  await expect(caseRow).toBeVisible();

  // ---- first load: the shell and React, nothing that comes later -----------
  expect([...assets.keys()]).toEqual(expect.arrayContaining(['index', 'vendor-react']));
  for (const later of [
    'SldCanvas',
    'AnalysisTab',
    'AnalyzePanel',
    'arrow',
    'CommandPalette',
    'LinesGrid',
    'GeneratorsGrid',
    'LoadsGrid',
    'ShuntsGrid',
  ]) {
    expect(assets.has(later), `${later} was fetched before it was needed`).toBe(false);
  }
  // The drawer opens on the Buses table, which follows the entry chunk.
  await expect.poll(() => assets.has('BusesGrid')).toBe(true);

  // ---- load a case: the diagram's chunk arrives ----------------------------
  // The UI opens its session in the background after the first paint, and a
  // click on a case before that does nothing. Click until the case request
  // actually goes out.
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
  expect(assets.has('SldCanvas')).toBe(true);
  expect(assets.has('AnalysisTab')).toBe(false);

  // ---- open another table: its chunk arrives ---------------------------------
  await page.getByTestId('bottom-drawer-tab-lines').click();
  await expect.poll(() => assets.has('LinesGrid')).toBe(true);
  expect(assets.has('ShuntsGrid')).toBe(false);

  // ---- open the Analysis tab: its chunk arrives, the views inside wait ------
  await page.getByTestId('bottom-drawer-tab-analysis').click();
  await expect(page.getByTestId('analysis-tab')).toBeVisible();
  expect(assets.has('AnalysisTab')).toBe(true);
  expect(assets.has('AnalyzePanel')).toBe(false);

  // The PF view (options and summary) is a chunk of its own, fetched with its sub-tab.
  expect(assets.has('PflowPanel')).toBe(false);
  await page.getByTestId('analysis-sub-tab-pf').click();
  await expect.poll(() => assets.has('PflowPanel')).toBe(true);
  expect(assets.has('AnalyzePanel')).toBe(false);

  await page.getByTestId('analysis-sub-tab-eig').click();
  await expect.poll(() => assets.has('AnalyzePanel')).toBe(true);

  // ---- every asset is immutable, and the big scripts are compressed ---------
  for (const [name, headers] of assets) {
    expect(headers.cacheControl, `${name} cache-control`).toBe(
      'public, max-age=31536000, immutable',
    );
  }
  for (const name of ['index', 'vendor-react', 'SldCanvas', 'AnalysisTab']) {
    expect(assets.get(name)?.contentEncoding, `${name} content-encoding`).toBe('gzip');
  }

  expect(uncaughtErrors).toEqual([]);
});

test('index.html is revalidated, and a missing chunk is a 404 and not the HTML shell', async ({
  request,
}) => {
  const index = await request.get('/');
  expect(index.ok()).toBe(true);
  expect(index.headers()['cache-control']).toBe('no-cache');

  const missing = await request.get('/assets/SldCanvas-00000000.js');
  expect(missing.status()).toBe(404);
  expect(missing.headers()['content-type'] ?? '').not.toContain('text/html');
});
