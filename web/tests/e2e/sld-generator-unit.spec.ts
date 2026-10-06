/**
 * A generator, its machine and their controllers are one symbol.
 *
 *   open IEEE 14, whose five generators each have a machine of another idx and
 *   a governor, one of them an exciter too -> five generator symbols and no
 *   controller badge, each symbol naming its models in chips -> press a chip
 *   -> the Inspector shows that model and lists the whole unit -> go to the
 *   machine from that list -> its chip is marked -> the P and Q of the power
 *   flow are printed once per unit -> save the system under a new name and
 *   open the copy -> draw the control chain of a unit out -> it stands clear
 *   of the bus above, the symbol and its connector have not moved, and the
 *   layout written beside the case says so -> open another case and come back
 *   -> still drawn out -> fold it away from the right-click menu -> the
 *   layout no longer says so
 *
 * It drives the real UI against a real `tensa serve` (see `playwright.config.ts`)
 * in a real browser. The unit tests check the grouping and the symbol against
 * stand-ins; this one checks them on the case the server reads, where the
 * symbol is as large as the browser lays it out and the layout a real file.
 *
 * The chain is drawn out in a copy saved under a name of this run's own, so
 * IEEE 14 keeps its layout for the other specs.
 */
import { test, expect, type Page } from './fixtures';

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';
const CASE_FILE = 'ieee14_full.xlsx';
const OTHER_CASE = 'wscc9.xlsx';

test.use({ viewport: { width: 1600, height: 1000 } });

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
  const name = caseFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await expect(page.getByRole('complementary', { name: 'Case navigation' })).toContainText(
    new RegExp(`Loaded case\\s*${name}`),
  );
}

/** Where React Flow drew a node, and the path of its connector. */
async function placed(page: Page, nodeId: string): Promise<{ node: string; connector: string }> {
  return await page.evaluate((id) => {
    const node = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
    const edge = document.querySelector(`.react-flow__edge[data-id="stub-${id}"] path`);
    return {
      node: `${node?.style.transform} ${node?.offsetWidth}x${node?.offsetHeight}`,
      connector: edge?.getAttribute('d') ?? '',
    };
  }, nodeId);
}

/** Whether two boxes on the page share any room. */
function overlap(
  a: { x: number; y: number; width: number; height: number } | null,
  b: { x: number; y: number; width: number; height: number } | null,
): boolean {
  if (a === null || b === null) return false;
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

const layoutWritten = (page: Page) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/api/workspace/layout',
  );

test('a generator with its machine and controllers is one symbol, whose chain can be drawn out', async ({
  page,
}) => {
  const stem = `unit-e2e-${Date.now()}`;
  const copy = `${stem}.xlsx`;

  await page.goto('/');
  await openCase(page, CASE_FILE);

  // ---- One symbol per generator ------------------------------------------
  const symbols = page.locator('.react-flow__node-generator');
  await expect(symbols).toHaveCount(5);
  // Under the idx of the static generator, none under a machine's.
  await expect(page.getByTestId(/^generator-node-GENROU/)).toHaveCount(0);
  await expect(page.locator('.react-flow__node-controller')).toHaveCount(0);

  const unit = page.getByTestId('generator-node-2');
  await expect(unit.getByTestId(/^unit-chip-/)).toHaveText(['SG', 'AVR', 'GOV']);
  await expect(page.getByTestId('generator-node-3').getByTestId(/^unit-chip-/)).toHaveText([
    'SG',
    'GOV',
  ]);
  // As high as any device: the chips stand beside the machine symbol.
  const [unitBox, loadBox] = await Promise.all([
    unit.boundingBox(),
    page.getByTestId('load-node-PQ_1').boundingBox(),
  ]);
  expect(unitBox!.height).toBeCloseTo(loadBox!.height, 0);
  // The machine symbol is in the middle of the symbol of the unit.
  const glyph = await unit.locator('img').boundingBox();
  expect(glyph!.x + glyph!.width / 2).toBeCloseTo(unitBox!.x + unitBox!.width / 2, 0);

  // ---- A chip shows its model --------------------------------------------
  await unit.getByTestId('unit-chip-TGOV1-TGOV1_2').click();
  const inspector = page.getByTestId('right-inspector');
  await expect(inspector.getByTestId('inspector-properties')).toContainText('TGOV1_2');
  await expect(unit.getByTestId('unit-chip-TGOV1-TGOV1_2')).toHaveAttribute(
    'data-selected',
    'true',
  );
  await expect(unit).toHaveAttribute('data-selected', 'true');
  // The Inspector lists the unit the governor belongs to, every model of it.
  const members = inspector.getByTestId('generating-unit-list').getByRole('button');
  await expect(members).toHaveCount(4);
  await expect(inspector.getByTestId('generating-unit-row-TGOV1-TGOV1_2')).toHaveAttribute(
    'aria-current',
    'true',
  );

  // From there to the machine, which has no symbol of its own.
  await inspector.getByTestId('generating-unit-row-GENROU-GENROU_2').click();
  await expect(inspector.getByTestId('inspector-properties')).toContainText('GENROU_2');
  await expect(unit.getByTestId('unit-chip-GENROU-GENROU_2')).toHaveAttribute(
    'data-selected',
    'true',
  );
  await expect(unit.getByTestId('unit-chip-TGOV1-TGOV1_2')).not.toHaveAttribute('data-selected');
  await expect(unit).toHaveAttribute('data-selected', 'true');

  // A click on the symbol itself is the generator the power flow solves.
  await unit.locator('img').click();
  await expect(inspector.getByTestId('inspector-properties')).toContainText('PV');
  await expect(unit.getByTestId(/^unit-chip-/).and(page.locator('[data-selected]'))).toHaveCount(0);

  // ---- The power flow prints each unit's output once ---------------------
  await page.getByTestId('run-pflow-button').click();
  await expect(page.getByTestId('generator-p-2')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId(/^generator-values-/)).toHaveCount(5);

  // ---- In a copy, draw the chain of a unit out ---------------------------
  await page.getByTestId('topbar-menu-workspace-trigger').click();
  await page.getByTestId('topbar-menu-workspace-save-system').click();
  await page.getByTestId('save-filename').fill(stem);
  await Promise.all([layoutWritten(page), page.getByTestId('save-confirm').click()]);
  await openCase(page, copy);
  await expect(symbols).toHaveCount(5);

  const before = await placed(page, 'generator-2');
  const toggle = page.getByRole('button', { name: 'Show the control chain of generator 2' });
  const [drawnOut] = await Promise.all([layoutWritten(page), toggle.click()]);
  expect(drawnOut.status()).toBe(204);
  expect(new URL(drawnOut.url()).searchParams.get('case_path')).toBe(copy);
  const written = drawnOut.request().postDataJSON() as { units: Record<string, unknown> };
  expect(written.units).toEqual({ '2': { expanded: true, bus: '2' } });

  const chain = page.getByTestId('unit-chain-2');
  await expect(chain.getByRole('button')).toHaveText([
    /^PV\s*2$/,
    /GENROU\s*GENROU_2\s*SG$/,
    /EXST1\s*EXST1_1\s*AVR$/,
    /TGOV1\s*TGOV1_2\s*GOV$/,
  ]);
  // Bus 1 stands right above this unit: the chain goes beside the symbol
  // and not over the bar or its name.
  const chainBox = await chain.boundingBox();
  for (const busNode of ['bus-node-1', 'bus-node-2']) {
    expect(overlap(chainBox, await page.getByTestId(busNode).boundingBox())).toBe(false);
  }
  expect(overlap(chainBox, await page.getByTestId('generator-node-2').boundingBox())).toBe(false);
  // The chain takes no room of the symbol's: neither it nor its connector moved.
  expect(await placed(page, 'generator-2')).toEqual(before);

  // A row of the chain shows its model, like a chip.
  await chain.getByTestId('unit-chain-row-EXST1-EXST1_1').click();
  await expect(inspector.getByTestId('inspector-properties')).toContainText('EXST1_1');

  // ---- It comes back drawn out -------------------------------------------
  await openCase(page, OTHER_CASE);
  await expect(page.getByTestId(/^unit-chain-/)).toHaveCount(0);
  await openCase(page, copy);
  await expect(page.getByTestId('unit-chain-2')).toBeVisible();
  await expect(page.getByTestId('generator-node-2')).toHaveAttribute('data-unit-expanded', 'true');
  await expect(page.getByTestId('generator-node-3')).toHaveAttribute('data-unit-expanded', 'false');

  // ---- And is folded away from the right-click menu ----------------------
  await page.getByTestId('generator-node-2').locator('img').click({ button: 'right' });
  const menu = page.getByTestId('sld-context-menu');
  await expect(menu.getByTestId('sld-context-menu-title')).toHaveText('Generator 2');
  const [folded] = await Promise.all([
    layoutWritten(page),
    menu.getByTestId('sld-context-unit-chain').click(),
  ]);
  expect((folded.request().postDataJSON() as { units: unknown }).units).toEqual({});
  await expect(page.getByTestId('unit-chain-2')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Show the control chain of generator 2' }),
  ).toBeVisible();
});
