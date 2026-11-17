/**
 * The search of the diagram finds an element by what it is.
 *
 *   open IEEE 14, whose governors are named `TGOV1_1` to `TGOV1_5` and whose
 *   exciter `EXST1_1` -> Search -> a button for each kind the diagram has,
 *   with how many -> type "governor" -> the five governors, each said to be
 *   one -> type "exciter" -> the one exciter -> press it -> the symbol of its
 *   generating unit is selected, in the middle of the pane -> Search again,
 *   press Governors -> the five governors, nothing typed -> type "pss" -> the
 *   diagram has none, and which dynamic models it has -> add a three-bus
 *   MATPOWER case, which has no dynamic models, and open it -> no button for
 *   a controller -> type "exciter" -> the case is static-only
 *
 * It drives the real UI against a real `tensa serve` (see `playwright.config.ts`).
 * The unit tests check the words and the buttons against a stand-in for React
 * Flow; this one checks them on the cases the server reads, where the rows are
 * the nodes the diagram really draws. It moves nothing, so the seeded case
 * keeps its layout for the other specs. The cases of a first run all have
 * machines, so the case with none is a small one the spec adds to the workspace.
 */
import { test, expect, type Page } from './fixtures';

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';
const DYNAMIC_CASE = 'ieee14_full.xlsx';

/** A three-bus MATPOWER case: ANDES loads and solves it, and it holds no dynamic model. */
const STATIC_CASE_TEXT = `function mpc = static3
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
async function openCase(page: Page, caseFile: string, buses: number): Promise<void> {
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
  await expect(page.getByTestId(/^bus-node-\d+$/)).toHaveCount(buses, { timeout: 90_000 });
}

/** Open the search of the diagram and wait for its input. */
async function openSearch(page: Page): Promise<void> {
  await page.getByTestId('sld-node-search-trigger').click();
  await expect(page.getByTestId('sld-node-search-input')).toBeFocused();
}

/** How far the middle of a node is from the middle of the diagram's pane, in pixels. */
async function offCentre(page: Page, nodeId: string): Promise<number> {
  const node = await page.locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox();
  const pane = await page.getByTestId('sld-canvas-surface').boundingBox();
  if (node === null || pane === null) return Infinity;
  return Math.hypot(
    node.x + node.width / 2 - (pane.x + pane.width / 2),
    node.y + node.height / 2 - (pane.y + pane.height / 2),
  );
}

test('the search finds the controllers of a case by what they are', async ({ page }) => {
  await page.goto('/');
  await openCase(page, DYNAMIC_CASE, 14);

  const input = page.getByTestId('sld-node-search-input');
  const filters = page.getByRole('group', { name: 'Show only' }).getByRole('button');
  const tags = page.getByTestId('sld-node-search-tag');

  // ---- What the diagram has, by kind --------------------------------------
  await openSearch(page);
  await expect(filters).toHaveText([
    'All 43',
    'Buses 14',
    'Generators 5',
    'Loads 11',
    'Shunts 2',
    'Machines 5',
    'Exciters 1',
    'Governors 5',
  ]);

  // ---- By a word for what it is -------------------------------------------
  await input.fill('governor');
  await expect(tags).toHaveText(Array<string>(5).fill('GovernorTGOV1'));
  await expect(page.getByRole('button', { name: 'Governors 5' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Buses 0' })).toBeVisible();

  await input.fill('exciter');
  await expect(tags).toHaveText(['ExciterEXST1']);

  // ---- A pick shows the symbol of the unit --------------------------------
  await page.getByRole('option', { name: /EXST1_1/ }).click();
  await expect(input).toBeHidden();
  const unit = page.locator('.react-flow__node[data-id="generator-2"]');
  await expect(unit).toHaveClass(/\bselected\b/);
  await expect.poll(() => offCentre(page, 'generator-2')).toBeLessThan(4);

  // ---- By a press, with nothing typed -------------------------------------
  await openSearch(page);
  await expect(input).toHaveValue('');
  const governors = page.getByRole('button', { name: 'Governors 5' });
  await governors.click();
  await expect(governors).toHaveAttribute('aria-pressed', 'true');
  await expect(tags).toHaveText(Array<string>(5).fill('GovernorTGOV1'));
  await page.getByRole('button', { name: 'All 43' }).click();
  await expect(tags).toHaveCount(43);

  // ---- A kind the diagram has none of -------------------------------------
  await input.fill('pss');
  await expect(page.getByTestId('sld-node-search-empty')).toContainText(
    'The diagram has no PSS. Its dynamic models: 5 machines, 1 exciter and 5 governors.',
  );
  await input.fill('');
  await page.keyboard.press('Escape');
  await expect(input).toBeHidden();

  // ---- A case with no dynamic models --------------------------------------
  const staticCase = `static3-${Date.now().toString(36)}.m`;
  await page.getByTestId('add-case-files-input').setInputFiles({
    name: staticCase,
    mimeType: 'text/plain',
    buffer: Buffer.from(STATIC_CASE_TEXT),
  });
  await openCase(page, staticCase, 3);
  await openSearch(page);
  await expect(filters).toHaveText(['All 6', 'Buses 3', 'Generators 2', 'Loads 1']);
  await input.fill('exciter');
  await expect(page.getByTestId('sld-node-search-empty')).toContainText(
    'This case is static-only: it has no machines, exciters, governors or other dynamic models.',
  );
});
