/**
 * What the diagram specs share: opening a case, reading what React Flow drew
 * (the box of each node as the browser laid it out, the bar and the tap dots
 * of each bus, the path of each edge), and the rules every connector of a
 * drawn diagram keeps.
 *
 * Not a spec itself: `sld-connections.spec.ts` and `sld-tidy.spec.ts` import
 * from it.
 */
import { expect, type Page } from './fixtures';

/** Open a case from the saved-cases list (see load-pf-flow.spec.ts for why this retries). */
export async function openCase(page: Page, caseFile: string): Promise<void> {
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
export interface DrawnNode {
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
export interface DrawnEdge {
  points: [number, number][];
  label: string;
  dashed: boolean;
}

export interface Drawing {
  nodes: Record<string, DrawnNode>;
  edges: Record<string, DrawnEdge>;
}

/** What React Flow drew: every node's box and every edge's path. */
export async function drawing(page: Page): Promise<Drawing> {
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
export const NEAR = 0.6;

/** The least distance between two taps of a bar (`TAP_SPACING` in `connections.ts`). */
export const TAP_SPACING = 14;

/**
 * The kinds of node a connector must not run through: the symbols, and the
 * badge of a controller that has one (a controller of a generator is named on
 * the generator's symbol).
 */
export const SYMBOLS = new Set(['generator', 'load', 'shunt', 'controller']);

/** The kinds of node the automatic placement keeps clear of the branches: the devices. */
export const DEVICES = new Set(['generator', 'load', 'shunt']);

/**
 * How near a line or transformer may come to a bar it is not connected to,
 * or to a device, before it reads as running into it. The diagram keeps 8
 * (`SLIDE_CLEARANCE` in `connections.ts`, `DEVICE_COLUMN_GAP` in
 * `graph.ts`); the browser may measure a device a pixel or two wider than
 * the diagram took it to be when it placed it.
 */
export const CLEAR_OF_BRANCH = 4;

/** How far the level or upright run from `a` to `b` is from a box; 0 when it touches or enters it. */
export function distanceToBox(
  a: [number, number],
  b: [number, number],
  box: { x: number; y: number; width: number; height: number },
): number {
  const dx = Math.max(box.x - Math.max(a[0], b[0]), Math.min(a[0], b[0]) - (box.x + box.width), 0);
  const dy = Math.max(box.y - Math.max(a[1], b[1]), Math.min(a[1], b[1]) - (box.y + box.height), 0);
  return Math.hypot(dx, dy);
}

/** Whether the run from `a` to `b` passes through `box`, a pixel or more inside its edge. */
export function passesThrough(a: [number, number], b: [number, number], box: DrawnNode): boolean {
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
export function onATap(point: [number, number], bus: DrawnNode): boolean {
  const onLine = Math.abs(point[1] - (bus.y + 3)) < NEAR;
  return onLine && (bus.taps ?? []).some((tap) => Math.abs(bus.x + tap - point[0]) < NEAR);
}

/** Whether `point` is the middle of one of the four faces of `box`. */
export function onAFaceMiddle(point: [number, number], box: DrawnNode): boolean {
  const middles: [number, number][] = [
    [box.x + box.width / 2, box.y],
    [box.x + box.width / 2, box.y + box.height],
    [box.x, box.y + box.height / 2],
    [box.x + box.width, box.y + box.height / 2],
  ];
  return middles.some((m) => Math.hypot(m[0] - point[0], m[1] - point[1]) < NEAR);
}

/** Every way the drawing breaks the rules of the connections, as text; empty when it keeps them. */
export function problems({ nodes, edges }: Drawing): string[] {
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
      // It runs into no bar but the two it is connected to.
      for (const [busId, bus] of Object.entries(nodes)) {
        if (bus.type !== 'bus' || bus === from || bus === to) continue;
        const bar = {
          x: bus.x + (bus.barLeft ?? 0),
          y: bus.y,
          width: bus.barLength ?? 0,
          height: 6,
        };
        if (distanceToBox(a, b, bar) < CLEAR_OF_BRANCH) {
          found.push(`${id}: runs into the bar of bus ${busId} between ${a} and ${b}`);
        }
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

/**
 * Every line and transformer that runs through a generator, load or shunt, or
 * along the edge of one, as text. A rule for a diagram as the automatic
 * layout draws it: a device that was dragged stands where it was dropped,
 * on a line or not.
 */
export function branchesIntoDevices({ nodes, edges }: Drawing): string[] {
  const found: string[] = [];
  for (const [id, edge] of Object.entries(edges)) {
    if (id.startsWith('stub-')) continue;
    for (const [deviceId, device] of Object.entries(nodes)) {
      if (!DEVICES.has(device.type)) continue;
      const near = edge.points.some(
        (point, i) => i > 0 && distanceToBox(edge.points[i - 1]!, point, device) < CLEAR_OF_BRANCH,
      );
      if (near) found.push(`${id}: runs into ${deviceId}`);
    }
  }
  return found;
}

/** The diagram once it has nodes, every node is measured, and it has stopped changing. */
export async function settled(page: Page): Promise<Drawing> {
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

export const layoutWritten = (page: Page) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/api/workspace/layout',
  );
