/**
 * Screenshots for the documentation site (docs/img/ui-*.jpg): the window after a power flow,
 * a time-domain run with a fault, the eigenvalue plot and the continuation power flow curve.
 * The UI tour (docs/ui-tour.md) shows them, so rerun this after a change that moves the
 * layout the tour describes. It also takes docs/img/hero.jpeg, the picture at the top of the
 * README and of the site's first page.
 *
 * Prereqs: a running server with the built SPA and a fresh workspace (a new workspace is
 * seeded with the IEEE 14 and Kundur cases the script opens), e.g.
 *   tensa serve --port 18800 --workspace "$(mktemp -d)" --max-sessions 16
 * The hero is taken of the Kundur case arranged wide, and the script keeps that arrangement
 * beside the case in the workspace (kundur_full.xlsx.layout.json), as the app keeps one made
 * by hand. That is one more reason to give it a workspace of its own.
 *
 * Run:
 *   cd web && node scripts/docs-screenshots.mjs [baseUrl] [outDir]
 *
 * Output: ui-overview.jpg, ui-tds.jpg, ui-eig.jpg, ui-cpf.jpg and hero.jpeg in outDir
 * (../docs/img by default), each a JPEG 1600 pixels wide: the four of the tour 1000 high,
 * the hero a little higher. The three after the first show the results view (Ctrl+Shift+M),
 * which gives a plot the whole window.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:18800';
const OUT_DIR = process.argv[3] ?? '../docs/img';
const SIZE = { width: 1600, height: 1000 };
/**
 * The window of the hero picture: smaller, and drawn at a scale that makes the picture as
 * wide as the others, so that its text can still be read where a page shows it at half size.
 * It is no narrower than this because the line over the diagram is whole from about 1360
 * pixels on and cut short with an ellipsis under that, and as high as the Project tab needs
 * to end under the heading of its last part and not half way through the text below it.
 */
const HERO_SIZE = { width: 1400, height: 920 };
/**
 * The hero has more on it than the pictures of the tour, and every visitor of the README
 * loads it. A slightly lower quality than theirs keeps its file from growing.
 */
const HERO_QUALITY = 80;
/**
 * Where the buses of Kundur's two-area system stand in the hero picture, by idx: the tie
 * between the two areas on top, an area down each side, the generators at the foot. Left to
 * itself the app draws the case as a column, which leaves most of a wide pane empty. The left
 * side reaches further out than the right one: a fit centres the diagram, and that is what
 * keeps the flows of the left area clear of the legends at the top left of the pane.
 */
const HERO_BUSES = {
  7: { x: 224, y: 0 },
  8: { x: 432, y: 0 },
  6: { x: 128, y: 176 },
  9: { x: 528, y: 176 },
  5: { x: 32, y: 304 },
  2: { x: 240, y: 304 },
  3: { x: 416, y: 304 },
  10: { x: 576, y: 304 },
  1: { x: -64, y: 432 },
  4: { x: 608, y: 432 },
};

/** The first-run coach is a floating card that would sit over the diagram. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';

async function openApp(browser, viewport = SIZE) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: SIZE.width / viewport.width,
    colorScheme: 'light',
  });
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

/**
 * Keep an arrangement of the buses of a case beside it, as the app keeps a diagram that was
 * arranged by hand: the case then opens with its buses there, and with its devices and its
 * lines placed round them.
 */
async function arrangeBuses(file, coordinates) {
  const health = await (await fetch(new URL('/api/health', BASE_URL))).json();
  const layout = new URL('/api/workspace/layout', BASE_URL);
  layout.searchParams.set('case_path', file);
  const response = await fetch(layout, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema_version: '2',
      andes_version: health.andes_version,
      coordinates,
      last_modified: new Date().toISOString(),
    }),
  });
  if (!response.ok) {
    throw new Error(
      `the layout of ${file} was refused: ${response.status} ${await response.text()}`,
    );
  }
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

/**
 * Fit view, from the command palette. This is the app's own fit, which keeps the diagram
 * clear of the minimap and the zoom controls; the button of the zoom controls fits it to the
 * edges of the pane, which leaves a lower corner of a wide diagram behind the minimap.
 */
async function fitDiagram(page) {
  await page.keyboard.press('Control+k');
  await page.getByTestId('command-palette-input').fill('Fit view');
  await page.getByTestId('command-palette-item-view.fit').click();
  await page.waitForTimeout(1_200);
}

/**
 * Stop when a line of the window is cut short. The app marks a hint it has cut with an
 * ellipsis (`data-cut`), and the picture a visitor sees first is not taken with one: the
 * window is made wider (`HERO_SIZE`).
 */
async function refuseCutText(page) {
  const cut = await page.locator('[data-cut="true"]').allInnerTexts();
  if (cut.length > 0) {
    throw new Error(
      `a line of the window is cut short, so the hero is not taken: ${cut.join(' | ')}`,
    );
  }
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

async function shoot(page, name, quality = 82) {
  await page.screenshot({ path: join(OUT_DIR, name), type: 'jpeg', quality });
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

  // The hero: Kundur's two-area system arranged wide, after a power flow, with a bus picked
  // so that the Inspector shows its result. The drawer is down to its tabs, which gives the
  // diagram the height of the window, and the diagram is fitted once the Inspector has
  // opened and taken its part of the width.
  await arrangeBuses('kundur_full.xlsx', HERO_BUSES);
  page = await openApp(browser, HERO_SIZE);
  await loadCase(page, 'kundur_full.xlsx');
  await runPowerFlow(page);
  await page.getByRole('button', { name: 'Collapse the drawer to its tabs' }).click();
  await page.getByRole('button', { name: 'Open the drawer' }).waitFor();
  await page.getByTestId('bus-node-7').click();
  await page.waitForTimeout(1_000);
  await fitDiagram(page);
  await refuseCutText(page);
  await shoot(page, 'hero.jpeg', HERO_QUALITY);
  await page.context().close();
} finally {
  await browser.close();
}
