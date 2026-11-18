/**
 * Large cases e2e: a case with more buses than a diagram is drawn for at once (400) opens without one.
 *
 *   PEGASE 1354-bus and ACTIVSg2000 (bundled steady-state gallery cases), each added to the workspace first
 *   -> the case opens in seconds with a note where the diagram would be, no node on the canvas, no button to
 *   draw it (above 500 buses the page would be silent for longer than the server keeps its session), the Buses
 *   table holds its buses, a power flow runs, and the Violations tab counts what the catalog's entry names
 *
 * The button that draws a case of 401 to 500 buses on request is held by a unit test of the canvas, with a
 * case of 401 buses, since none of the bundled cases has that many.
 */
import { test, expect } from './fixtures';
import { openCase } from './sldDrawing';

/** The example id, its file, its buses, the violations a power flow leaves, and the name of its first bus. */
const LARGE: [string, string, number, string, string][] = [
  ['pegase1354', 'case1354pegase.m', 1354, '29', 'Bus 3'],
  ['activsg2000', 'case_ACTIVSg2000.m', 2000, '197', 'ODESSA 2 0'],
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('tensa:first-run-coach-v1', 'dismissed');
    } catch {
      // Storage unavailable: the coach shows, which does not block the test.
    }
  });
});

for (const [id, file, buses, violations, firstBus] of LARGE) {
  test(`${file}: a case of ${buses} buses opens with no diagram, and its tables and power flow work`, async ({
    page,
    request,
  }) => {
    // Not seeded: add it to the workspace from the package, as the gallery's Add does. A
    // workspace another run already added it to answers with a conflict, which is the same.
    const added = await request.post(`/api/examples/${id}/add`);
    expect([201, 409]).toContain(added.status());

    await page.goto('/');
    await openCase(page, file);
    const note = page.getByTestId('sld-too-large');
    await expect(note).toBeVisible({ timeout: 30_000 });
    await expect(note).toContainText(
      `The diagram of ${buses.toLocaleString('en-US')} buses is not drawn`,
    );
    // Not offered for a case this large, and the note says why.
    await expect(note).toContainText('The page does not answer for that long');
    await expect(page.getByRole('button', { name: 'Draw the diagram anyway' })).toHaveCount(0);
    // Nothing is laid out or drawn, and the page answers at once.
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    await expect(page.getByTestId('sld-layout-skeleton')).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: 'Case navigation' })).toContainText(
      `${buses} buses`,
    );

    // The tables do not wait for it: the first bus is a row of the Buses table.
    await page.getByTestId('bottom-drawer-tab-buses').click();
    await expect(page.getByTestId('bottom-drawer')).toContainText(firstBus);

    // A power flow runs, and the violations are what the entry in the catalog says.
    await page.getByTestId('run-pflow-button').click();
    await expect(page.getByTestId('bottom-drawer-tab-violations')).toHaveText(
      new RegExp(`^Violations\\s*${violations}$`),
      { timeout: 60_000 },
    );
    await page.getByTestId('bottom-drawer-tab-violations').click();
    await expect(page.getByTestId('bottom-drawer')).toContainText(`${violations} violation`);
    // Still no diagram after the run.
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
  });
}
