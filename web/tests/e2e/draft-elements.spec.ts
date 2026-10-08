/**
 * A component dragged onto the diagram is a draft until it is added.
 *
 *   open a copy of IEEE 14 -> Components -> drag PQ load onto free ground
 *   beside the diagram -> a dashed draft stands there, marked Incomplete; the
 *   Inspector shows its form with every required field marked, Add to system
 *   is off and says why; the Drafts button over the diagram counts it; and
 *   the server was sent nothing -> pick bus 12, which is across the diagram
 *   -> the draft goes beside bus 12 and is joined to its bar by a dashed
 *   connector from the middle of a face to a tap, with nothing on the diagram
 *   drawn over anything else -> drag PV generator onto the symbol of a load
 *   -> it stands in the nearest free place and a notice says so -> drag Line,
 *   pick buses 12 and 14 -> it is drawn as a dashed branch, in the place of
 *   its symbol -> the rule still holds
 *
 *   reload the page -> reopen the case -> the three drafts are back where
 *   they stood, with what was typed into them -> fill the load in -> Ready,
 *   and Add to system is on -> add -> one request, the load is in the Loads
 *   table and stands where its draft stood, selected -> the rule still holds
 *
 *   delete the generator draft with the Delete key -> the notice has Undo,
 *   which puts it back -> delete it from the Drafts list -> delete the line
 *   from its right-click menu -> no drafts are left and the button is gone
 *
 *   open a copy of IEEE 14 -> drag PQ load onto the lines that come down to
 *   bus 5 side by side -> the draft stands on free ground and every line runs
 *   as it ran -> drag the draft onto those lines by hand -> they go round it
 *   -> delete it -> every line runs as it ran before
 *
 *   no case open -> drag Bus onto the empty page -> a blank system, with the
 *   draft in the middle of its diagram and its form open -> fill it in, add
 *   -> the bus stands where the draft stood
 *
 * It drives the real UI against a real `tensa serve` (see
 * `playwright.config.ts`). What is on screen is held to the checker the
 * diagram itself routes by (`overlapsOnScreen`), so the boxes are the ones the
 * browser laid out; the unit tests hold the same rule over sweeps of drops,
 * buses and drags on all three example cases and on a case of over a hundred
 * buses (`noOverlapDrafts*.test.ts`).
 *
 * The drafts are placed in a copy saved under a name of this run's own, so the
 * example cases the other specs open keep their automatic layout.
 */
import { test, expect, type Page } from './fixtures';
import {
  drawing,
  dropInDiagram,
  onAFaceMiddle,
  onATap,
  openCase,
  openCopy,
  overlapsOnScreen,
  problems,
  settled,
  type Drawing,
} from './sldDrawing';

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';

test.use({ viewport: { width: 1600, height: 1000 } });

/** Keep the first-run coach away: it is not what this spec is about. */
async function dismissCoach(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, 'dismissed');
    } catch {
      // Storage unavailable: the coach shows, which does not block the test.
    }
  }, FIRST_RUN_COACH_KEY);
}

/** A point of the diagram, as a place on its surface: where a row is dropped. */
async function onSurface(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return await page.evaluate(
    ([dx, dy]) => {
      const viewport = document.querySelector<HTMLElement>('.react-flow__viewport')!;
      const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(
        viewport.style.transform,
      )!;
      const flow = document.querySelector('.react-flow')!.getBoundingClientRect();
      const surface = document
        .querySelector('[data-testid="sld-canvas-surface"]')!
        .getBoundingClientRect();
      const zoom = Number(m[3]);
      return {
        x: flow.left - surface.left + Number(m[1]) + dx! * zoom,
        y: flow.top - surface.top + Number(m[2]) + dy! * zoom,
      };
    },
    [x, y],
  );
}

/** Drag the row of the palette named `label` and drop it at `x`, `y` of the diagram. */
async function dropOnDiagram(page: Page, label: string, x: number, y: number): Promise<void> {
  const targetPosition = await onSurface(page, x, y);
  await page
    .getByRole('button', { name: label, exact: true })
    .dragTo(page.getByTestId('sld-canvas-surface'), { targetPosition });
}

/** Set the field `name` of the draft's form in the Inspector. */
async function setField(page: Page, name: string, value: string): Promise<void> {
  const field = page.getByTestId('draft-inspector').getByTestId(`field-${name}`);
  if ((await field.locator('select').count()) > 0)
    await field.locator('select').selectOption(value);
  else await field.locator('input').fill(value);
}

/** The rules of the connections, but for the dash a draft's line is drawn with on purpose. */
function connectionProblems(found: string[]): string[] {
  return found.filter((text) => !/^(stub-draft-|draft-line-).*: drawn dashed$/.test(text));
}

const draftNode = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const indicator = (page: Page) => page.getByTestId('sld-drafts-indicator');

test('a component dropped on the diagram is a draft: filled in the Inspector, kept over a reload, and added when it is ready', async ({
  page,
}) => {
  await dismissCoach(page);
  const adds: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/elements$/.test(new URL(request.url()).pathname)) {
      adds.push(request.postData() ?? '');
    }
  });
  await page.goto('/');
  await openCase(page, 'ieee14_full.xlsx');
  const stem = `drafts-${Date.now()}`;
  await openCopy(page, stem);
  const first = await settled(page);
  expect(await overlapsOnScreen(page)).toEqual([]);
  const xs = Object.values(first.nodes).map((n) => n.x);
  const left = Math.min(...xs);
  const bus12 = first.nodes['12']!;
  // The load at the foot of the diagram, which hangs well under its bar.
  const load8 = first.nodes['load-PQ_8']!;

  // ---- A load, dropped on free ground left of the diagram --------------------
  await page.getByRole('tab', { name: 'Components' }).click();
  await dropOnDiagram(page, 'Add PQ load', left - 160, first.nodes['1']!.y + 40);
  const load = draftNode(page, 'draft-1');
  await expect(load).toBeVisible();
  await expect(load).toHaveAttribute('aria-label', /^Draft PQ load PQ_12: Missing name, bus, Vn/);
  await expect(page.getByTestId('draft-badge-draft-1')).toHaveText('Incomplete');
  // Its form is in the Inspector, not in a panel over it.
  const inspector = page.getByTestId('draft-inspector');
  await expect(inspector).toBeVisible();
  await expect(page.getByTestId('add-element-panel')).toBeHidden();
  await expect(page.getByTestId('draft-inspector-header')).toContainText('PQ load PQ_12');
  await expect(inspector.getByTestId('field-error-bus')).toContainText('Required');
  const submit = inspector.getByRole('button', { name: 'Add to system' });
  await expect(submit).toBeDisabled();
  await expect(inspector.getByTestId('form-problems')).toContainText('Not ready to add');
  await expect(indicator(page)).toHaveAttribute('data-draft-count', '1');
  await expect(indicator(page)).toContainText('1 incomplete');
  expect(adds).toEqual([]);

  // ---- Given a bus across the diagram, it goes beside that bus ---------------
  await setField(page, 'bus', '12');
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: 'Draft moved' }),
  ).toContainText('next to bus 12');
  let now = await settled(page);
  const connector = now.edges['stub-draft-1']!;
  expect(connector.dashed).toBe(true);
  expect(connector.label).toMatch(/connection to bus 12$/);
  // From the middle of a face of the draft to a tap of the bar, square onto it.
  expect(onAFaceMiddle(connector.points[0]!, now.nodes['draft-1']!)).toBe(true);
  expect(onATap(connector.points.at(-1)!, now.nodes['12']!)).toBe(true);
  expect(connector.points).toHaveLength(2);
  expect(Math.abs(connector.points[0]![0] - connector.points[1]![0])).toBeLessThan(1);
  expect(Math.abs(now.nodes['draft-1']!.x - bus12.x)).toBeLessThan(250);
  expect(connectionProblems(problems(now))).toEqual([]);
  expect(await overlapsOnScreen(page)).toEqual([]);

  // ---- A generator dropped on a symbol stands beside it ----------------------
  // (Dropped on the bar of a bus it would be connected to that bus:
  // `connect-by-drag.spec.ts`.)
  await dropOnDiagram(
    page,
    'Add PV generator',
    load8.x + load8.width / 2,
    load8.y + load8.height - 4,
  );
  await expect(
    page
      .locator('[data-sonner-toast]')
      .filter({ hasText: 'Draft placed in the nearest free place' }),
  ).toBeVisible();
  await expect(draftNode(page, 'draft-2')).toBeVisible();

  // ---- A line that names both its buses is drawn as a branch -----------------
  await dropOnDiagram(page, 'Add Line', left - 160, first.nodes['11']!.y);
  await expect(draftNode(page, 'draft-3')).toBeVisible();
  await setField(page, 'bus1', '12');
  await expect(draftNode(page, 'draft-3')).toBeVisible();
  await setField(page, 'bus2', '14');
  await expect(draftNode(page, 'draft-3')).toHaveCount(0);
  now = await settled(page);
  const branch = now.edges['draft-line-draft-3']!;
  expect(branch.dashed).toBe(true);
  expect(onATap(branch.points[0]!, now.nodes['12']!)).toBe(true);
  expect(onATap(branch.points.at(-1)!, now.nodes['14']!)).toBe(true);
  await expect(indicator(page)).toHaveAttribute('data-draft-count', '3');
  expect(connectionProblems(problems(now))).toEqual([]);
  expect(await overlapsOnScreen(page)).toEqual([]);
  const before = { load: now.nodes['draft-1']!, generator: now.nodes['draft-2']! };

  // ---- A reload: the drafts are the browser's, and come back with the case ---
  await page.reload();
  await page.getByRole('tab', { name: 'Project' }).click();
  await openCase(page, `${stem}.xlsx`);
  now = await settled(page);
  await expect(indicator(page)).toHaveAttribute('data-draft-count', '3');
  expect(now.nodes['draft-1']).toMatchObject({ x: before.load.x, y: before.load.y });
  expect(now.nodes['draft-2']).toMatchObject({ x: before.generator.x, y: before.generator.y });
  expect(now.edges['stub-draft-1']?.label).toMatch(/connection to bus 12$/);
  expect(now.edges['draft-line-draft-3']).toBeDefined();
  expect(await overlapsOnScreen(page)).toEqual([]);

  // ---- Filled in, the load is Ready, and is added ----------------------------
  await indicator(page).click();
  await page.getByTestId('sld-drafts-row-draft-1').click();
  await expect(page.getByTestId('draft-inspector-header')).toContainText('PQ load PQ_12');
  await expect(inspector.getByTestId('field-bus').locator('select')).toHaveValue('12');
  await setField(page, 'name', 'Mill');
  await setField(page, 'Vn', '138');
  await setField(page, 'p0', '0.1');
  await expect(submit).toBeDisabled();
  await setField(page, 'q0', '0.02');
  await expect(page.getByTestId('draft-inspector-status')).toHaveText('Ready');
  await expect(page.getByTestId('draft-badge-draft-1')).toHaveText('Ready');
  await expect(submit).toBeEnabled();
  expect(adds).toEqual([]);
  await submit.click();
  await expect(draftNode(page, 'draft-1')).toHaveCount(0);
  expect(adds).toHaveLength(1);
  expect(JSON.parse(adds[0]!)).toMatchObject({
    model: 'PQ',
    params: { idx: 'PQ_12', name: 'Mill', bus: '12', p0: 0.1, q0: 0.02 },
  });
  // The load stands where its draft stood (their middles agree), selected.
  now = await settled(page);
  const added = now.nodes['load-PQ_12']!;
  expect(added).toBeDefined();
  const middle = (box: { x: number; y: number; width: number; height: number }) => ({
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  });
  expect(Math.abs(middle(added).x - middle(before.load).x)).toBeLessThan(24);
  expect(Math.abs(middle(added).y - middle(before.load).y)).toBeLessThan(24);
  await expect(page.getByTestId('right-inspector-header')).toContainText('Mill');
  await expect(indicator(page)).toHaveAttribute('data-draft-count', '2');
  await page.getByRole('tab', { name: 'Loads' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Mill' })).toBeVisible();
  expect(connectionProblems(problems(now))).toEqual([]);
  expect(await overlapsOnScreen(page)).toEqual([]);

  // ---- Deleting a draft: by the key, from the list, from its menu ------------
  await draftNode(page, 'draft-2').click();
  await page.keyboard.press('Delete');
  await expect(draftNode(page, 'draft-2')).toHaveCount(0);
  const deleted = page.locator('[data-sonner-toast]').filter({ hasText: 'Draft deleted' });
  await expect(deleted).toContainText('PV generator');
  await deleted.getByRole('button', { name: 'Undo' }).click();
  // Back under an id of its own, where it stood.
  await expect(indicator(page)).toHaveAttribute('data-draft-count', '2');
  const back = page.locator('.react-flow__node-draft');
  await expect(back).toHaveCount(1);
  const backId = (await back.getAttribute('data-id'))!;
  await indicator(page).click();
  await page.getByTestId(`sld-drafts-delete-${backId}`).click();
  await expect(back).toHaveCount(0);
  await page.keyboard.press('Escape');
  // A right-click on the middle of the first run of its line.
  const [from, to] = (await drawing(page)).edges['draft-line-draft-3']!.points;
  const at = await onSurface(page, (from![0] + to![0]) / 2, (from![1] + to![1]) / 2);
  await page.getByTestId('sld-canvas-surface').click({ button: 'right', position: at });
  await expect(page.getByTestId('sld-context-menu-title')).toContainText('Draft Line');
  await page.getByTestId('sld-context-delete-draft').click();
  await expect(indicator(page)).toHaveCount(0);
  expect((await drawing(page)).edges['draft-line-draft-3']).toBeUndefined();
  expect(await overlapsOnScreen(page)).toEqual([]);
});

test('a draft leaves the lines of the system as they run: it is dropped beside them, and one it is dragged onto runs as before once it is gone', async ({
  page,
}) => {
  await dismissCoach(page);
  await page.goto('/');
  await openCase(page, 'ieee14_full.xlsx');
  await openCopy(page, `draft-lines-${Date.now()}`);
  const first = await settled(page);
  expect(await overlapsOnScreen(page)).toEqual([]);
  /** How every line and transformer of the system runs. */
  const lines = (shown: Drawing) =>
    Object.fromEntries(
      Object.entries(shown.edges)
        .filter(([id]) => /^(line|transformer)-/.test(id))
        .map(([id, edge]) => [id, edge.points]),
    );
  const bus5 = first.nodes['5']!;

  // ---- Dropped where the lines run close together: beside them ---------------
  await page.getByRole('tab', { name: 'Components' }).click();
  await dropOnDiagram(page, 'Add PQ load', bus5.x + 54, bus5.y - 80);
  await expect(
    page
      .locator('[data-sonner-toast]')
      .filter({ hasText: 'Draft placed in the nearest free place' }),
  ).toContainText('a draft leaves the lines as they are');
  const draft = draftNode(page, 'draft-1');
  await expect(draft).toBeVisible();
  let now = await settled(page);
  expect(lines(now)).toEqual(lines(first));
  expect(await overlapsOnScreen(page)).toEqual([]);

  // ---- Dragged onto them by hand: they go round it while it stands there -----
  const stands = now.nodes['draft-1']!;
  await dropInDiagram(page, 'draft-1', bus5.x + 6 - stands.x, bus5.y - 112 - stands.y);
  now = await settled(page);
  expect(lines(now)).not.toEqual(lines(first));
  expect(await overlapsOnScreen(page)).toEqual([]);

  // ---- Deleted: every line runs as it ran before -----------------------------
  await draft.click();
  await page.keyboard.press('Delete');
  await expect(draft).toHaveCount(0);
  now = await settled(page);
  expect(lines(now)).toEqual(lines(first));
  expect(await overlapsOnScreen(page)).toEqual([]);
});

test('with no case open, a row dropped on the empty page starts a blank system with a draft on its diagram', async ({
  page,
}) => {
  await dismissCoach(page);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Components' }).click();
  await page
    .getByRole('button', { name: 'Add Bus', exact: true })
    .dragTo(page.getByTestId('no-case-drop-zone'));
  // The diagram is drawn for the draft, in the place of the page that asks for a first bus.
  const draft = draftNode(page, 'draft-1');
  await expect(draft).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('sld-empty-system')).toHaveCount(0);
  const inspector = page.getByTestId('draft-inspector');
  await expect(page.getByTestId('draft-inspector-header')).toContainText('Bus 1');
  await expect(page.getByTestId('add-element-panel')).toBeHidden();
  const stood = (await settled(page)).nodes['draft-1']!;

  await setField(page, 'name', 'North');
  await setField(page, 'Vn', '110');
  await inspector.getByRole('button', { name: 'Add to system' }).click();
  await expect(draft).toHaveCount(0);
  const now = await settled(page);
  const bus = now.nodes['1']!;
  expect(bus.type).toBe('bus');
  // The middle of the bar is where the middle of the draft was.
  expect(Math.abs(bus.x + (bus.barLength ?? 0) / 2 - (stood.x + stood.width / 2))).toBeLessThan(2);
  expect(Math.abs(bus.y + 3 - (stood.y + stood.height / 2))).toBeLessThan(2);
  await expect(page.getByTestId('right-inspector-header')).toContainText('North');
  await expect(indicator(page)).toHaveCount(0);
});
