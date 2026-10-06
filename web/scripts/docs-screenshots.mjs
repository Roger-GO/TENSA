/**
 * Screenshots for the documentation site (docs/img/ui-*.jpg): the window after a power flow,
 * a time-domain run with a fault, the eigenvalue plot and the continuation power flow curve.
 * The UI tour (docs/ui-tour.md) shows them, so rerun this after a change that moves the
 * layout the tour describes.
 *
 * Prereqs: a running server with the built SPA and a fresh workspace (a new workspace is
 * seeded with the IEEE 14 and Kundur cases the script opens), e.g.
 *   tensa serve --port 18800 --workspace "$(mktemp -d)" --max-sessions 16
 *
 * Run:
 *   cd web && node scripts/docs-screenshots.mjs [baseUrl] [outDir]
 *
 * Output: ui-overview.jpg, ui-tds.jpg, ui-eig.jpg and ui-cpf.jpg in outDir (../docs/img by
 * default), each a 1600 x 1000 JPEG. The last three show the results view (Ctrl+Shift+M), which
 * gives a plot the whole window.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:18800';
const OUT_DIR = process.argv[3] ?? '../docs/img';
const SIZE = { width: 1600, height: 1000 };

/** The first-run coach is a floating card that would sit over the diagram. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';

async function openApp(browser) {
  const context = await browser.newContext({ viewport: SIZE });
  await context.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, 'dismissed');
    } catch {
      // Storage unavailable: the coach shows, which only costs a card in the picture.
    }
  }, FIRST_RUN_COACH_KEY);
  const page = await context.newPage();
  await page.goto(BASE_URL);
  return page;
}

/** Click the case row until its load request goes out (the session opens after first paint). */
async function loadCase(page, file) {
  const row = page.getByTestId(`saved-cases-row-${file}`);
  await row.waitFor();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await Promise.all([
        page.waitForRequest(
          (request) =>
            request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/case'),
          { timeout: 2_000 },
        ),
        row.click(),
      ]);
      break;
    } catch {
      // The click came before the session existed: try again.
    }
  }
  await page
    .getByTestId(/^bus-node-\d+$/)
    .first()
    .waitFor({ timeout: 120_000 });
  await page.waitForTimeout(1_500);
}

async function runPowerFlow(page) {
  await page.getByTestId('run-pflow-button').click();
  await page
    .locator('[data-sonner-toast]')
    .filter({ hasText: /PF converged/ })
    .waitFor({ timeout: 90_000 });
  await dismissToasts(page);
}

/** A toast over the top bar or the diagram is not part of what the page describes. */
async function dismissToasts(page) {
  await page.addStyleTag({ content: '[data-sonner-toaster] { display: none !important; }' });
  await page.waitForTimeout(800);
}

/** The results view: the diagram steps aside and the analysis tabs get the window. */
async function showResultsView(page) {
  await page.keyboard.press('Control+Shift+M');
  await page.waitForTimeout(1_500);
}

async function openAnalysis(page, sub) {
  await page.getByRole('tab', { name: 'Analysis', exact: true }).click();
  await page.getByTestId(`analysis-sub-tab-${sub}`).click();
  await page.waitForTimeout(600);
}

/**
 * Numbered markers over the named regions, so the tour can say "area 3". Each is a circle at
 * the top left of its region, drawn into the page and not into the app.
 */
async function markRegions(page, regions) {
  await page.evaluate((list) => {
    list.forEach(({ testId, number, dx = 8, dy = 8 }) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      if (!element) return;
      const box = element.getBoundingClientRect();
      const badge = document.createElement('div');
      badge.textContent = String(number);
      Object.assign(badge.style, {
        position: 'fixed',
        left: `${box.left + dx}px`,
        top: `${box.top + dy}px`,
        width: '26px',
        height: '26px',
        borderRadius: '50%',
        background: '#2563eb',
        color: '#fff',
        font: '600 15px sans-serif',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 0 0 3px #fff',
        zIndex: '99999',
        pointerEvents: 'none',
      });
      document.body.appendChild(badge);
    });
  }, regions);
}

async function shoot(page, name) {
  await page.screenshot({ path: join(OUT_DIR, name), type: 'jpeg', quality: 82 });
  console.log(`wrote ${join(OUT_DIR, name)}`);
}

mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
try {
  // The window after a power flow: five areas, numbered.
  let page = await openApp(browser);
  await loadCase(page, 'ieee14_full.xlsx');
  await runPowerFlow(page);
  await markRegions(page, [
    { testId: 'top-bar', number: 1, dx: 596, dy: 9 },
    { testId: 'app-shell-left-sidebar', number: 2, dx: 250, dy: 40 },
    { testId: 'app-shell-canvas', number: 3, dx: 830, dy: 250 },
    { testId: 'app-shell-right-inspector', number: 4, dx: 8, dy: 8 },
    { testId: 'app-shell-bottom-drawer', number: 5, dx: 1000, dy: 8 },
  ]);
  await shoot(page, 'ui-overview.jpg');
  await page.context().close();

  // A fault on bus 4, applied at 1.0 s and cleared at 1.1 s, and the voltages it moves.
  page = await openApp(browser);
  await loadCase(page, 'ieee14_full.xlsx');
  await page.getByTestId('run-mode-tds').click();
  await page.getByRole('button', { name: 'Add fault' }).first().click();
  const dialog = page.getByTestId('add-event-dialog');
  await dialog.locator('select').nth(1).selectOption({ label: '4 — BUS4' });
  await page.getByTestId('add-event-save').click();
  await page.getByTestId('run-tds-button').click();
  await page.getByTestId('run-tds-button').filter({ hasText: 'Reset run' }).waitFor({
    timeout: 120_000,
  });
  await dismissToasts(page);
  await showResultsView(page);
  await shoot(page, 'ui-tds.jpg');
  await page.context().close();

  // Eigenvalues of the Kundur two-area system after its power flow.
  page = await openApp(browser);
  await loadCase(page, 'kundur_full.xlsx');
  await runPowerFlow(page);
  await openAnalysis(page, 'eig');
  await page.getByRole('button', { name: 'Run EIG' }).first().click();
  await page.waitForTimeout(8_000);
  // The scatter starts on the poorly damped modes only; the picture shows all of them.
  await page.getByRole('button', { name: 'All modes' }).click();
  await page.waitForTimeout(800);
  await dismissToasts(page);
  await showResultsView(page);
  await shoot(page, 'ui-eig.jpg');
  await page.context().close();

  // The continuation power flow of IEEE 14: the nose curve of every bus voltage.
  page = await openApp(browser);
  await loadCase(page, 'ieee14_full.xlsx');
  await runPowerFlow(page);
  await openAnalysis(page, 'cpf');
  await page.getByRole('button', { name: 'Run CPF', exact: true }).first().click();
  await page.waitForTimeout(10_000);
  await dismissToasts(page);
  await showResultsView(page);
  await shoot(page, 'ui-cpf.jpg');
  await page.context().close();
} finally {
  await browser.close();
}
