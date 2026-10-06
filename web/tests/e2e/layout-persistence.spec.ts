/**
 * A diagram comes back as it was placed.
 *
 *   load Kundur, which is drawn in its automatic layout -> save the system under
 *   a new name without moving anything -> open the copy -> the same picture ->
 *   drag a bus and a machine -> the machine's governor badge goes with it -> the
 *   layout is written beside the case -> save a snapshot -> drag another bus ->
 *   open another case and come back -> still as it was left -> restore the
 *   snapshot -> the diagram is back as the snapshot has it -> "Keep my layout"
 *   -> the later arrangement is back, on screen and on disk
 *
 * It drives the real UI against a real `tensa serve` (see `playwright.config.ts`)
 * in a real browser, and reads what React Flow drew: where each node is and the
 * path of each line. The unit tests check the same round trip against a stand-in
 * for React Flow; this one checks it where the drag is a real pointer drag, the
 * layout a real file the server wrote, and the reload a real case load.
 *
 * Everything is dragged in a copy saved under a name of this run's own, so the
 * example cases the other specs open keep their automatic layout.
 */
import { test, expect, type Page } from './fixtures';

const CASE_FILE = 'kundur_full.xlsx';
const OTHER_CASE = 'wscc9.xlsx';

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';

// Room for the whole diagram between the sidebars and above the drawer, so a
// node that is dragged is one the pointer can reach.
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
  // The sidebar names the case that is open now, not the one that was.
  const name = caseFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await expect(page.getByRole('complementary', { name: 'Case navigation' })).toContainText(
    new RegExp(`Loaded case\\s*${name}`),
  );
}

/** Every number of a CSS transform or an SVG path, in order. */
type Picture = { nodes: Record<string, number[]>; edges: Record<string, number[]> };

/** Where React Flow drew each node, and the path of each edge. */
async function picture(page: Page): Promise<Picture> {
  return await page.evaluate(() => {
    const numbers = (text: string | null): number[] =>
      (text ?? '').match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    const nodes: Record<string, number[]> = {};
    for (const el of document.querySelectorAll<HTMLElement>('.react-flow__node')) {
      nodes[el.dataset.id ?? ''] = numbers(el.style.transform);
    }
    const edges: Record<string, number[]> = {};
    for (const el of document.querySelectorAll<HTMLElement>('.react-flow__edge')) {
      edges[el.dataset.id ?? ''] = numbers(el.querySelector('path')?.getAttribute('d') ?? null);
    }
    return { nodes, edges };
  });
}

/**
 * What differs between two pictures, by node and edge id. React Flow measures
 * the ends of a connector off the DOM, so the same picture drawn twice differs
 * in the fourth decimal; a hundredth of a pixel is the same place.
 */
function differences(a: Picture, b: Picture): string[] {
  const differs = (x: number[] | undefined, y: number[] | undefined): boolean =>
    x === undefined ||
    y === undefined ||
    x.length !== y.length ||
    x.some((value, i) => Math.abs(value - (y[i] ?? Number.NaN)) > 0.01);
  const ids = (p: Record<string, number[]>, q: Record<string, number[]>) => [
    ...new Set([...Object.keys(p), ...Object.keys(q)]),
  ];
  return [
    ...ids(a.nodes, b.nodes).filter((id) => differs(a.nodes[id], b.nodes[id])),
    ...ids(a.edges, b.edges).filter((id) => differs(a.edges[id], b.edges[id])),
  ].sort();
}

/** Wait until the diagram is drawn as `expected`, and say what differs if it never is. */
async function expectPicture(page: Page, expected: Picture): Promise<void> {
  await expect
    .poll(async () => differences(await picture(page), expected), { timeout: 30_000 })
    .toEqual([]);
}

/** The diagram once it has nodes and has stopped changing. */
async function settledPicture(page: Page): Promise<Picture> {
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 90_000 });
  let last = await picture(page);
  await expect(async () => {
    await page.waitForTimeout(400);
    const now = await picture(page);
    const changed = differences(last, now);
    last = now;
    expect(changed).toEqual([]);
    expect(Object.keys(now.nodes).length).toBeGreaterThan(0);
  }).toPass({ timeout: 30_000 });
  return last;
}

/**
 * Drag the node `id` by a real pointer drag, and wait for the layout to be
 * written. The view is fitted first: a node outside the pane cannot be grabbed,
 * and fitting moves the view, not the nodes.
 */
async function dragNode(page: Page, id: string, dx: number, dy: number): Promise<void> {
  await page.locator('.react-flow__controls-fitview').click();
  const node = page.locator(`.react-flow__node[data-id="${id}"]`);
  const pane = await page.getByTestId('sld-canvas-surface').boundingBox();
  let box = await node.boundingBox();
  await expect(async () => {
    // The fit is animated; wait for the node to come to rest inside the pane.
    const previous = box;
    await page.waitForTimeout(150);
    box = await node.boundingBox();
    expect(box).not.toBeNull();
    expect(box).toEqual(previous);
    expect(box!.y).toBeGreaterThan(pane!.y);
    expect(box!.y + box!.height).toBeLessThan(pane!.y + pane!.height);
  }).toPass({ timeout: 10_000 });
  if (box === null) throw new Error(`node ${id} is not on screen`);
  const startX = box.x + box.width / 2;
  const startY = box.y + 4;
  const written = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/api/workspace/layout',
  );
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx / 2, startY + dy / 2, { steps: 5 });
  await page.mouse.move(startX + dx, startY + dy, { steps: 5 });
  await page.mouse.up();
  expect((await written).status()).toBe(204);
}

test('a diagram is saved with the system and comes back as it was placed', async ({ page }) => {
  // A name of this run's own: the server's workspace outlives the test.
  const stem = `layout-e2e-${Date.now()}`;
  const copy = `${stem}.xlsx`;

  await page.goto('/');
  await openCase(page, CASE_FILE);
  const automatic = await settledPicture(page);
  // Kundur has no layout shipped with the app: ELK placed the buses and routed
  // the lines through fixed points.
  expect(Object.keys(automatic.nodes).length).toBeGreaterThan(15);
  expect(automatic.edges['line-Line_1']?.length).toBeGreaterThan(4);

  // ---- Save system as, with nothing moved -------------------------------
  await page.getByTestId('topbar-menu-workspace-trigger').click();
  await page.getByTestId('topbar-menu-workspace-save-system').click();
  await page.getByTestId('save-filename').fill(stem);
  const [layoutWrite] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === '/api/workspace/layout',
    ),
    page.getByTestId('save-confirm').click(),
  ]);
  expect(layoutWrite.status()).toBe(204);
  expect(new URL(layoutWrite.url()).searchParams.get('case_path')).toBe(copy);
  const saved = layoutWrite.request().postDataJSON() as {
    schema_version: string;
    coordinates: Record<string, unknown>;
    branches: { line?: Record<string, unknown> };
  };
  // The whole diagram, though nothing was dragged: every bus, and the routes.
  expect(saved.schema_version).toBe('2');
  expect(Object.keys(saved.coordinates).length).toBe(10);
  expect(Object.keys(saved.branches.line ?? {}).length).toBeGreaterThan(10);

  // ---- The copy opens with the same picture -----------------------------
  await openCase(page, copy);
  await expectPicture(page, automatic);
  // And nothing claims the topology changed since the layout was saved.
  await expect(page.getByTestId('sld-drift-banner')).toHaveCount(0);

  // ---- Place things ------------------------------------------------------
  const machine = 'generator-1';
  const badge = 'controller-TGOV1-1';
  await dragNode(page, machine, 60, -12);
  const afterMachine = await settledPicture(page);
  const delta = (id: string): [number, number] => [
    (afterMachine.nodes[id]?.[0] ?? 0) - (automatic.nodes[id]?.[0] ?? 0),
    (afterMachine.nodes[id]?.[1] ?? 0) - (automatic.nodes[id]?.[1] ?? 0),
  ];
  expect(Math.abs(delta(machine)[0])).toBeGreaterThan(10);
  // The governor's badge went with its machine, by the same amount.
  expect(delta(badge)[0]).toBeCloseTo(delta(machine)[0], 2);
  expect(delta(badge)[1]).toBeCloseTo(delta(machine)[1], 2);
  // Moving a machine moved no bus, so every line kept its route.
  expect(differences(automatic, afterMachine).filter((id) => id.startsWith('line-'))).toEqual([]);

  await dragNode(page, '3', -50, 10);
  const placed = await settledPicture(page);
  expect(differences(afterMachine, placed)).toContain('3');

  // ---- A snapshot keeps the placement ------------------------------------
  await page.getByTestId('topbar-menu-workspace-trigger').click();
  await page.getByTestId('topbar-menu-workspace-save-snapshot').click();
  await page.getByTestId('save-snapshot-name-input').fill('placed');
  const [snapshotSave] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/snapshot'),
    ),
    page.getByTestId('save-snapshot-confirm').click(),
  ]);
  expect(snapshotSave.status()).toBe(200);
  expect(((await snapshotSave.json()) as { metadata: { has_layout: boolean } }).metadata).toEqual(
    expect.objectContaining({ has_layout: true }),
  );
  await expect(page.getByTestId('save-snapshot-dialog')).toBeHidden({ timeout: 10_000 });

  await dragNode(page, '5', 60, 14);
  const rearranged = await settledPicture(page);
  expect(differences(placed, rearranged)).toContain('5');

  // ---- Leave the case and come back --------------------------------------
  await openCase(page, OTHER_CASE);
  await settledPicture(page);
  await openCase(page, copy);
  await expectPicture(page, rearranged);

  // ---- Restoring the snapshot puts the diagram back as it was saved ------
  await page.getByTestId('topbar-menu-workspace-trigger').click();
  await page.getByTestId('topbar-menu-workspace-load-snapshot').click();
  await page.getByTestId('load-snapshot-select-placed').click();
  await page.getByTestId('load-snapshot-confirm').click();
  await expectPicture(page, placed);

  // The arrangement made since the snapshot is not lost: the toast gives it back.
  const notice = page
    .locator('[data-sonner-toast]')
    .filter({ hasText: /placed as it was when the snapshot was saved/ });
  await expect(notice).toBeVisible();
  const [restoredWrite] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === '/api/workspace/layout',
    ),
    notice.getByRole('button', { name: 'Keep my layout' }).click(),
  ]);
  expect(restoredWrite.status()).toBe(204);
  await expectPicture(page, rearranged);

  // On disk too: the next open reads the arrangement that was kept.
  await openCase(page, OTHER_CASE);
  await settledPicture(page);
  await openCase(page, copy);
  await expectPicture(page, rearranged);
});
