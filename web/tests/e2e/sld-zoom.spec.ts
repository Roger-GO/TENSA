/**
 * A diagram too small to read can be brought to a size it can be read at.
 *
 *   open IEEE 14 in a short window -> the diagram is fitted to its pane, at a
 *   fifth of full size, and the line above it says that it is too small to
 *   read and offers Zoom to 100% -> pick a load in the Loads table -> the
 *   diagram shows it at full size, in the middle, with its connector picked
 *   out -> Fit view -> the button is named for the load, and brings it back
 *   -> Fit view, and click a bus on the diagram -> the zoom stays
 *
 * It drives the real UI against a real `tensa serve` (see `playwright.config.ts`).
 * The unit tests check the same rules against a stand-in for React Flow; this
 * one checks them where the pane, the fit and the pan are the browser's. It
 * moves nothing, so IEEE 14 keeps its automatic layout for the other specs.
 */
import { test, expect, type Page } from './fixtures';

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';
const CASE_FILE = 'ieee14_full.xlsx';

// A short window: the diagram's pane is about 250 px high, and IEEE 14 is
// laid out about 1000 high.
test.use({ viewport: { width: 1440, height: 500 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, 'dismissed');
    } catch {
      // Storage unavailable: the coach shows, which does not block the test.
    }
  }, FIRST_RUN_COACH_KEY);
});

/** Open the app and the IEEE 14 case, and wait until its diagram is up. */
async function openCase(page: Page): Promise<void> {
  await page.goto('/');
  const caseRow = page.getByTestId(`saved-cases-row-${CASE_FILE}`);
  await expect(caseRow).toBeVisible();
  // The UI opens its session in the background after the first paint, and a
  // click on a case before that does nothing. Click until the request goes out.
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
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(14, { timeout: 90_000 });
}

/** The zoom React Flow has the diagram at. */
async function zoomOf(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
    const scale = /scale\(([\d.]+)\)/.exec(viewport?.style.transform ?? '');
    return scale === null ? NaN : Number(scale[1]);
  });
}

/** How far the middle of a node is from the middle of the diagram's pane, in pixels. */
async function offCentre(page: Page, nodeTestId: string): Promise<number> {
  const node = await page.getByTestId(nodeTestId).boundingBox();
  const pane = await page.getByTestId('sld-canvas-surface').boundingBox();
  if (node === null || pane === null) return Infinity;
  return Math.hypot(
    node.x + node.width / 2 - (pane.x + pane.width / 2),
    node.y + node.height / 2 - (pane.y + pane.height / 2),
  );
}

/** The stroke the connector of a device is drawn with. */
async function connectorStroke(
  page: Page,
  edgeId: string,
): Promise<{ stroke: string; width: number }> {
  return await page.evaluate((id) => {
    for (const edge of document.querySelectorAll<SVGGElement>('.react-flow__edge')) {
      if (edge.dataset.id !== id) continue;
      const path = edge.querySelector('path.react-flow__edge-path');
      if (path === null) break;
      const style = getComputedStyle(path);
      return { stroke: style.stroke, width: parseFloat(style.strokeWidth) };
    }
    return { stroke: '', width: NaN };
  }, edgeId);
}

test('a diagram too small to read says so, and a pick in a table shows the device at full size', async ({
  page,
}) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));
  await openCase(page);

  // Fitted whole to a short pane: far too small to read, and the line above
  // the diagram says so, with the zoom and a button.
  const tooSmall = page.getByTestId('sld-canvas-too-small');
  await expect(tooSmall).toContainText(/The diagram is zoomed out to \d+%, too small to read\./);
  await expect(tooSmall).toContainText('pick a bus or a device in a table below');
  const fitted = await zoomOf(page);
  expect(fitted).toBeLessThan(0.4);
  const zoomIn = page.getByTestId('sld-zoom-readable');
  await expect(zoomIn).toHaveText('Zoom to 100%');
  const plain = await connectorStroke(page, 'stub-load-PQ_1');

  // A load picked in its table is shown at full size, in the middle of the pane.
  await page.getByTestId('bottom-drawer-tab-loads').click();
  await page.getByTestId('loads-grid-row-load-PQ_1').click();
  await expect.poll(() => zoomOf(page)).toBe(1);
  await expect.poll(() => offCentre(page, 'load-node-PQ_1')).toBeLessThan(2);
  const load = await page.getByTestId('load-node-PQ_1').boundingBox();
  expect(load?.height).toBeGreaterThan(30);
  // The diagram can be read again: the line is back to how it is worked on.
  await expect(page.getByTestId('sld-canvas-hint')).toContainText('Drag a bus or device');
  await expect(zoomIn).toHaveCount(0);

  // The connector of the selected load is picked out; the one beside it is not.
  const active = await connectorStroke(page, 'stub-load-PQ_1');
  expect(active.width).toBeGreaterThan(plain.width);
  expect(active.stroke).not.toBe(plain.stroke);
  expect(await connectorStroke(page, 'stub-load-PQ_2')).toEqual(plain);

  // Back to the whole diagram: the button now goes to the load it names.
  await page.getByRole('button', { name: 'Fit View' }).click();
  await expect(zoomIn).toHaveText('Zoom to PQ_1');
  await expect(tooSmall).toContainText('Press Zoom to PQ_1');
  await zoomIn.click();
  await expect.poll(() => zoomOf(page)).toBe(1);
  await expect.poll(() => offCentre(page, 'load-node-PQ_1')).toBeLessThan(2);

  // A click on the diagram itself selects without zooming: the user is
  // pointing at what they see.
  await page.getByRole('button', { name: 'Fit View' }).click();
  await expect(tooSmall).toBeVisible();
  const whole = await zoomOf(page);
  await page.getByTestId('bus-node-5').click();
  await expect(zoomIn).toHaveText('Zoom to BUS5');
  // The view pans to the bus, at the zoom it had.
  await expect.poll(() => offCentre(page, 'bus-node-5')).toBeLessThan(4);
  expect(await zoomOf(page)).toBeCloseTo(whole, 3);

  expect(uncaughtErrors).toEqual([]);
});
