/**
 * Moving a line of the diagram by hand.
 *
 *   open IEEE 14 -> click a line: its handles show and the row above the
 *   diagram names it -> drag its level run: the line follows the pointer and
 *   is "Routed by hand" -> nothing on the diagram is drawn over anything
 *   else -> Tidy diagram leaves it as it is and says so -> the arrow keys
 *   nudge the run that was moved -> a power flow puts its values on the
 *   diagram, and still nothing is drawn over anything else -> reload the
 *   page: the same route, still the user's -> Move route by hand in its
 *   right-click menu picks it with the focus on a run -> Reset route gives
 *   it back to the automatic routing -> Undo (Ctrl+Z) brings the route back
 *
 *   open WSCC 9 -> click the connector of a load, slide it along its bar:
 *   a square step, out of the middle of the same face and onto a tap of
 *   the bar -> drag the bus: the connector goes along whole -> Reset manual
 *   routes in the Arrange menu puts it back as it was
 *
 *   open IEEE 14 -> slide the connector of a load along its bar -> try to
 *   fold it back onto its own symbol: it stays as it was, with no step too
 *   short to read and no run along the symbol -> drag the load to the other
 *   side of its bar: the connector is worked out again -> reload: the same
 *   connector, clear of its symbol -> Tidy and re-layout lays the diagram
 *   out again
 *
 *   open WSCC 9 -> pick a line by its row in the Lines table -> Add bend,
 *   and the arrow keys make the line turn there -> pick another line with
 *   Enter while it has the keyboard focus: one of its runs takes the keys
 *
 *   open IEEE 14 -> click the middle of the element of every line,
 *   transformer and connector: each is picked -> slide the connector of a
 *   load along its bar and try to take the bend by its tap out: refused,
 *   since the connector would run along its bar over the end beside its own
 *   -> the Inspector of a line says how it is routed, and its Reset route
 *   gives a route drawn by hand back -> drag the bottom drawer down to its
 *   tab strip: a click on the Lines tab opens it again, and a row picks
 *   its line
 *
 * It drives the real UI against a real `tensa serve` (see `playwright.config.ts`)
 * in a real browser, and reads what React Flow drew (`sldDrawing.ts`). The
 * unit tests hold the moves and the check that goes with them; this one
 * holds them where the pointer is a real one, the sizes are the ones the
 * browser measured, and the layout is the file the server keeps.
 *
 * Everything is done in a copy saved under a name of this run's own, so the
 * example cases the other specs open keep their automatic layout.
 */
import { test, expect, type Page } from './fixtures';
import {
  dragInDiagram,
  drawing,
  labelProblems,
  layoutWritten,
  openCase,
  openCopy,
  overlapsOnScreen,
  problems,
  runPowerFlow,
  settled,
} from './sldDrawing';

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';

type Points = [number, number][];

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

/** Where the point `at` of the diagram is on screen. */
async function onScreen(page: Page, at: [number, number]): Promise<{ x: number; y: number }> {
  return await page.evaluate(([x, y]) => {
    const pane = document.querySelector('.react-flow')!.getBoundingClientRect();
    const matrix = new DOMMatrixReadOnly(
      getComputedStyle(document.querySelector('.react-flow__viewport')!).transform,
    );
    return { x: pane.x + matrix.e + x! * matrix.a, y: pane.y + matrix.f + y! * matrix.a };
  }, at);
}

/** The path the edge `id` is drawn along. */
async function pathOf(page: Page, id: string): Promise<Points> {
  return (await drawing(page)).edges[id]!.points;
}

/** The route the handles of the picked line are drawn on. */
async function editedRoute(page: Page): Promise<Points> {
  const raw = await page.getByTestId('sld-route-editor').getAttribute('data-route');
  return JSON.parse(raw ?? '[]') as Points;
}

/** A click on the edge `id`, a third of the way along its first run. */
async function clickLine(page: Page, id: string): Promise<void> {
  const [a, b] = await pathOf(page, id);
  const at = await onScreen(page, [a![0] + (b![0] - a![0]) / 3, a![1] + (b![1] - a![1]) / 3]);
  await page.mouse.click(at.x, at.y);
  await expect(page.getByTestId('sld-route-editor')).toHaveAttribute('data-edge-id', id);
}

/** Pick the edge `id` from its right-click menu, opened where `clickLine` clicks it. */
async function pickFromMenu(page: Page, id: string): Promise<void> {
  const [a, b] = await pathOf(page, id);
  const at = await onScreen(page, [a![0] + (b![0] - a![0]) / 3, a![1] + (b![1] - a![1]) / 3]);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await expect(page.getByTestId('sld-context-menu')).toBeVisible();
  await page.getByTestId('sld-context-edit-route').click();
  await expect(page.getByTestId('sld-route-editor')).toHaveAttribute('data-edge-id', id);
}

/** Drag from the point `from` of the diagram by `by`, in the diagram's own units. */
async function dragFrom(page: Page, from: [number, number], by: [number, number]): Promise<void> {
  const start = await onScreen(page, from);
  const end = await onScreen(page, [from[0] + by[0], from[1] + by[1]]);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 5 });
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
}

/** `points` to a hundredth of a unit: what a sum of two places is good to. */
function rounded(points: Points): Points {
  return points.map(([x, y]): [number, number] => [
    Math.round(x * 100) / 100,
    Math.round(y * 100) / 100,
  ]);
}

/** The first run of `points` that is level and has a run before and after it: its index. */
function levelRun(points: Points): number {
  for (let i = 1; i + 2 < points.length; i += 1) {
    if (Math.abs(points[i]![1] - points[i + 1]![1]) < 0.5) return i;
  }
  return -1;
}

test("IEEE 14: a line moved by hand is the user's, clear of everything, kept by a tidy and a reload, and can be reset", async ({
  page,
}) => {
  const stem = `route-e2e-${Date.now()}`;

  await page.goto('/');
  await openCase(page, 'ieee14_full.xlsx');
  await settled(page);
  await openCopy(page, stem);
  const opened = await settled(page);
  expect(await overlapsOnScreen(page)).toEqual([]);

  // A line that steps from one bar to the next: the run across is the one to move.
  const id = Object.keys(opened.edges).find(
    (edge) => edge.startsWith('line-') && levelRun(opened.edges[edge]!.points) > 0,
  )!;
  expect(id).toBeDefined();
  const before = opened.edges[id]!.points;
  const run = levelRun(before);

  // ---- a click picks it ----
  await expect(page.getByTestId('sld-canvas-hint')).toContainText(
    'Click a line, or its row in the Lines table, to move its route by hand.',
  );
  await clickLine(page, id);
  const bar = page.getByTestId('sld-route-bar');
  await expect(bar).toBeVisible();
  await expect(page.getByTestId('sld-route-status')).toHaveText('Routed automatically');
  await expect(page.getByTestId('sld-route-note')).toContainText('Drag a run of the blue line');
  await expect(page.getByTestId('sld-route-reset')).toHaveCount(0);
  // The bar takes the place of the hint, and the diagram does not move for it.
  await expect(page.getByTestId('sld-canvas-hint')).toHaveCount(0);
  expect((await settled(page)).nodes).toEqual(opened.nodes);

  // ---- drag the run across ----
  const grab: [number, number] = [
    before[run]![0] + (before[run + 1]![0] - before[run]![0]) / 4,
    before[run]![1],
  ];
  await Promise.all([layoutWritten(page), dragFrom(page, grab, [0, 40])]);
  await expect(page.getByTestId('sld-route-status')).toHaveText('Routed by hand');
  await expect(page.getByTestId('sld-route-reset')).toBeVisible();
  const moved = (await settled(page)).edges[id]!.points;
  // It went down with the pointer, to there or to the nearest place that is clear.
  const went = moved[run]![1] - before[run]![1];
  expect(went).toBeGreaterThanOrEqual(6);
  expect(went).toBeLessThanOrEqual(40 + 48);
  expect(moved[run + 1]![1]).toBe(moved[run]![1]);
  // Its two ends are where they were, on their taps.
  expect(moved[0]).toEqual(before[0]);
  expect(moved.at(-1)).toEqual(before.at(-1));
  expect(await editedRoute(page)).toEqual(moved);
  expect(await overlapsOnScreen(page)).toEqual([]);
  expect(problems(await drawing(page))).toEqual([]);

  // ---- a tidy leaves it as it is ----
  await page.getByTestId('sld-tidy').click();
  await expect(page.getByTestId('sld-tidy-note')).toContainText(/Already tidy|by hand kept/);
  expect((await settled(page)).edges[id]!.points).toEqual(moved);
  await expect(page.getByTestId('sld-route-status')).toHaveText('Routed by hand');
  expect(await overlapsOnScreen(page)).toEqual([]);

  // ---- the arrow keys move the run that was dragged ----
  // Back up towards where it came from, which is clear.
  const handle = page.getByTestId(`sld-route-run-${run}`);
  await handle.focus();
  await Promise.all([layoutWritten(page), page.keyboard.press('ArrowUp')]);
  const nudged = (await settled(page)).edges[id]!.points;
  expect(nudged[run]![1]).toBe(moved[run]![1] - 5);
  expect(await overlapsOnScreen(page)).toEqual([]);

  // ---- with the values of a power flow on it ----
  await runPowerFlow(page);
  await settled(page);
  expect(await overlapsOnScreen(page)).toEqual([]);
  expect(await labelProblems(page)).toEqual([]);
  expect((await drawing(page)).edges[id]!.points).toEqual(nudged);

  // ---- a reload keeps it ----
  await page.reload();
  await openCase(page, `${stem}.xlsx`);
  expect((await settled(page)).edges[id]!.points).toEqual(nudged);
  // Picked from its menu this time, which hands one of its runs the focus of the keys.
  await pickFromMenu(page, id);
  await expect(page.getByTestId('sld-route-status')).toHaveText('Routed by hand');
  await expect(page.locator('[data-testid^="sld-route-run-"]:focus')).toHaveCount(1);

  // ---- Reset route, and Undo ----
  await Promise.all([layoutWritten(page), page.getByTestId('sld-route-reset').click()]);
  await expect(page.getByTestId('sld-route-status')).toHaveText('Routed automatically');
  const reset = (await settled(page)).edges[id]!.points;
  expect(reset).not.toEqual(nudged);
  expect(await overlapsOnScreen(page)).toEqual([]);
  await page.locator('body').press('Control+z');
  await expect(page.getByTestId('sld-route-status')).toHaveText('Routed by hand');
  expect((await settled(page)).edges[id]!.points).toEqual(nudged);
});

test('WSCC 9: the connector of a load moved by hand stays attached, goes along with its bus, and is reset with the rest', async ({
  page,
}) => {
  const stem = `route-e2e-stub-${Date.now()}`;

  await page.goto('/');
  await openCase(page, 'wscc9.xlsx');
  await settled(page);
  await openCopy(page, stem);
  const opened = await settled(page);

  const id = Object.keys(opened.edges).find((edge) => edge.startsWith('stub-load-'))!;
  const before = opened.edges[id]!.points;
  // Out of the load and square onto its bar: one run.
  expect(before).toHaveLength(2);
  const busId = /connection to bus (.+)$/.exec(opened.edges[id]!.label)![1]!;

  await clickLine(page, id);
  await expect(page.getByTestId('sld-route-name')).toContainText('The connector of');
  await expect(page.getByTestId('sld-route-status')).toHaveText('Routed automatically');

  // ---- slide it along the bar: a step, and the device end stays ----
  const middle: [number, number] = [before[0]![0], (before[0]![1] + before[1]![1]) / 2];
  // To the side of the bar that has the more room.
  const bus = opened.nodes[busId]!;
  const room = {
    left: before[1]![0] - (bus.x + (bus.barLeft ?? 0)),
    right: bus.x + (bus.barLeft ?? 0) + (bus.barLength ?? 0) - before[1]![0],
  };
  const by = room.right >= room.left ? 20 : -20;
  await Promise.all([layoutWritten(page), dragFrom(page, middle, [by, 0])]);
  await expect(page.getByTestId('sld-route-status')).toHaveText('Routed by hand');
  const moved = (await settled(page)).edges[id]!.points;
  expect(moved.length).toBeGreaterThan(2);
  expect(moved[0]).toEqual(before[0]);
  expect(Math.sign(moved.at(-1)![0] - before[1]![0])).toBe(Math.sign(by));
  expect(moved.at(-1)![1]).toBe(before[1]![1]);
  expect(await overlapsOnScreen(page)).toEqual([]);
  // Every connector still leaves the middle of a face and lands on a tap;
  // the one drawn by hand has the step it was given.
  expect(problems(await drawing(page))).toEqual([`${id}: more than one bend`]);

  // ---- the bus takes its load and the connector along ----
  await page.getByTestId('sld-route-done').click();
  await expect(page.getByTestId('sld-route-editor')).toHaveCount(0);
  await dragInDiagram(page, busId, 32, 16);
  const after = await settled(page);
  const shift = { x: after.nodes[busId]!.x - bus.x, y: after.nodes[busId]!.y - bus.y };
  expect(Math.hypot(shift.x, shift.y)).toBeGreaterThan(8);
  expect(rounded(after.edges[id]!.points)).toEqual(
    rounded(moved.map(([x, y]): [number, number] => [x + shift.x, y + shift.y])),
  );
  expect(await overlapsOnScreen(page)).toEqual([]);

  // ---- Reset manual routes, in the Arrange menu ----
  await page.getByTestId('sld-arrange-trigger').click();
  await expect(page.getByTestId('sld-arrange-menu')).toContainText('Lines moved by hand (1)');
  await Promise.all([layoutWritten(page), page.getByTestId('sld-arrange-reset-routes').click()]);
  const reset = (await settled(page)).edges[id]!.points;
  expect(reset).toHaveLength(2);
  expect(problems(await drawing(page))).toEqual([]);
  await page.getByTestId('sld-arrange-trigger').click();
  await expect(page.getByTestId('sld-arrange-no-manual-routes')).toBeVisible();
  await expect(page.getByTestId('sld-arrange-reset-routes')).toBeDisabled();
});

/** The shortest run of `points`. */
function shortestRun(points: Points): number {
  return Math.min(
    ...points.slice(1).map((p, i) => Math.hypot(p[0] - points[i]![0], p[1] - points[i]![1])),
  );
}

test('IEEE 14: a connector moved by hand cannot be folded onto its symbol, is given up when its device moves away, and reopens as it is drawn', async ({
  page,
}) => {
  const stem = `route-e2e-fold-${Date.now()}`;

  await page.goto('/');
  await openCase(page, 'ieee14_full.xlsx');
  await settled(page);
  await openCopy(page, stem);
  const opened = await settled(page);

  // The connector of a load that hangs square over its bar, with room to slide.
  const id = 'stub-load-PQ_3';
  const before = opened.edges[id]!.points;
  expect(before).toHaveLength(2);
  expect(before[0]![0]).toBe(before[1]![0]);
  const box = opened.nodes['load-PQ_3']!;

  await clickLine(page, id);
  const middle: [number, number] = [before[0]![0], (before[0]![1] + before[1]![1]) / 2];
  await Promise.all([layoutWritten(page), dragFrom(page, middle, [96, 0])]);
  await expect(page.getByTestId('sld-route-status')).toHaveText('Routed by hand');
  const stepped = (await settled(page)).edges[id]!.points;
  // Out of the symbol, a step aside, and onto the bar.
  expect(stepped).toHaveLength(4);
  expect(stepped[0]).toEqual(before[0]);
  expect(shortestRun(stepped)).toBeGreaterThanOrEqual(12);

  // ---- it cannot be folded back onto its own symbol ----
  // The neck dragged the other way, which would bring the line back up beside the symbol.
  const neck: [number, number] = [stepped[0]![0], (stepped[0]![1] + stepped[1]![1]) / 2];
  await dragFrom(page, neck, [-18, 0]);
  await expect(page.getByTestId('sld-route-note')).toContainText('Not there');
  expect(await editedRoute(page)).toEqual(stepped);
  // The run across dragged up into the symbol.
  const across: [number, number] = [(stepped[1]![0] + stepped[2]![0]) / 2, stepped[1]![1]];
  await dragFrom(page, across, [0, -30]);
  await expect(page.getByTestId('sld-route-note')).toContainText('its own symbol');
  expect(await editedRoute(page)).toEqual(stepped);
  const kept = (await settled(page)).edges[id]!.points;
  expect(kept).toEqual(stepped);
  // No run of it is along the symbol: all but the first keep off it.
  const bottom = box.y + box.height;
  for (const [, y] of kept.slice(1)) expect(y - bottom).toBeGreaterThanOrEqual(8);
  expect(await overlapsOnScreen(page)).toEqual([]);

  // ---- the load dragged to the other side of its bar ----
  await page.getByTestId('sld-route-done').click();
  await dragInDiagram(page, 'load-PQ_3', 0, 2 * (before[1]![1] - (box.y + box.height / 2)));
  // The route that was drawn does not fit there: the connector is worked out again.
  await expect(
    page.getByText(/The route you drew for the connector of PQ_3 no longer fits/),
  ).toBeVisible();
  const dropped = await settled(page);
  expect(dropped.nodes['load-PQ_3']!.y).toBeGreaterThan(before[1]![1]);
  expect(dropped.edges[id]!.points.length).toBeLessThanOrEqual(3);
  expect(await overlapsOnScreen(page)).toEqual([]);
  expect(problems(dropped)).toEqual([]);
  // The layout that was written for the move is the diagram as it is drawn.
  await page.waitForTimeout(1_200);

  // ---- a reload draws the same connector ----
  await page.reload();
  await openCase(page, `${stem}.xlsx`);
  const reopened = await settled(page);
  expect(reopened.nodes['load-PQ_3']).toEqual(dropped.nodes['load-PQ_3']);
  expect(reopened.edges[id]!.points).toEqual(dropped.edges[id]!.points);
  expect(await overlapsOnScreen(page)).toEqual([]);
  expect(problems(reopened)).toEqual([]);

  // ---- and the diagram can be laid out again ----
  await page.getByTestId('sld-arrange-trigger').click();
  await Promise.all([layoutWritten(page), page.getByTestId('sld-arrange-tidy-relayout').click()]);
  await expect(page.getByTestId('sld-tidy-note')).toContainText('Tidied');
  const laidOut = await settled(page);
  expect(laidOut.nodes['load-PQ_3']!.y).toBeLessThan(before[1]![1]);
  expect(await overlapsOnScreen(page)).toEqual([]);
});

test('WSCC 9: a line is picked by its row in the Lines table and with the keys, and a bend that was added turns the line with the arrow keys', async ({
  page,
}) => {
  const stem = `route-e2e-pick-${Date.now()}`;

  await page.goto('/');
  await openCase(page, 'wscc9.xlsx');
  await settled(page);
  await openCopy(page, stem);
  const opened = await settled(page);

  // ---- its row in the Lines table picks a line ----
  await page.getByRole('tab', { name: 'Lines' }).click();
  await page.getByTestId('lines-grid-row-line-Line_8').click();
  const editor = page.getByTestId('sld-route-editor');
  await expect(editor).toHaveAttribute('data-edge-id', 'line-Line_8');
  await expect(page.getByTestId('sld-route-name')).toContainText('Line_8');
  await expect(page.getByTestId('sld-route-status')).toHaveText('Routed automatically');
  // Let go of, the same row picks it again.
  await page.getByTestId('sld-route-done').click();
  await expect(editor).toHaveCount(0);
  await page.getByTestId('lines-grid-row-line-Line_8').click();
  await expect(editor).toHaveAttribute('data-edge-id', 'line-Line_8');

  // ---- a bend that is added takes the arrow keys, and turns the line ----
  const before = opened.edges['line-Line_8']!.points;
  await page.getByTestId('sld-route-add-bend').click();
  await expect(page.getByTestId('sld-route-note')).toContainText('press the arrow keys');
  await expect(page.locator('[data-testid^="sld-route-bend-"]:focus')).toHaveCount(1);
  await Promise.all([layoutWritten(page), page.keyboard.press('ArrowLeft')]);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('sld-route-status')).toHaveText('Routed by hand');
  const turned = (await settled(page)).edges['line-Line_8']!.points;
  expect(turned).toHaveLength(before.length + 1);
  // Its ends are where they were, on their taps.
  expect(turned[0]).toEqual(before[0]);
  expect(turned.at(-1)).toEqual(before.at(-1));
  expect(await overlapsOnScreen(page)).toEqual([]);
  // Tidy diagram counts it among the lines it leaves alone.
  await page.getByTestId('sld-route-done').click();
  await page.getByTestId('sld-tidy').click();
  await expect(page.getByTestId('sld-tidy-note')).toContainText(/Already tidy|by hand kept/);
  await page.getByTestId('sld-arrange-trigger').click();
  await expect(page.getByTestId('sld-arrange-menu')).toContainText('Lines moved by hand (1)');
  // Closed, the menu hands the focus back to its button.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sld-arrange-menu')).toHaveCount(0);
  await expect(page.getByTestId('sld-arrange-trigger')).toBeFocused();

  // ---- Enter picks the line that has the keyboard focus ----
  const other = Object.keys(opened.edges).find(
    (edge) => edge.startsWith('line-') && edge !== 'line-Line_8',
  )!;
  await page.locator(`.react-flow__edge[data-id="${other}"]`).focus();
  await page.keyboard.press('Enter');
  await expect(editor).toHaveAttribute('data-edge-id', other);
  // One of its runs has the focus: the arrow keys move it from there.
  await expect(page.locator('[data-testid^="sld-route-run-"]:focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
});

test('IEEE 14: every line is picked by a click on the middle of its element, a connector is not left along its bar, and the Inspector and a reopened drawer reach a route', async ({
  page,
}) => {
  const stem = `route-e2e-reach-${Date.now()}`;

  await page.goto('/');
  await openCase(page, 'ieee14_full.xlsx');
  await settled(page);
  await openCopy(page, stem);
  const opened = await settled(page);
  const editor = page.getByTestId('sld-route-editor');

  // ---- a click on the middle of the element is a click on the line ----
  // What an assistive tool, or anything else that does not aim, clicks: the
  // middle of the box of the element. Straight or with bends, each line has
  // a box, and the middle of it is on the line.
  for (const id of Object.keys(opened.edges)) {
    await page.locator(`.react-flow__edge[data-id="${id}"]`).click();
    await expect(editor).toHaveAttribute('data-edge-id', id);
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
  }

  // ---- a bend that holds a connector off its bar is not taken out ----
  const id = 'stub-load-PQ_3';
  const before = opened.edges[id]!.points;
  await clickLine(page, id);
  const middle: [number, number] = [before[0]![0], (before[0]![1] + before[1]![1]) / 2];
  await Promise.all([layoutWritten(page), dragFrom(page, middle, [96, 0])]);
  const stepped = (await settled(page)).edges[id]!.points;
  expect(stepped).toHaveLength(4);
  // Without the bend over its tap it would run from under the symbol
  // straight to the tap, along the bar and over the end beside its own.
  const bend = await onScreen(page, stepped[2]!);
  await page.mouse.dblclick(bend.x, bend.y);
  await expect(page.getByTestId('sld-route-note')).toContainText('Not removed');
  await expect(page.getByTestId('sld-route-note')).toHaveAttribute('data-tone', 'refused');
  expect((await settled(page)).edges[id]!.points).toEqual(stepped);
  // Moved alone towards the bar the same: it stays where it is on nothing.
  await page.keyboard.down('Shift');
  await dragFrom(page, stepped[2]!, [-90, 12]);
  await page.keyboard.up('Shift');
  const kept = (await settled(page)).edges[id]!.points;
  const [outer, tap] = [kept[kept.length - 2]!, kept[kept.length - 1]!];
  const slope = Math.abs(tap[1] - outer[1]) / Math.max(1, Math.abs(tap[0] - outer[0]));
  expect(slope).toBeGreaterThanOrEqual(Math.tan((29.5 * Math.PI) / 180));
  expect(await overlapsOnScreen(page)).toEqual([]);
  await page.getByTestId('sld-route-done').click();

  // ---- the Inspector of a line reaches its route ----
  const line = Object.keys(opened.edges).find(
    (edge) => edge.startsWith('line-') && levelRun(opened.edges[edge]!.points) > 0,
  )!;
  const points = opened.edges[line]!.points;
  const run = levelRun(points);
  await page.locator(`.react-flow__edge[data-id="${line}"]`).click();
  const section = page.getByTestId('route-section');
  await expect(section).toBeVisible();
  await expect(page.getByTestId('route-section-status')).toHaveText('Routed automatically');
  await expect(page.getByTestId('route-section-reset')).toBeDisabled();
  await expect(page.getByTestId('route-section-note')).toContainText('nothing to reset');
  const grab: [number, number] = [
    points[run]![0] + (points[run + 1]![0] - points[run]![0]) / 4,
    points[run]![1],
  ];
  await Promise.all([layoutWritten(page), dragFrom(page, grab, [0, 40])]);
  await expect(page.getByTestId('route-section-status')).toHaveText('Routed by hand');
  await page.getByTestId('sld-route-done').click();
  await expect(editor).toHaveCount(0);
  // Move route by hand shows the handles again; Reset route gives the route back.
  await page.getByTestId('route-section-edit').click();
  await expect(editor).toHaveAttribute('data-edge-id', line);
  await Promise.all([layoutWritten(page), page.getByTestId('route-section-reset').click()]);
  await expect(page.getByTestId('route-section-status')).toHaveText('Routed automatically');
  expect(await overlapsOnScreen(page)).toEqual([]);
  await page.keyboard.press('Escape');

  // ---- a drawer dragged down to its tab strip opens again on a tab ----
  const handle = (await page
    .getByRole('separator', { name: 'Resize bottom drawer' })
    .boundingBox())!;
  const viewport = page.viewportSize()!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, viewport.height - 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('bottom-drawer')).toHaveAttribute('data-collapsed', 'true');
  await expect(page.getByTestId('lines-grid')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Lines' }).click();
  await expect(page.getByTestId('bottom-drawer')).toHaveAttribute('data-collapsed', 'false');
  const row = page.getByTestId('lines-grid-row-line-Line_16');
  await row.click();
  await expect(editor).toHaveAttribute('data-edge-id', 'line-Line_16');
  const drawer = (await page.getByTestId('bottom-drawer').boundingBox())!;
  expect(drawer.height).toBeGreaterThan(150);
});
