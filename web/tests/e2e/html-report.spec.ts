/**
 * Save a study as one HTML file.
 *
 *   load IEEE 14 -> run a power flow -> run it again with the generators held at
 *   their reactive limits -> run a short time-domain simulation -> Reports ->
 *   Save as HTML -> the file holds the power flow's tables, the comparison of
 *   the two power flows, a chart of the run and ANDES's own report -> it opens
 *   on its own, with no script and nothing fetched
 *
 * It drives the real UI against a real `tensa serve` (see `playwright.config.ts`)
 * and reads the file the browser was handed. The unit tests check the document
 * against stand-in results; this one checks that what ANDES solved and streamed
 * reaches the file, that the server's own paths do not, and that a real browser
 * renders the file from disk under its own content policy.
 */
import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';

const CASE_FILE = 'ieee14_full.xlsx';

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

/** Open a case from the saved-cases list (see load-pf-flow.spec.ts for why this retries). */
async function openCase(page: Page, caseFile: string): Promise<void> {
  const caseRow = page.getByTestId(`saved-cases-row-${caseFile}`);
  await expect(caseRow).toBeVisible();
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
  await expect(page.getByTestId('run-pflow-button')).toBeEnabled({ timeout: 90_000 });
}

/** Reports -> Save as HTML: the file the browser was handed, saved at `path`. */
async function saveReport(
  page: Page,
  path: string,
): Promise<{ file: string; html: string; name: string }> {
  await page.getByTestId('topbar-menu-workspace-trigger').click();
  await page.getByTestId('topbar-menu-workspace-report').click();
  await expect(page.getByTestId('report-dialog')).toBeVisible();
  // The dialog fits the window, so the button is in reach above a long report.
  const save = page.getByTestId('report-save-html');
  await expect(save).toBeInViewport();
  const [download] = await Promise.all([page.waitForEvent('download'), save.click()]);
  await expect(
    page
      .locator('[data-sonner-toast]')
      .filter({ hasText: /Exported ieee14_full_report_/ })
      .first(),
  ).toBeVisible();
  await download.saveAs(path);
  return { file: path, html: await readFile(path, 'utf8'), name: download.suggestedFilename() };
}

test('a power flow, a comparison and a run are saved as one HTML report', async ({
  page,
  context,
}, testInfo) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));

  await page.goto('/');
  await openCase(page, CASE_FILE);
  await page.getByRole('tab', { name: 'Analysis' }).click();

  // ---- two power flows to compare ----------------------------------------------
  await page.getByTestId('analysis-sub-tab-pf').click();
  const converged = page
    .locator('[data-sonner-toast]')
    .filter({ hasText: /PF converged in \d+ iterations/ });
  await page.getByTestId('pflow-options-run').click();
  await expect(converged).toHaveCount(1, { timeout: 90_000 });
  await page.getByTestId('pflow-enforce-q-limits').check();
  await page.getByTestId('pflow-options-run').click();
  await expect(converged).toHaveCount(2, { timeout: 90_000 });

  // ---- the report of the power flow alone ------------------------------------------
  const first = await saveReport(page, testInfo.outputPath('power-flow.html'));
  // ANDES heads its own report with the case file. It is named, and the
  // server's path to it is not in the file.
  expect(first.html).toContain('Case file: ieee14_full.xlsx');
  expect(first.html).not.toMatch(/Case file: [/\\]|Case file: [A-Za-z]:/);
  expect(first.html).toContain('<h3>Power flow</h3>');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('report-dialog')).toBeHidden();

  // ---- a short time-domain run ---------------------------------------------------
  await page.getByTestId('analysis-sub-tab-tds').click();
  await page.locator('#tds-config-tf').fill('2');
  await page.getByTestId('run-mode-tds').click();
  await page.getByTestId('run-tds-button').click();
  await expect(page.getByTestId('tds-run-status-badge')).toContainText(/done/i, {
    timeout: 120_000,
  });
  await expect(page.getByTestId('time-series-plot-group-bus_v')).toBeVisible();

  // ---- the report of the whole study ------------------------------------------------
  const { file, html, name } = await saveReport(page, testInfo.outputPath('study.html'));
  expect(name).toMatch(/^ieee14_full_report_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.html$/);
  expect(html.startsWith('<!doctype html>')).toBe(true);
  expect(html).not.toContain('<script');

  // ---- the file, opened from disk by a browser ----------------------------------------
  const report = await context.newPage();
  const reportProblems: string[] = [];
  report.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      reportProblems.push(message.text());
    }
  });
  report.on('pageerror', (error) => reportProblems.push(error.message));
  const requests: string[] = [];
  report.on('request', (request) => requests.push(request.url()));
  await report.goto(`file://${file}`);

  await expect(report.locator('h1')).toHaveText('ieee14_full');
  await expect(report.locator('header .meta')).toContainText(
    /by TENSA \d+\.\d+\S* with ANDES \d+\./,
  );
  await expect(report.locator('nav a')).toHaveText([
    'Power flow',
    'Power flow comparison',
    'Time-domain runs',
    'ANDES reports',
  ]);

  // The power flow: the one solved last, since the run has moved the system on.
  const powerFlow = report.locator('#power-flow');
  await expect(powerFlow.locator('.meta').first()).toContainText(
    'The last power flow solved: PF #2, solved on ieee14_full at',
  );
  await expect(powerFlow).toContainText(/Converged in \d+ iterations/);
  await expect(powerFlow.getByRole('heading', { name: 'Buses (14)' })).toBeVisible();
  await expect(
    powerFlow.getByRole('heading', { name: 'Lines and transformers (20)' }),
  ).toBeVisible();
  const generation = powerFlow.locator('table').first().locator('tbody tr').first().locator('td');
  await expect(generation.nth(0)).toHaveText('Generation');
  expect(Number(await generation.nth(1).textContent())).toBeGreaterThan(100);

  // The comparison: fourteen buses, the largest change first, with its sign.
  const comparison = report.locator('#comparison');
  await expect(comparison).toContainText(/Largest change: ΔV [+-]\d\.\d{4} pu at /);
  const buses = comparison.locator('table').first().locator('tbody tr');
  await expect(buses).toHaveCount(14);
  await expect(buses.first().locator('td').nth(4)).toHaveText(/^[+-]\d\.\d{5}$/);

  // The run: listed, and charted as vector graphics that the browser drew.
  const runs = report.locator('#time-domain');
  await expect(runs.locator('table').first().locator('tbody tr')).toHaveCount(1);
  await expect(runs.locator('figcaption').first()).toHaveText('Bus voltage (pu)');
  const chart = runs.locator('svg').first();
  expect(await chart.locator('polyline').count()).toBeGreaterThan(3);
  const box = await chart.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(300);
  expect(box?.height ?? 0).toBeGreaterThan(100);

  // ANDES's own text, in the appendix.
  await expect(report.locator('#andes-reports pre').first()).toContainText(
    'Time Domain Simulation Summary',
  );

  // It asked the network for nothing and its own policy was not tripped.
  expect(requests.filter((url) => !url.startsWith('file://'))).toEqual([]);
  expect(reportProblems).toEqual([]);
  expect(uncaughtErrors).toEqual([]);
});
