/**
 * Every connector of the diagram attaches where it should.
 *
 *   open WSCC 9, Kundur and IEEE 14, drawn in their automatic layout -> each
 *   device connector leaves from the middle of a face of its device and
 *   lands on a tap of its bus's bar without running through another symbol,
 *   each line and transformer runs at right angles from a tap to a tap, and
 *   every tap has a dot that stands clear of the next -> ask for right
 *   angles on IEEE 14, where more devices stand in a row than its bars are
 *   long -> still no connector runs through a symbol -> drag a load round
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
import { test, expect, type Page } from './fixtures';

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

/** A node as the browser drew it, in the diagram's own coordinates. */
interface DrawnNode {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** A bus: where its bar starts, how long it is, and where its tap dots are. */
  barLeft?: number;
  barLength?: number;
  taps?: number[];
}

/** An edge as the browser drew it. */
interface DrawnEdge {
  points: [number, number][];
  label: string;
  dashed: boolean;
}

interface Drawing {
  nodes: Record<string, DrawnNode>;
  edges: Record<string, DrawnEdge>;
}

/** What React Flow drew: every node's box and every edge's path. */
async function drawing(page: Page): Promise<Drawing> {
  return await page.evaluate(() => {
    const numbers = (text: string | null): number[] =>
      (text ?? '').match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    const nodes: Record<string, DrawnNode> = {};
    for (const el of document.querySelectorAll<HTMLElement>('.react-flow__node')) {
      const [x = 0, y = 0] = numbers(el.style.transform);
      const node: DrawnNode = {
        type: /react-flow__node-(\w+)/.exec(el.className)?.[1] ?? '',
        x,
        y,
        width: el.offsetWidth,
        height: el.offsetHeight,
      };
      const bar = el.querySelector<HTMLElement>('[data-testid^="bus-bar-"]');
      if (bar !== null) {
        node.barLeft = parseFloat(bar.style.left);
        node.barLength = parseFloat(bar.style.width);
        node.taps = [...el.querySelectorAll<HTMLElement>('[data-testid^="bus-tap-"]')].map((tap) =>
          Number(tap.dataset.tapX),
        );
      }
      nodes[el.dataset.id ?? ''] = node;
    }
    const edges: Record<string, DrawnEdge> = {};
    for (const el of document.querySelectorAll<HTMLElement>('.react-flow__edge')) {
      const path = el.querySelector<SVGPathElement>('path.react-flow__edge-path');
      const d = numbers(path?.getAttribute('d') ?? null);
      const points: [number, number][] = [];
      for (let i = 0; i + 1 < d.length; i += 2) points.push([d[i]!, d[i + 1]!]);
      const dash = path === null ? 'none' : getComputedStyle(path).strokeDasharray;
      edges[el.dataset.id ?? ''] = {
        points,
        label: el.getAttribute('aria-label') ?? '',
        dashed: dash !== 'none' && dash !== '',
      };
    }
    return { nodes, edges };
  });
}

/** Half a pixel: the browser lays a node out on whole pixels, the routes are worked out in halves. */
const NEAR = 0.6;

/** The least distance between two taps of a bar (`TAP_SPACING` in `connections.ts`). */
const TAP_SPACING = 14;

/** The kinds of node a connector must not run through: the symbols, and the controller badges. */
const SYMBOLS = new Set(['generator', 'load', 'shunt', 'controller']);

/** Whether the run from `a` to `b` passes through `box`, a pixel or more inside its edge. */
function passesThrough(a: [number, number], b: [number, number], box: DrawnNode): boolean {
  const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]));
  for (let i = 0; i <= steps; i += 1) {
    const t = steps === 0 ? 0 : i / steps;
    const x = a[0] + t * (b[0] - a[0]);
    const y = a[1] + t * (b[1] - a[1]);
    const inside =
      x > box.x + 1 && x < box.x + box.width - 1 && y > box.y + 1 && y < box.y + box.height - 1;
    if (inside) return true;
  }
  return false;
}

/** Whether `point` is on the centre line of the bar of `bus`, at one of its tap dots. */
function onATap(point: [number, number], bus: DrawnNode): boolean {
  const onLine = Math.abs(point[1] - (bus.y + 3)) < NEAR;
  return onLine && (bus.taps ?? []).some((tap) => Math.abs(bus.x + tap - point[0]) < NEAR);
}

/** Whether `point` is the middle of one of the four faces of `box`. */
function onAFaceMiddle(point: [number, number], box: DrawnNode): boolean {
  const middles: [number, number][] = [
    [box.x + box.width / 2, box.y],
    [box.x + box.width / 2, box.y + box.height],
    [box.x, box.y + box.height / 2],
    [box.x + box.width, box.y + box.height / 2],
  ];
  return middles.some((m) => Math.hypot(m[0] - point[0], m[1] - point[1]) < NEAR);
}

/** Every way the drawing breaks the rules of the connections, as text; empty when it keeps them. */
function problems({ nodes, edges }: Drawing): string[] {
  const found: string[] = [];
  for (const [id, edge] of Object.entries(edges)) {
    const first = edge.points[0];
    const last = edge.points[edge.points.length - 1];
    if (first === undefined || last === undefined || edge.points.length < 2) {
      found.push(`${id}: no path`);
      continue;
    }
    if (edge.dashed) found.push(`${id}: drawn dashed`);
    if (id.startsWith('stub-')) {
      const device = nodes[id.slice('stub-'.length)];
      const bus = nodes[/connection to bus (.+)$/.exec(edge.label)?.[1] ?? ''];
      if (device === undefined || bus === undefined) {
        found.push(`${id}: its device or its bus is not drawn`);
        continue;
      }
      if (!onAFaceMiddle(first, device)) found.push(`${id}: leaves ${first} off a face middle`);
      if (!onATap(last, bus)) found.push(`${id}: lands at ${last}, not on a tap of its bar`);
      if (edge.points.length > 3) found.push(`${id}: more than one bend`);
      // It reaches the bar without running through anything else that is drawn there.
      for (const [otherId, other] of Object.entries(nodes)) {
        if (other === device || !SYMBOLS.has(other.type)) continue;
        const through = edge.points.some(
          (point, i) => i > 0 && passesThrough(edge.points[i - 1]!, point, other),
        );
        if (through) found.push(`${id}: runs through ${otherId}`);
      }
      continue;
    }
    const ends = /bus (.+) to bus (.+)$/.exec(edge.label);
    const from = nodes[ends?.[1] ?? ''];
    const to = nodes[ends?.[2] ?? ''];
    if (from === undefined || to === undefined) {
      found.push(`${id}: one of its buses is not drawn`);
      continue;
    }
    if (!onATap(first, from)) found.push(`${id}: starts at ${first}, not on a tap`);
    if (!onATap(last, to)) found.push(`${id}: ends at ${last}, not on a tap`);
    for (let i = 1; i < edge.points.length; i += 1) {
      const [a, b] = [edge.points[i - 1]!, edge.points[i]!];
      if (Math.abs(a[0] - b[0]) > NEAR && Math.abs(a[1] - b[1]) > NEAR) {
        found.push(`${id}: a run at an angle from ${a} to ${b}`);
      }
    }
  }
  for (const [id, node] of Object.entries(nodes)) {
    if (node.type !== 'bus') continue;
    // The bar holds every tap, and is never shorter than the node is wide.
    const start = node.barLeft ?? 0;
    const end = start + (node.barLength ?? 0);
    if ((node.barLength ?? 0) < node.width) found.push(`bus ${id}: bar shorter than the node`);
    for (const tap of node.taps ?? []) {
      if (tap < start || tap > end) found.push(`bus ${id}: a tap at ${tap} off the bar`);
    }
    // Two dots are a spacing apart, whichever face each tap is on: nearer,
    // they would run into each other (taps in one place share a dot).
    const dots = [...(node.taps ?? [])].sort((a, b) => a - b);
    for (let i = 1; i < dots.length; i += 1) {
      const apart = dots[i]! - dots[i - 1]!;
      if (apart > NEAR && apart < TAP_SPACING - NEAR) {
        found.push(`bus ${id}: taps at ${dots[i - 1]} and ${dots[i]} run into each other`);
      }
    }
  }
  return found;
}

/** The diagram once it has nodes, every node is measured, and it has stopped changing. */
async function settled(page: Page): Promise<Drawing> {
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 90_000 });
  let last = JSON.stringify(await drawing(page));
  await expect(async () => {
    await page.waitForTimeout(400);
    const now = JSON.stringify(await drawing(page));
    const changed = now !== last;
    last = now;
    expect(changed).toBe(false);
  }).toPass({ timeout: 30_000 });
  return JSON.parse(last) as Drawing;
}

const layoutWritten = (page: Page) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/api/workspace/layout',
  );

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
  });
}

test('no connector of IEEE 14 runs through another symbol, drawn straight or at a right angle', async ({
  page,
}) => {
  const stem = `connections-row-e2e-${Date.now()}`;

  // IEEE 14 has buses with three and four devices in a row, more than stand
  // over a bar of the default length: the outer ones are beyond its tips,
  // with a neighbour between them and their tap.
  await page.goto('/');
  await openCase(page, 'ieee14_full.xlsx');
  const first = await settled(page);
  const devices = Object.values(first.nodes).filter((node) => SYMBOLS.has(node.type));
  expect(devices.length).toBeGreaterThan(20);
  expect(problems(first)).toEqual([]);

  // The style is chosen in a copy, which takes the placement with it.
  await page.getByTestId('topbar-menu-workspace-trigger').click();
  await page.getByTestId('topbar-menu-workspace-save-system').click();
  await page.getByTestId('save-filename').fill(stem);
  await Promise.all([layoutWritten(page), page.getByTestId('save-confirm').click()]);
  await openCase(page, `${stem}.xlsx`);
  const straight = await settled(page);
  expect(straight.nodes).toEqual(first.nodes);
  expect(problems(straight)).toEqual([]);
  const stubs = Object.keys(straight.edges).filter((id) => id.startsWith('stub-'));
  // Drawn straight, a connector has no bend: square onto the bar, or a diagonal.
  expect(stubs.filter((id) => straight.edges[id]!.points.length !== 2)).toEqual([]);
  const diagonal = stubs.filter(
    (id) => Math.abs(straight.edges[id]!.points[0]![0] - straight.edges[id]!.points[1]![0]) > NEAR,
  );
  expect(diagonal.length).toBeGreaterThan(0);

  await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 24, y: 320 } });
  await Promise.all([
    layoutWritten(page),
    page.getByTestId('sld-context-connectors-elbow').click(),
  ]);
  const turned = await settled(page);
  expect(problems(turned)).toEqual([]);
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
