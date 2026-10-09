/**
 * Connecting on the diagram by a drag.
 *
 *   open a copy of IEEE 14 -> Components -> drag PQ load onto the bar of bus
 *   10 -> a draft stands by that bus, on a dashed connector from the middle
 *   of a face to a tap, with bus 10 in its form and nothing sent to the
 *   server -> drag Shunt onto free ground, then drag that draft onto the bar
 *   of bus 13 -> the bar is marked while the draft lies on it, and the draft
 *   is on bus 13, in its form as well
 *
 *   press Draw line -> the row above the diagram says what to do, and every
 *   bus is a button -> drag from bus 12 to bus 14 -> a dashed line between
 *   them, on a tap of either bar, as a draft with both buses in its form ->
 *   press Draw transformer, click bus 9 and then bus 11 -> the same, by two
 *   clicks -> press Draw line and Escape -> nothing is being drawn
 *
 *   click load PQ_9 -> a ring where its connector meets the bar of bus 12,
 *   and the line above the diagram says how it is used -> drag the ring onto
 *   bus 13 -> one edit of the load's bus goes to the server, the load stands
 *   by bus 13 on a connector that drops square onto it -> Undo -> it is on
 *   bus 12 again -> click generator 2, click its ring and then bus 5 -> the
 *   static generator and its machine are edited together, and every line of
 *   the system runs as it ran -> Undo twice
 *
 *   drag the ring of the draft load onto bus 11 -> it is on bus 11, with
 *   nothing sent -> move load PQ_9 to bus 13 again, drag a load aside, save,
 *   reload the page and reopen the case -> the load is on bus 13 where it
 *   stood, the drafts are where they stood, on their buses and between
 *   them, and every line of the system and of a draft runs as it ran -> run
 *   a power flow -> the ring is off and says that a run has locked the system
 *
 *   and on copies of Kundur and WSCC 9: drafts dropped on buses, a line and
 *   a transformer drawn, a load moved to another bus and another dragged
 *   about -> save, reload, reopen -> the diagram is the one that was saved,
 *   to the last bend of every line
 *
 * It drives the real UI against a real `tensa serve` (see
 * `playwright.config.ts`). After every step what is on screen is held to the
 * rules of the connections and to the checker the diagram itself routes by
 * (`overlapsOnScreen`): nothing drawn over anything else. The unit tests
 * hold the same over sweeps of every bus and device of the three example
 * cases (`noOverlapWiring*.test.ts`).
 *
 * Everything is done in a copy saved under a name of this run's own, so the
 * example cases the other specs open keep their automatic layout.
 */
import { test, expect, type Page, reloadWithCase } from './fixtures';
import {
  drawing,
  dropInDiagram,
  onAFaceMiddle,
  onATap,
  openCase,
  openCopy,
  overlapsOnScreen,
  problems,
  runPowerFlow,
  settled,
  type Drawing,
} from './sldDrawing';

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';

test.use({ viewport: { width: 1600, height: 1000 } });

/** A point of the diagram as a place on the page. */
async function onPage(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return await page.evaluate(
    ([dx, dy]) => {
      const viewport = document.querySelector<HTMLElement>('.react-flow__viewport')!;
      const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(
        viewport.style.transform,
      )!;
      const flow = document.querySelector('.react-flow')!.getBoundingClientRect();
      const zoom = Number(m[3]);
      return { x: flow.left + Number(m[1]) + dx! * zoom, y: flow.top + Number(m[2]) + dy! * zoom };
    },
    [x, y],
  );
}

/** The middle of the bar of the bus `id`, in the diagram's own coordinates. */
function onBar(now: Drawing, id: string): { x: number; y: number } {
  const bus = now.nodes[id]!;
  return { x: bus.x + (bus.barLeft ?? 0) + (bus.barLength ?? 92) / 2, y: bus.y + 3 };
}

/** Drag the row of the palette named `label` and drop it at `x`, `y` of the diagram. */
async function dropOnDiagram(page: Page, label: string, x: number, y: number): Promise<void> {
  const at = await onPage(page, x, y);
  const surface = (await page.getByTestId('sld-canvas-surface').boundingBox())!;
  await page
    .getByRole('button', { name: label, exact: true })
    .dragTo(page.getByTestId('sld-canvas-surface'), {
      targetPosition: { x: at.x - surface.x, y: at.y - surface.y },
    });
}

/**
 * Press the mouse at one place of the page, drag it to a place of the
 * diagram and let go; `over` is called with the button still down.
 */
async function dragTo(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  over?: () => Promise<void>,
): Promise<void> {
  const end = await onPage(page, to.x, to.y);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + end.x) / 2, (from.y + end.y) / 2, { steps: 5 });
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await over?.();
  await page.mouse.up();
}

/**
 * The middle of the ring at the bar end of the connector of the selected
 * device, on the page, once it stands still: a click on a device brings it
 * to the middle of the view, and the ring goes along.
 */
async function ringAt(page: Page): Promise<{ x: number; y: number }> {
  const circle = page.getByTestId('sld-wire-grip').locator('circle').first();
  let last = '';
  await expect(async () => {
    await page.waitForTimeout(150);
    const now = JSON.stringify(await circle.boundingBox());
    const moved = now !== last;
    last = now;
    expect(moved).toBe(false);
  }).toPass({ timeout: 10_000 });
  const box = JSON.parse(last) as { x: number; y: number; width: number; height: number };
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The rules of the connections, but for the dash a draft's line is drawn with on purpose. */
function connectionProblems(found: string[]): string[] {
  return found.filter((text) => !/^(stub-draft-|draft-line-).*: drawn dashed$/.test(text));
}

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const toast = (page: Page, text: string) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text });
const draftField = (page: Page, name: string) =>
  page.getByTestId('draft-inspector').getByTestId(`field-${name}`).locator('select');

/**
 * Take the newest edit back from the Edit menu, which names it once the
 * system has been read again: `what` is how the menu calls it.
 */
async function undo(page: Page, what: string): Promise<void> {
  await page.getByTestId('topbar-menu-edit-trigger').click();
  const item = page.getByTestId('topbar-menu-edit-undo');
  await expect(item).toHaveText(new RegExp(`Undo: ${what}`), { timeout: 30_000 });
  await item.click();
  await expect(toast(page, `Undone: ${what}`)).toBeVisible({ timeout: 30_000 });
}

/** The route of every line and transformer of the system, by the id of its edge. */
function routesOfSystem(now: Drawing): Record<string, [number, number][]> {
  return Object.fromEntries(
    Object.entries(now.edges)
      .filter(([id]) => !id.startsWith('stub-') && !id.startsWith('draft-'))
      .map(([id, edge]) => [id, edge.points]),
  );
}

/** The route of every line, transformer and connector on screen, of the system and of the drafts. */
function routesOf(now: Drawing): Record<string, [number, number][]> {
  return Object.fromEntries(Object.entries(now.edges).map(([id, edge]) => [id, edge.points]));
}

/** Write the open case to its file, with the layout of its diagram as drawn. */
async function save(page: Page): Promise<void> {
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/save'),
  );
  await page.getByTestId('topbar-menu-workspace-trigger').click();
  await page.getByTestId('topbar-menu-workspace-save').click();
  expect((await saved).ok()).toBe(true);
}

/** Nothing on screen is drawn over anything else, and every connector keeps its rules. */
async function expectClean(page: Page): Promise<Drawing> {
  const now = await settled(page);
  expect(connectionProblems(problems(now))).toEqual([]);
  expect(await overlapsOnScreen(page)).toEqual([]);
  return now;
}

test('a component is connected by a drop on a bus, a line drawn from bus to bus, and a device moved by the end of its connector', async ({
  page,
}) => {
  await page.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, 'dismissed');
    } catch {
      // Storage unavailable: the coach shows, which does not block the test.
    }
  }, FIRST_RUN_COACH_KEY);
  // What the server is sent about the elements of the system.
  const sent: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (!/\/elements(\/|$)/.test(path)) return;
    if (request.method() === 'GET') return;
    sent.push(
      `${request.method()} ${path.replace(/^.*\/elements/, '')} ${request.postData() ?? ''}`,
    );
  });

  await page.goto('/');
  await openCase(page, 'ieee14_full.xlsx');
  const stem = `connect-${Date.now()}`;
  await openCopy(page, stem);
  const first = await expectClean(page);
  const left = Math.min(...Object.values(first.nodes).map((n) => n.x));

  // ---- A load dropped on the bar of a bus is a draft on that bus -------------
  await page.getByRole('tab', { name: 'Components' }).click();
  await expect(page.getByTestId('component-library-hint')).toContainText(
    'A device dropped on the bar or the name of a bus is connected to that bus.',
  );
  const bar10 = onBar(first, '10');
  await dropOnDiagram(page, 'Add PQ load', bar10.x, bar10.y);
  await expect(toast(page, 'Draft PQ load PQ_12 connected to bus 10')).toBeVisible();
  await expect(node(page, 'draft-1')).toBeVisible();
  await expect(draftField(page, 'bus')).toHaveValue('10');
  let now = await expectClean(page);
  let connector = now.edges['stub-draft-1']!;
  expect(connector.dashed).toBe(true);
  expect(connector.label).toMatch(/connection to bus 10$/);
  expect(onAFaceMiddle(connector.points[0]!, now.nodes['draft-1']!)).toBe(true);
  expect(onATap(connector.points.at(-1)!, now.nodes['10']!)).toBe(true);
  expect(sent).toEqual([]);

  // ---- So is one dropped on the name of a bus, which is what is aimed at ----
  const name = (await page.getByTestId('bus-label-14').boundingBox())!;
  const surface = (await page.getByTestId('sld-canvas-surface').boundingBox())!;
  await page
    .getByRole('button', { name: 'Add PQ load', exact: true })
    .dragTo(page.getByTestId('sld-canvas-surface'), {
      targetPosition: {
        x: name.x + name.width / 2 - surface.x,
        y: name.y + name.height - 1 - surface.y,
      },
    });
  await expect(toast(page, 'Draft PQ load PQ_13 connected to bus 14')).toBeVisible();
  await expectClean(page);
  // It was for this check alone: the rest goes on with one draft, as before.
  await node(page, 'draft-2').click();
  await page.keyboard.press('Delete');
  await expect(toast(page, 'Draft deleted: PQ load PQ_13')).toBeVisible();
  await expect(node(page, 'draft-2')).toHaveCount(0);
  await expectClean(page);

  // ---- A draft that is dragged onto a bus is connected to it -----------------
  await dropOnDiagram(page, 'Add Shunt', left - 180, first.nodes['5']!.y);
  await expect(node(page, 'draft-2')).toBeVisible();
  now = await settled(page);
  expect(now.edges['stub-draft-2']).toBeUndefined();
  // On no bus yet: the line above the diagram says how it is put on one.
  await expect(page.getByTestId('sld-canvas-hint')).toContainText(
    'To connect it, drag it onto the bar of a bus',
  );
  const shunt = now.nodes['draft-2']!;
  const grab = await onPage(page, shunt.x + shunt.width / 2, shunt.y + shunt.height / 2);
  await dragTo(page, grab, onBar(now, '13'), async () => {
    // The bar it lies on is marked while it is held there.
    await expect(page.getByTestId('sld-wire-target')).toHaveAttribute('data-bus', '13');
  });
  await expect(toast(page, 'connected to bus 13')).toBeVisible();
  await expect(page.getByTestId('sld-wire-target')).toHaveCount(0);
  // Its form, which was open before the drop, shows the bus.
  await expect(draftField(page, 'bus')).toHaveValue('13');
  now = await expectClean(page);
  expect(now.edges['stub-draft-2']?.label).toMatch(/connection to bus 13$/);
  expect(onATap(now.edges['stub-draft-2']!.points.at(-1)!, now.nodes['13']!)).toBe(true);

  // ---- A line drawn by a drag from one bus to another -------------------------
  const drawLine = page.getByRole('button', { name: 'Draw line', exact: true });
  await drawLine.click();
  await expect(drawLine).toHaveAttribute('aria-pressed', 'true');
  const bar = page.getByRole('toolbar', { name: 'Draw a line' });
  await expect(bar).toContainText('Click the bus it starts from and then the bus it goes to');
  await expect(
    page.getByRole('button', { name: 'Start the line at bus 12 (BUS12)' }),
  ).toBeVisible();
  const from12 = onBar(now, '12');
  await dragTo(page, await onPage(page, from12.x, from12.y), onBar(now, '14'), async () => {
    await expect(bar).toContainText('From bus 12 (BUS12): now click the bus it goes to.');
    await expect(page.getByTestId('sld-wire-target')).toHaveAttribute('data-bus', '14');
    // The line to the pointer. It may be upright, which has no box to be seen by.
    await expect(page.getByTestId('sld-wire-band')).toHaveAttribute('d', /^M[-\d.]+,[-\d.]+ L/);
  });
  await expect(toast(page, 'Draft line drawn from bus 12 to bus 14')).toBeVisible();
  await expect(bar).toHaveCount(0);
  await expect(drawLine).toHaveAttribute('aria-pressed', 'false');
  await expect(draftField(page, 'bus1')).toHaveValue('12');
  await expect(draftField(page, 'bus2')).toHaveValue('14');
  now = await expectClean(page);
  const line = now.edges['draft-line-draft-3']!;
  expect(line.dashed).toBe(true);
  expect(onATap(line.points[0]!, now.nodes['12']!)).toBe(true);
  expect(onATap(line.points.at(-1)!, now.nodes['14']!)).toBe(true);

  // ---- A transformer drawn by a click on each bus ----------------------------
  await page.getByRole('button', { name: 'Draw transformer', exact: true }).click();
  await page.getByRole('button', { name: 'Start the transformer at bus 9 (BUS9)' }).click();
  await expect(page.getByRole('toolbar', { name: 'Draw a transformer' })).toContainText(
    'From bus 9 (BUS9)',
  );
  await page.getByRole('button', { name: 'End the transformer at bus 11 (BUS11)' }).click();
  await expect(toast(page, 'Draft transformer drawn from bus 9 to bus 11')).toBeVisible();
  now = await expectClean(page);
  expect(now.edges['draft-line-draft-4']?.dashed).toBe(true);
  // And Escape stops a line that was begun.
  await drawLine.click();
  await page.getByRole('button', { name: 'Start the line at bus 1 (BUS1)' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('toolbar', { name: 'Draw a line' })).toHaveCount(0);
  expect(
    Object.keys((await drawing(page)).edges).filter((id) => id.startsWith('draft-line-')),
  ).toHaveLength(2);
  expect(sent).toEqual([]);

  // ---- A load of the system moved to another bus by the end of its connector --
  await node(page, 'load-PQ_9').click();
  const ring = page.getByTestId('sld-wire-grip');
  await expect(ring).toBeVisible();
  await expect(ring).toHaveAttribute('data-bus', '12');
  await expect(ring).toHaveAccessibleName(/^Move load PQ_9 to another bus: drag this end/);
  await expect(page.getByTestId('sld-canvas-hint')).toContainText(
    'Load PQ_9 is selected. To move it to another bus, drag the ring',
  );
  await dragTo(page, await ringAt(page), onBar(now, '13'), async () => {
    await expect(
      page.getByRole('toolbar', { name: 'Move load PQ_9 to another bus' }),
    ).toBeVisible();
    await expect(page.getByTestId('sld-wire-target')).toHaveAttribute('data-bus', '13');
  });
  await expect(toast(page, 'Load PQ_9 moved to bus 13')).toContainText('It was on bus 12.');
  expect(sent).toEqual(['PUT /PQ/PQ_9 {"params":{"bus":13}}']);
  now = await expectClean(page);
  connector = now.edges['stub-load-PQ_9']!;
  expect(connector.label).toMatch(/connection to bus 13$/);
  expect(onAFaceMiddle(connector.points[0]!, now.nodes['load-PQ_9']!)).toBe(true);
  expect(onATap(connector.points.at(-1)!, now.nodes['13']!)).toBe(true);
  // It stands by its new bus, on a connector that drops square onto the bar.
  expect(connector.points).toHaveLength(2);
  expect(Math.abs(connector.points[0]![0] - connector.points[1]![0])).toBeLessThan(1);
  expect(Math.abs(connector.points[0]![1] - connector.points[1]![1])).toBeLessThan(80);
  await page.getByRole('tab', { name: 'Loads' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'PQ_9' })).toContainText('13');

  // Undo takes the edit back, and the load is by bus 12 again.
  await undo(page, 'change bus of PQ PQ_9');
  await expect
    .poll(async () => (await drawing(page)).edges['stub-load-PQ_9']?.label)
    .toMatch(/connection to bus 12$/);
  now = await expectClean(page);
  expect(now.edges['stub-load-PQ_9']!.points).toHaveLength(2);

  // ---- A generating unit: the generator and its machine go together ----------
  sent.length = 0;
  const beforeUnit = await settled(page);
  await node(page, 'generator-2').click({ position: { x: 6, y: 6 } });
  await expect(ring).toHaveAccessibleName(/^Move generator 2 to another bus/);
  // A click on the ring asks for the bus, which is then clicked.
  await ring.click();
  await expect(
    page.getByRole('toolbar', { name: 'Move generator 2 to another bus' }),
  ).toContainText('It is on bus 2 (BUS2).');
  await page.getByRole('button', { name: 'Move generator 2 to bus 5 (BUS5)' }).click();
  await expect(toast(page, 'Generator 2 moved to bus 5')).toContainText(
    'PV 2 and GENROU_2 went together.',
  );
  expect(sent).toEqual([
    'PUT /PV/2 {"params":{"bus":5}}',
    'PUT /GENROU/GENROU_2 {"params":{"bus":5}}',
  ]);
  now = await expectClean(page);
  expect(now.edges['stub-generator-2']?.label).toMatch(/connection to bus 5$/);
  // No line of the system runs another way for it: the generator is drawn
  // for a moment where it stood, on a connector across the diagram to bus 5,
  // and what goes round that connector is not kept.
  expect(routesOfSystem(now)).toEqual(routesOfSystem(beforeUnit));
  // One symbol still: the machine did not come apart from its generator.
  expect(Object.keys(now.nodes).filter((id) => id.startsWith('generator-'))).toHaveLength(5);
  // One Undo for each of the two edits, the newest first.
  await undo(page, 'change bus of GENROU GENROU_2');
  await undo(page, 'change bus of PV 2');
  await expect
    .poll(async () => (await drawing(page)).edges['stub-generator-2']?.label)
    .toMatch(/connection to bus 2$/);
  await expectClean(page);

  // ---- A draft is moved by its ring as well, and nothing is sent -------------
  sent.length = 0;
  await node(page, 'draft-1').click();
  await expect(ring).toHaveAccessibleName(/^Move draft PQ load PQ_12 to another bus/);
  now = await settled(page);
  await dragTo(page, await ringAt(page), onBar(now, '11'));
  await expect(toast(page, 'Draft PQ load PQ_12 connected to bus 11')).toBeVisible();
  await expect(draftField(page, 'bus')).toHaveValue('11');
  now = await expectClean(page);
  expect(now.edges['stub-draft-1']?.label).toMatch(/connection to bus 11$/);
  expect(sent).toEqual([]);

  // ---- What was connected is there again after a save and a reload -----------
  await node(page, 'load-PQ_9').click();
  now = await settled(page);
  await dragTo(page, await ringAt(page), onBar(now, '13'));
  await expect(toast(page, 'Load PQ_9 moved to bus 13')).toBeVisible();
  // And a device that is dragged aside, with the drafts on the diagram.
  await page.locator('.react-flow__pane').click({ position: { x: 4, y: 200 } });
  await dropInDiagram(page, 'load-PQ_3', 130, 40);
  const kept = await expectClean(page);
  await save(page);
  // The page opens the case again by itself.
  await reloadWithCase(page);
  await page.getByRole('tab', { name: 'Project' }).click();
  now = await expectClean(page);
  expect(now.edges['stub-load-PQ_9']?.label).toMatch(/connection to bus 13$/);
  expect(now.nodes['load-PQ_9']).toMatchObject({
    x: kept.nodes['load-PQ_9']!.x,
    y: kept.nodes['load-PQ_9']!.y,
  });
  for (const id of ['draft-1', 'draft-2']) {
    expect(now.nodes[id]).toMatchObject({ x: kept.nodes[id]!.x, y: kept.nodes[id]!.y });
    expect(now.edges[`stub-${id}`]?.label).toBe(kept.edges[`stub-${id}`]!.label);
  }
  // The diagram is the one that was saved: every line of the system runs
  // as it ran, round the drafts where it went round them, and the line of
  // each draft along the route it had, on the same taps of the same bars.
  expect(routesOf(now)).toEqual(routesOf(kept));
  expect(now.nodes).toEqual(kept.nodes);
  const again = now.edges['draft-line-draft-3']!;
  expect(onATap(again.points[0]!, now.nodes['12']!)).toBe(true);
  expect(onATap(again.points.at(-1)!, now.nodes['14']!)).toBe(true);
  expect(now.edges['draft-line-draft-4']).toBeDefined();

  // ---- Once a run has locked the system the ring is off, and says why --------
  await runPowerFlow(page);
  await expectClean(page);
  await node(page, 'load-PQ_9').click();
  await expect(ring).toHaveAttribute('aria-disabled', 'true');
  await expect(ring).toHaveAccessibleName(/not now\. A run has fixed the system\./);
  await expect(page.getByTestId('sld-canvas-hint')).toContainText(
    'It cannot be moved to another bus now, which is why the ring on its bar is greyed out.',
  );
  sent.length = 0;
  now = await settled(page);
  await dragTo(page, await ringAt(page), onBar(now, '12'));
  // The notice says why, and has the way out on it.
  const refused = toast(page, 'Not moved to another bus');
  await expect(refused).toContainText('A run has fixed the system. Reset run lets you edit again');
  await expect(refused.getByRole('button', { name: 'Reset run' })).toBeVisible();
  expect(sent).toEqual([]);
  expect((await drawing(page)).edges['stub-load-PQ_9']?.label).toMatch(/connection to bus 13$/);
});

/** What is placed, drawn and moved on a copy of an example case before it is saved. */
interface Arrangement {
  file: string;
  /** The buses a load and a shunt are dropped on. */
  drops: [string, string];
  /** The buses a line is drawn between, and a transformer. */
  line: [string, string];
  transformer: [string, string];
  /** The load that is moved to another bus, and that bus. */
  move: [string, string];
  /** The load that is dragged about afterwards. */
  drag: string;
}

const ARRANGEMENTS: Arrangement[] = [
  {
    file: 'kundur_full.xlsx',
    drops: ['6', '9'],
    line: ['5', '7'],
    transformer: ['8', '10'],
    move: ['load-PQ_0', '8'],
    drag: 'load-PQ_1',
  },
  {
    file: 'wscc9.xlsx',
    drops: ['7', '5'],
    line: ['4', '9'],
    transformer: ['5', '8'],
    move: ['load-PQ_1', '8'],
    drag: 'load-PQ_2',
  },
];

for (const plan of ARRANGEMENTS) {
  test(`a diagram with drafts on it and devices that were moved reopens as it was saved: ${plan.file}`, async ({
    page,
  }) => {
    await page.addInitScript((key) => {
      try {
        window.localStorage.setItem(key, 'dismissed');
      } catch {
        // Storage unavailable: the coach shows, which does not block the test.
      }
    }, FIRST_RUN_COACH_KEY);
    await page.goto('/');
    await openCase(page, plan.file);
    const stem = `reopen-${plan.file.replace(/\W.*$/, '')}-${Date.now()}`;
    await openCopy(page, stem);
    let now = await expectClean(page);

    // Drafts on two buses, and a line and a transformer drawn as drafts.
    await page.getByRole('tab', { name: 'Components' }).click();
    for (const [label, bus] of [
      ['Add PQ load', plan.drops[0]],
      ['Add Shunt', plan.drops[1]],
    ] as const) {
      const bar = onBar(now, bus);
      await dropOnDiagram(page, label, bar.x, bar.y);
      await expect(toast(page, `connected to bus ${bus}`)).toBeVisible();
      now = await expectClean(page);
    }
    for (const [what, [from, to]] of [
      ['line', plan.line],
      ['transformer', plan.transformer],
    ] as const) {
      await page.getByRole('button', { name: `Draw ${what}`, exact: true }).click();
      await page
        .getByRole('button', { name: new RegExp(`^Start the ${what} at bus ${from} \\(`) })
        .click();
      await page
        .getByRole('button', { name: new RegExp(`^End the ${what} at bus ${to} \\(`) })
        .click();
      await expect(toast(page, `Draft ${what} drawn from bus ${from} to bus ${to}`)).toBeVisible();
      now = await expectClean(page);
    }

    // A load of the system goes to another bus, and another is dragged about.
    const [device, bus] = plan.move;
    await node(page, device).click();
    await expect(page.getByTestId('sld-wire-grip')).toBeVisible();
    now = await settled(page);
    await dragTo(page, await ringAt(page), onBar(now, bus));
    await expect(toast(page, `moved to bus ${bus}`)).toBeVisible();
    await expectClean(page);
    await page.locator('.react-flow__pane').click({ position: { x: 4, y: 200 } });
    for (const [dx, dy] of [
      [130, 40],
      [-130, 110],
      [0, -150],
    ] as const) {
      await dropInDiagram(page, plan.drag, dx, dy);
      await expectClean(page);
    }

    const kept = await expectClean(page);
    // Both that were drawn are lines of the diagram, each on a route of its own.
    expect(Object.keys(kept.edges).filter((id) => id.startsWith('draft-line-'))).toHaveLength(2);
    await save(page);
    // The page opens the case again by itself.
    await reloadWithCase(page);
    await page.getByRole('tab', { name: 'Project' }).click();
    now = await expectClean(page);
    expect(routesOf(now)).toEqual(routesOf(kept));
    expect(now.nodes).toEqual(kept.nodes);
    // Nothing was moved or said to bring it there.
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
  });
}
