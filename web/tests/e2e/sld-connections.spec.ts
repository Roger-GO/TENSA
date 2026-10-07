/**
 * Every connector of the diagram attaches where it should.
 *
 *   open WSCC 9, Kundur and IEEE 14, drawn in their automatic layout -> each
 *   device connector leaves from the middle of a face of its device and
 *   lands on a tap of its bus's bar without running through another symbol,
 *   each line and transformer runs at right angles from a tap to a tap,
 *   clear of every bar but its own two and of every generator, load and
 *   shunt, and every tap has a dot that stands clear of the next -> on IEEE
 *   14, place a load beyond the generator beside it, so that the generator
 *   stands between the load and its tap -> its connector goes round the
 *   generator -> ask for right angles -> still nothing runs through a symbol
 *   -> drag a load round
 *   its bus -> the connector follows while the pointer is still down -> ask
 *   for right angles from the right-click menu -> the connector turns once
 *   -> reload the page -> the placement and the style are still there
 *
 * It drives the real UI against a real `tensa serve` (see `playwright.config.ts`)
 * in a real browser, and reads what React Flow drew: the box of each node as
 * the browser laid it out, the bar and the tap dots of each bus, and the path
 * of each edge. The unit tests check the same rules on the numbers the
 * connection pass works out; this one checks them where the size of a device
 * is the one the browser measured and the drag a real pointer drag.
 *
 * The drag is made, and the style chosen, in a copy saved under a name of
 * this run's own, so the example cases the other specs open keep their
 * automatic layout.
 */
import { test, expect } from './fixtures';
import {
  NEAR,
  SYMBOLS,
  branchesIntoDevices,
  drawing,
  layoutWritten,
  openCase,
  problems,
  settled,
  type Drawing,
} from './sldDrawing';

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';

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

for (const caseFile of ['wscc9.xlsx', 'kundur_full.xlsx', 'ieee14_full.xlsx']) {
  test(`${caseFile}: connectors leave the middle of a face and land on a tap of the bar`, async ({
    page,
  }) => {
    await page.goto('/');
    await openCase(page, caseFile);
    const drawn = await settled(page);

    const ids = Object.keys(drawn.edges);
    expect(ids.filter((id) => id.startsWith('stub-')).length).toBeGreaterThan(3);
    expect(ids.filter((id) => id.startsWith('line-')).length).toBeGreaterThan(5);
    expect(problems(drawn)).toEqual([]);
    expect(branchesIntoDevices(drawn)).toEqual([]);
  });
}

test('no connector of IEEE 14 runs through another symbol, drawn straight or at a right angle', async ({
  page,
}) => {
  const stem = `connections-row-e2e-${Date.now()}`;
  const copy = `${stem}.xlsx`;

  // IEEE 14 has buses with a generator and a load side by side, wider
  // together than a bar of the default length. (A generator is one symbol
  // with its machine and their controllers, so there are 18 symbols.)
  await page.goto('/');
  await openCase(page, 'ieee14_full.xlsx');
  const first = await settled(page);
  const devices = Object.values(first.nodes).filter((node) => SYMBOLS.has(node.type));
  expect(devices.length).toBeGreaterThan(15);
  expect(problems(first)).toEqual([]);
  // Four branches land on one port of bus 5, and two of them come down a
  // corridor beside the bars of buses 3 and 4, where three devices stand in
  // a row: no branch is in a bar or a device on its way.
  expect(branchesIntoDevices(first)).toEqual([]);

  // The style is chosen in a copy, which takes the placement with it.
  await page.getByTestId('topbar-menu-workspace-trigger').click();
  await page.getByTestId('topbar-menu-workspace-save-system').click();
  await page.getByTestId('save-filename').fill(stem);
  const [saved] = await Promise.all([
    layoutWritten(page),
    page.getByTestId('save-confirm').click(),
  ]);
  await openCase(page, copy);
  const asSaved = await settled(page);
  expect(asSaved.nodes).toEqual(first.nodes);
  expect(problems(asSaved)).toEqual([]);
  const stubs = Object.keys(asSaved.edges).filter((id) => id.startsWith('stub-'));
  const diagonals = (drawn: Drawing): string[] =>
    stubs.filter(
      (id) => Math.abs(drawn.edges[id]!.points[0]![0] - drawn.edges[id]!.points[1]![0]) > NEAR,
    );
  // As the diagram places them, every device stands over its bar, or over a
  // bar that reaches out under it: each connector drops square.
  expect(diagonals(asSaved)).toEqual([]);

  // A layout placed by hand: the load of bus 2 beyond the generator beside
  // it and clear past the end of the bar, so that the generator stands
  // between the load and its tap. (Nearer, with its box still over the end
  // of the bar as the lines of the bus draw it, it would drop square.)
  const layout = saved.request().postDataJSON() as {
    non_bus_coordinates: Record<string, Record<string, { x: number; y: number }>>;
  };
  const generator = first.nodes['generator-2']!;
  const bar = first.nodes['2']!;
  const pastTheBar = bar.x + (bar.barLeft ?? 0) + (bar.barLength ?? 0) + 40;
  const beyond = {
    x: Math.max(generator.x + generator.width + 24, pastTheBar),
    y: first.nodes['load-PQ_1']!.y,
  };
  for (const key of ['PQ', 'load']) {
    Object.assign(layout.non_bus_coordinates[key]!.PQ_1!, beyond);
  }
  const placedByHand = await page.request.put('/api/workspace/layout', {
    params: { case_path: copy },
    data: layout,
  });
  expect(placedByHand.status()).toBe(204);
  await page.reload();
  await openCase(page, copy);
  const straight = await settled(page);
  expect(straight.nodes['load-PQ_1']).toMatchObject(beyond);
  expect(problems(straight)).toEqual([]);
  // Drawn straight, a connector has no bend: square onto the bar, or a diagonal.
  expect(stubs.filter((id) => straight.edges[id]!.points.length !== 2)).toEqual([]);
  const diagonal = diagonals(straight);
  expect(diagonal).toContain('stub-load-PQ_1');

  await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 24, y: 320 } });
  await Promise.all([
    layoutWritten(page),
    page.getByTestId('sld-context-connectors-elbow').click(),
  ]);
  const turned = await settled(page);
  expect(problems(turned)).toEqual([]);
  expect(branchesIntoDevices(turned)).toEqual([]);
  // Every connector that was a diagonal now turns once, and every run of
  // every connector is level or upright.
  expect(diagonal.filter((id) => turned.edges[id]!.points.length !== 3)).toEqual([]);
  for (const id of stubs) {
    const points = turned.edges[id]!.points;
    for (let i = 1; i < points.length; i += 1) {
      const [a, b] = [points[i - 1]!, points[i]!];
      expect(
        Math.abs(a[0] - b[0]) < NEAR || Math.abs(a[1] - b[1]) < NEAR,
        `${id}: a run at an angle from ${a} to ${b}`,
      ).toBe(true);
    }
  }
});

test('a connector follows its device through a drag, turns at a right angle when asked, and comes back so', async ({
  page,
}) => {
  const stem = `connections-e2e-${Date.now()}`;
  const copy = `${stem}.xlsx`;
  const load = 'load-PQ_0';
  const stub = `stub-${load}`;

  await page.goto('/');
  await openCase(page, 'wscc9.xlsx');
  await settled(page);
  await page.getByTestId('topbar-menu-workspace-trigger').click();
  await page.getByTestId('topbar-menu-workspace-save-system').click();
  await page.getByTestId('save-filename').fill(stem);
  await Promise.all([layoutWritten(page), page.getByTestId('save-confirm').click()]);
  await openCase(page, copy);
  const start = await settled(page);
  const bus = /connection to bus (.+)$/.exec(start.edges[stub]!.label)![1]!;

  // As placed by default the load stands over its bar: the connector drops
  // square onto it.
  expect(start.edges[stub]!.points).toHaveLength(2);
  expect(start.edges[stub]!.points[0]![0]).toBeCloseTo(start.edges[stub]!.points[1]![0], 1);

  // ---- Drag it out past the tip of the bar, and hold it there -------------
  await page.locator('.react-flow__controls-fitview').click();
  const node = page.locator(`.react-flow__node[data-id="${load}"]`);
  await expect(async () => {
    const before = await node.boundingBox();
    await page.waitForTimeout(150);
    expect(await node.boundingBox()).toEqual(before);
  }).toPass({ timeout: 10_000 });
  const box = (await node.boundingBox())!;
  const press = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(press.x, press.y);
  await page.mouse.down();
  await page.mouse.move(press.x + 90, press.y - 10, { steps: 6 });
  await page.mouse.move(press.x + 180, press.y - 20, { steps: 6 });

  // The pointer is still down: the connector is already where the load is.
  await expect
    .poll(async () => problems(await drawing(page)).filter((p) => p.startsWith(stub)))
    .toEqual([]);
  const held = await drawing(page);
  expect(held.nodes[load]!.x).toBeGreaterThan(start.nodes[load]!.x + 50);
  // It lands on the tip of the bar, the last place a tap can be...
  const heldBus = held.nodes[bus]!;
  const tip = heldBus.x + heldBus.barLeft! + heldBus.barLength! - 3;
  expect(held.edges[stub]!.points[held.edges[stub]!.points.length - 1]![0]).toBeCloseTo(tip, 1);
  // ...and leaves the load by a face that looks back at the bar, not by its far side.
  const from = held.edges[stub]!.points[0]!;
  expect(from[0]).toBeLessThan(held.nodes[load]!.x + held.nodes[load]!.width - 1);

  const [write] = await Promise.all([layoutWritten(page), page.mouse.up()]);
  expect(write.status()).toBe(204);
  const dropped = await settled(page);
  expect(problems(dropped)).toEqual([]);
  expect(dropped.edges[stub]!.points).toHaveLength(2);

  // ---- Right angles, from the right-click menu of the diagram --------------
  await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 24, y: 320 } });
  await expect(page.getByTestId('sld-context-connectors-straight')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const [styled] = await Promise.all([
    layoutWritten(page),
    page.getByTestId('sld-context-connectors-elbow').click(),
  ]);
  expect((styled.request().postDataJSON() as { figure: Record<string, unknown> }).figure).toEqual({
    connector_style: 'elbow',
  });
  const turned = await settled(page);
  expect(problems(turned)).toEqual([]);
  // Sideways out of the load, one corner, and square onto the bar.
  const route = turned.edges[stub]!.points;
  expect(route).toHaveLength(3);
  expect(route[0]![1]).toBeCloseTo(route[1]![1], 1);
  expect(route[1]![0]).toBeCloseTo(route[2]![0], 1);

  // ---- A page loaded afresh draws the same ---------------------------------
  await page.reload();
  await openCase(page, copy);
  const reopened = await settled(page);
  expect(reopened.nodes[load]).toEqual(turned.nodes[load]);
  expect(reopened.edges[stub]!.points).toEqual(route);
  expect(problems(reopened)).toEqual([]);
  await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 24, y: 320 } });
  await expect(page.getByTestId('sld-context-connectors-elbow')).toHaveAttribute(
    'aria-checked',
    'true',
  );
});
