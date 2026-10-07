/**
 * What the diagram specs share: opening a case, reading what React Flow drew
 * (the box of each node as the browser laid it out, the bar and the tap dots
 * of each bus, the path of each edge), the rules every connector of a drawn
 * diagram keeps, the rules the values of a power flow keep on it, and the
 * rule that nothing on it is drawn over anything else (`overlapsOnScreen`,
 * which hands what is on screen to the checker the diagram itself routes
 * by).
 *
 * Not a spec itself: `sld-connections.spec.ts`, `sld-tidy.spec.ts` and
 * `sld-no-overlap.spec.ts` import from it.
 */
import {
  describeOverlaps,
  findOverlaps,
  type DrawnDiagram,
} from '../../src/components/sld/overlapCheck';
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

/** Save the open case under `stem`, with its layout, and open the copy. */
export async function openCopy(page: Page, stem: string): Promise<void> {
  await page.getByTestId('topbar-menu-workspace-trigger').click();
  await page.getByTestId('topbar-menu-workspace-save-system').click();
  await page.getByTestId('save-filename').fill(stem);
  await Promise.all([layoutWritten(page), page.getByTestId('save-confirm').click()]);
  await openCase(page, `${stem}.xlsx`);
}

/** Drag the node `id` by `dx`, `dy` on screen, and wait for the layout to be written. */
export async function dragBy(page: Page, id: string, dx: number, dy: number): Promise<void> {
  const node = page.locator(`.react-flow__node[data-id="${id}"]`);
  const box = (await node.boundingBox())!;
  // On the bar of a bus, which is at the top of its node; in the middle of a device.
  const press = { x: box.x + Math.min(box.width / 2, 30), y: box.y + Math.min(box.height / 2, 3) };
  await page.mouse.move(press.x, press.y);
  await page.mouse.down();
  await page.mouse.move(press.x + dx / 2, press.y + dy / 2, { steps: 5 });
  await page.mouse.move(press.x + dx, press.y + dy, { steps: 5 });
  await Promise.all([layoutWritten(page), page.mouse.up()]);
}

/**
 * Drag the node `id` by `dx`, `dy` in the diagram's own units, whatever the
 * zoom the diagram was fitted at, and wait for the layout to be written: a
 * move that lands a node on free ground lands it there in a pane of any
 * size.
 */
export async function dragInDiagram(page: Page, id: string, dx: number, dy: number): Promise<void> {
  const zoom = await page.evaluate(() => {
    const transform = document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform;
    return Number(/scale\(([\d.]+)\)/.exec(transform ?? '')?.[1] ?? 1);
  });
  await dragBy(page, id, dx * zoom, dy * zoom);
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
    // they would run into each other, and in one place two connectors
    // would read as one line through the bus.
    const dots = [...(node.taps ?? [])].sort((a, b) => a - b);
    for (let i = 1; i < dots.length; i += 1) {
      const apart = dots[i]! - dots[i - 1]!;
      if (apart < TAP_SPACING - NEAR) {
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

/** Run a power flow and wait for its values to show on the diagram. */
export async function runPowerFlow(page: Page): Promise<void> {
  await page.getByTestId('run-pflow-button').click();
  await expect(page.locator('[data-testid^="bus-voltage-"]').first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator('[data-testid^="line-flow-label-"]').first()).toBeVisible();
}

/**
 * Every way the values a power flow puts on the diagram are in the way of
 * something, as text; empty when each can be read. It is read off the
 * screen: the boxes the browser gave the P / Q readouts of the devices, the
 * flow labels of the lines, the labels of the buses and the symbols, and the
 * paths of the connectors as they are drawn.
 *
 * - no line, transformer or other connector runs through the readout of a
 *   device;
 * - no readout stands on a symbol, on the label of a bus or on another
 *   readout;
 * - no flow label stands on a device, a readout, the label of a bus or
 *   another flow label;
 * - no label of a bus stands on a device or on the label of another bus.
 *
 * Two boxes count as on each other from `SLACK` pixels of overlap either
 * way: the browser lays text out on whole pixels, the diagram places it in
 * halves.
 */
export async function labelProblems(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const SLACK = 2;
    interface Box {
      id: string;
      left: number;
      right: number;
      top: number;
      bottom: number;
    }
    const boxes = (selector: string, idOf: (el: HTMLElement) => string): Box[] =>
      [...document.querySelectorAll<HTMLElement>(selector)].map((el) => {
        const r = el.getBoundingClientRect();
        return { id: idOf(el), left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
    const on = (a: Box, b: Box): boolean =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > SLACK &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > SLACK;
    const testId = (el: HTMLElement): string => el.dataset.testid ?? '';
    const readouts = boxes(
      '[data-testid^="generator-values-"], [data-testid^="load-values-"]',
      (el) => el.closest<HTMLElement>('.react-flow__node')?.dataset.id ?? testId(el),
    );
    const flows = boxes('[data-testid^="line-flow-label-"]', (el) =>
      testId(el).replace('line-flow-label-', ''),
    );
    const busLabels = boxes('[data-testid^="bus-label-"]', (el) =>
      testId(el).replace('bus-label-', 'bus '),
    );
    const devices = boxes(
      '.react-flow__node-generator, .react-flow__node-load, .react-flow__node-shunt',
      (el) => el.dataset.id ?? '',
    );
    // Each connector as points a pixel apart along its path, on screen.
    const connectors = [...document.querySelectorAll<HTMLElement>('.react-flow__edge')].map(
      (el) => {
        const path = el.querySelector<SVGPathElement>('path.react-flow__edge-path');
        const points: [number, number][] = [];
        const matrix = path?.getScreenCTM();
        if (path && matrix) {
          const length = path.getTotalLength();
          for (let at = 0; at <= length; at += 1) {
            const p = path.getPointAtLength(at);
            points.push([
              p.x * matrix.a + p.y * matrix.c + matrix.e,
              p.x * matrix.b + p.y * matrix.d + matrix.f,
            ]);
          }
        }
        return { id: el.dataset.id ?? '', points };
      },
    );
    const through = (box: Box): string[] =>
      connectors
        .filter(({ points }) =>
          points.some(
            ([x, y]) =>
              x > box.left + SLACK &&
              x < box.right - SLACK &&
              y > box.top + SLACK &&
              y < box.bottom - SLACK,
          ),
        )
        .map(({ id }) => id);

    const found: string[] = [];
    for (const readout of readouts) {
      for (const id of through(readout)) {
        if (id !== `stub-${readout.id}`)
          found.push(`${id} runs through the values of ${readout.id}`);
      }
      for (const device of devices) {
        if (device.id !== readout.id && on(device, readout)) {
          found.push(`the values of ${readout.id} are on ${device.id}`);
        }
      }
      for (const label of busLabels) {
        if (on(label, readout))
          found.push(`the values of ${readout.id} are on the label of ${label.id}`);
      }
      for (const other of readouts) {
        if (other.id < readout.id && on(other, readout)) {
          found.push(`the values of ${readout.id} and of ${other.id} overlap`);
        }
      }
    }
    for (const flow of flows) {
      for (const device of devices) {
        if (on(device, flow)) found.push(`the flow of ${flow.id} is on ${device.id}`);
      }
      for (const readout of readouts) {
        if (on(readout, flow))
          found.push(`the flow of ${flow.id} is on the values of ${readout.id}`);
      }
      for (const label of busLabels) {
        if (on(label, flow)) found.push(`the flow of ${flow.id} is on the label of ${label.id}`);
      }
      for (const other of flows) {
        if (other.id < flow.id && on(other, flow)) {
          found.push(`the flows of ${flow.id} and ${other.id} overlap`);
        }
      }
    }
    for (const label of busLabels) {
      for (const device of devices) {
        if (on(device, label)) found.push(`the label of ${label.id} is on ${device.id}`);
      }
      for (const other of busLabels) {
        if (other.id < label.id && on(other, label)) {
          found.push(`the labels of ${label.id} and ${other.id} overlap`);
        }
      }
    }
    return found;
  });
}

/**
 * What is on screen, as the overlap checker reads a diagram
 * (`overlapCheck.ts`): every connector as the points of its path, every bar,
 * and every box the browser laid out, in the diagram's own coordinates: the
 * symbols, the labels of the buses, the P / Q readouts, the flow labels of
 * the lines and the symbols of the transformers.
 */
export async function drawnOnScreen(page: Page): Promise<DrawnDiagram> {
  return await page.evaluate(() => {
    const numbers = (text: string | null): number[] =>
      (text ?? '').match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    const nodeEls = [...document.querySelectorAll<HTMLElement>('.react-flow__node')];
    // Screen to diagram: by a node, whose place in the diagram is in its style.
    const reference = nodeEls.find((el) => el.offsetWidth > 0);
    if (reference === undefined) return { lines: [], bars: [], boxes: [] };
    const onScreen = reference.getBoundingClientRect();
    const [refX = 0, refY = 0] = numbers(reference.style.transform);
    const zoom = onScreen.width / reference.offsetWidth;
    const inDiagram = (el: Element) => {
      const r = el.getBoundingClientRect();
      return {
        left: refX + (r.left - onScreen.left) / zoom,
        right: refX + (r.right - onScreen.left) / zoom,
        top: refY + (r.top - onScreen.top) / zoom,
        bottom: refY + (r.bottom - onScreen.top) / zoom,
      };
    };
    type Box = {
      id: string;
      kind: 'symbol' | 'label' | 'readout';
      box: { left: number; right: number; top: number; bottom: number };
      of?: string[];
    };
    const bars: { id: string; left: number; right: number; y: number }[] = [];
    const boxes: Box[] = [];
    for (const el of nodeEls) {
      const id = el.dataset.id ?? '';
      const [x = 0, y = 0] = numbers(el.style.transform);
      const bar = el.querySelector<HTMLElement>('[data-testid^="bus-bar-"]');
      if (bar !== null) {
        const left = x + parseFloat(bar.style.left);
        bars.push({ id, left, right: left + parseFloat(bar.style.width), y: y + 3 });
        const label = el.querySelector('[data-testid^="bus-label-"]');
        if (label !== null) {
          boxes.push({ id: `label:${id}`, kind: 'label', box: inDiagram(label), of: [id] });
        }
        continue;
      }
      boxes.push({
        id,
        kind: 'symbol',
        box: { left: x, right: x + el.offsetWidth, top: y, bottom: y + el.offsetHeight },
      });
      const readout = el.querySelector(
        '[data-testid^="generator-values-"], [data-testid^="load-values-"]',
      );
      if (readout !== null) {
        boxes.push({ id: `readout:${id}`, kind: 'readout', box: inDiagram(readout), of: [id] });
      }
    }
    const lines: { id: string; points: [number, number][]; from: string; to: string }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('.react-flow__edge')) {
      const id = el.dataset.id ?? '';
      const d = numbers(el.querySelector('path.react-flow__edge-path')?.getAttribute('d') ?? null);
      const points: [number, number][] = [];
      for (let i = 0; i + 1 < d.length; i += 2) points.push([d[i]!, d[i + 1]!]);
      const label = el.getAttribute('aria-label') ?? '';
      const stub = /connection to bus (.+)$/.exec(label);
      const branch = /bus (.+) to bus (.+)$/.exec(label);
      if (points.length < 2 || (stub === null && branch === null)) continue;
      lines.push({
        id,
        points,
        from: stub !== null ? id.slice('stub-'.length) : branch![1]!,
        to: stub !== null ? stub[1]! : branch![2]!,
      });
    }
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid^="line-flow-label-"]')) {
      const edge = (el.dataset.testid ?? '').replace('line-flow-label-', '');
      boxes.push({ id: `flow:${edge}`, kind: 'label', box: inDiagram(el), of: [edge] });
    }
    for (const el of document.querySelectorAll<HTMLElement>(
      '[data-testid^="transformer-edge-icon-"]',
    )) {
      const edge = (el.dataset.testid ?? '').replace('transformer-edge-icon-', '');
      boxes.push({ id: `symbol:${edge}`, kind: 'symbol', box: inDiagram(el), of: [edge] });
    }
    return { lines, bars, boxes };
  });
}

/**
 * Every place where two things on screen are drawn over each other, as
 * text; empty when the diagram keeps the rule. Two pixels of slack: the
 * browser lays text out on whole pixels, and measures a label a little
 * wider or narrower than the diagram took it to be when it placed it.
 */
export async function overlapsOnScreen(page: Page): Promise<string[]> {
  return describeOverlaps(findOverlaps(await drawnOnScreen(page), { slack: 2 }));
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
