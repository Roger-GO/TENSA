/**
 * Tidy diagram, and arranging a diagram by hand.
 *
 *   open IEEE 14 in its automatic arrangement, where no line shares a run
 *   with another -> Tidy diagram says there is nothing to tidy -> move a bus
 *   and two loads by hand: the lines are routed round them as they are
 *   dropped, and none shares a run or is in a bar or a device -> Tidy
 *   diagram -> nothing has moved, every line and transformer runs at right
 *   angles from a tap to a tap -> Undo (Ctrl+Z) -> the routes of before ->
 *   Redo from the Edit menu -> tidied again -> reload the page -> the same
 *   routes
 *
 *   open WSCC 9 -> drag a bus -> its load goes along -> Undo puts both back
 *   -> pick two buses with Ctrl held -> Align top from the bar over the
 *   diagram -> they stand level -> turn Snap to grid on -> a drag lands on
 *   the grid -> Tidy and re-layout -> every bus on the grid, every device
 *   beside its bus, every connector where it should be -> one Undo takes all
 *   of that back -> reload the page -> the diagram as it was left
 *
 * It drives the real UI against a real `tensa serve` (see `playwright.config.ts`)
 * in a real browser, and reads what React Flow drew (`sldDrawing.ts`). The
 * unit tests check the routes `tidy.ts` works out; this one checks them where
 * the size of a device is the one the browser measured, the taps are the
 * ones the bars drew, and Undo is the key a user presses.
 * `sld-no-overlap.spec.ts` holds every example case to the rule that nothing
 * is drawn over anything else.
 *
 * Everything is done in a copy saved under a name of this run's own, so the
 * example cases the other specs open keep their automatic layout.
 */
import { test, expect } from './fixtures';
import {
  NEAR,
  branchesIntoDevices,
  dragBy,
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
  type Drawing,
} from './sldDrawing';

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';

/** The step of the diagram's grid (`GRID_STEP` in `tidy.ts`). */
const GRID_STEP = 16;

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

/** Where every node stands, without what its connections add to it (the taps of a bar). */
function placement(drawn: Drawing): Record<string, { x: number; y: number }> {
  return Object.fromEntries(Object.entries(drawn.nodes).map(([id, n]) => [id, { x: n.x, y: n.y }]));
}

/** The path of every line and transformer. */
function branchPaths(drawn: Drawing): Record<string, [number, number][]> {
  return Object.fromEntries(
    Object.entries(drawn.edges)
      .filter(([id]) => !id.startsWith('stub-'))
      .map(([id, edge]) => [id, edge.points]),
  );
}

/** Every pair of branches that lie on top of each other, or side by side nearer than 10, for more than a pixel. */
function sharedRuns(drawn: Drawing): string[] {
  const paths = Object.entries(branchPaths(drawn));
  const found: string[] = [];
  for (let i = 0; i < paths.length; i += 1) {
    for (let k = i + 1; k < paths.length; k += 1) {
      const [a, b] = [paths[i]![1], paths[k]![1]];
      let shared = 0;
      for (let m = 1; m < a.length; m += 1) {
        for (let n = 1; n < b.length; n += 1) {
          const [p, q, r, s] = [a[m - 1]!, a[m]!, b[n - 1]!, b[n]!];
          for (const axis of [0, 1] as const) {
            const other = axis === 0 ? 1 : 0;
            const level =
              Math.abs(p[other] - q[other]) < NEAR && Math.abs(r[other] - s[other]) < NEAR;
            if (!level || Math.abs(p[other] - r[other]) >= 10) continue;
            const from = Math.max(Math.min(p[axis], q[axis]), Math.min(r[axis], s[axis]));
            const to = Math.min(Math.max(p[axis], q[axis]), Math.max(r[axis], s[axis]));
            shared += Math.max(0, to - from);
          }
        }
      }
      if (shared > 1) found.push(`${paths[i]![0]} and ${paths[k]![0]}`);
    }
  }
  return found;
}

test('IEEE 14 opens tidy, stays so when it is arranged by hand, and a Tidy diagram is one step for Undo and is kept through a reload', async ({
  page,
}) => {
  const stem = `tidy-e2e-${Date.now()}`;

  await page.goto('/');
  await openCase(page, 'ieee14_full.xlsx');
  await settled(page);
  await openCopy(page, stem);
  const opened = await settled(page);
  // The automatic arrangement routes every line clear of the rest: none
  // shares a run with another, none is in a bar or a device.
  expect(sharedRuns(opened)).toEqual([]);
  expect(problems(opened)).toEqual([]);
  expect(branchesIntoDevices(opened)).toEqual([]);

  // ---- The first Tidy diagram has nothing to do ------------------------------
  await expect(page.getByTestId('sld-tidy')).toHaveAttribute('title', /Nothing is moved/);
  await page.getByTestId('sld-tidy').click();
  await expect(page.getByText('The diagram is already tidy.')).toBeVisible();
  await expect(page.getByTestId('sld-tidy-count')).toHaveCount(0);

  // ---- Arranged by hand: the lines follow as each node is dropped ------------
  // A bus is moved, a load is put beside its bar, and another across it.
  await dragInDiagram(page, '13', -155, 42);
  await dragInDiagram(page, 'load-PQ_4', 70, -64);
  await dragInDiagram(page, 'load-PQ_9', 14, -191);
  const before = await settled(page);
  expect(placement(before)).not.toEqual(placement(opened));
  expect(sharedRuns(before)).toEqual([]);
  expect(branchesIntoDevices(before)).toEqual([]);
  expect(await overlapsOnScreen(page)).toEqual([]);
  // No line runs through a symbol or a bar, so the button has none to count.
  await expect(page.getByTestId('sld-tidy-count')).toHaveCount(0);

  // ---- Tidy diagram ---------------------------------------------------------
  // The lines were routed one drop at a time, each round what was there: all
  // of them routed together come out simpler.
  const [write] = await Promise.all([layoutWritten(page), page.getByTestId('sld-tidy').click()]);
  expect(write.status()).toBe(204);
  await expect(page.getByText('Diagram tidied', { exact: true })).toBeVisible();
  const tidied = await settled(page);

  expect(placement(tidied)).toEqual(placement(before));
  expect(branchPaths(tidied)).not.toEqual(branchPaths(before));
  expect(sharedRuns(tidied)).toEqual([]);
  // Every branch runs at right angles from a tap to a tap, clear of the bars
  // it passes, and none is in a device. (The two loads that were dragged
  // stand where they were put: beside their bars, each on a connector of
  // its own.)
  expect(problems(tidied).filter((problem) => !problem.startsWith('stub-'))).toEqual([]);
  expect(branchesIntoDevices(tidied)).toEqual([]);
  expect(await overlapsOnScreen(page)).toEqual([]);
  // The routes are in the file, each with the two buses it runs between.
  const saved = write.request().postDataJSON() as {
    branches: Record<string, Record<string, { routing: string; bus1: string; bus2: string }>>;
  };
  const routed = [
    ...Object.values(saved.branches.line ?? {}),
    ...Object.values(saved.branches.transformer ?? {}),
  ];
  expect(routed).toHaveLength(20);
  expect(routed.every((route) => route.routing === 'polyline')).toBe(true);

  // Asked again, there is nothing left to tidy.
  await page.getByTestId('sld-tidy').click();
  await expect(page.getByText('The diagram is already tidy.').last()).toBeVisible();
  await expect(page.getByTestId('sld-tidy-count')).toHaveCount(0);

  // ---- One Undo, one Redo ---------------------------------------------------
  await Promise.all([layoutWritten(page), page.keyboard.press('Control+z')]);
  await expect(page.getByText('Undone: tidy diagram')).toBeVisible();
  const undone = await settled(page);
  expect(branchPaths(undone)).toEqual(branchPaths(before));
  expect(placement(undone)).toEqual(placement(before));

  await page.getByTestId('topbar-menu-edit-trigger').click();
  const redo = page.getByTestId('topbar-menu-edit-redo');
  await expect(redo).toHaveText(/Redo: tidy diagram/);
  await Promise.all([layoutWritten(page), redo.click()]);
  const redone = await settled(page);
  expect(branchPaths(redone)).toEqual(branchPaths(tidied));

  // ---- A page loaded afresh draws the same ---------------------------------
  await page.reload();
  await openCase(page, `${stem}.xlsx`);
  const reopened = await settled(page);
  expect(branchPaths(reopened)).toEqual(branchPaths(tidied));
  expect(placement(reopened)).toEqual(placement(tidied));
  expect(sharedRuns(reopened)).toEqual([]);

  // ---- The values of a power flow have room on a tidied diagram --------------
  // A tidy leaves every device a place for its P and Q, so they can be read
  // when a power flow is run afterwards: no line runs through the values of
  // a device, and no label stands on a symbol or on another.
  await runPowerFlow(page);
  await settled(page);
  expect(await labelProblems(page)).toEqual([]);
  expect(await overlapsOnScreen(page)).toEqual([]);
});

test('a bus takes its devices along, moves are taken back, picked buses are lined up, and a re-layout tidies it all', async ({
  page,
}) => {
  const stem = `arrange-e2e-${Date.now()}`;

  await page.goto('/');
  await openCase(page, 'wscc9.xlsx');
  await settled(page);
  await openCopy(page, stem);
  const start = await settled(page);
  // Bus 5 has a load.
  const load = 'load-PQ_0';
  expect(start.edges[`stub-${load}`]!.label).toMatch(/connection to bus 5$/);

  // ---- A bus that is dragged takes its devices along ------------------------
  await dragBy(page, '5', -90, 40);
  const dragged = await settled(page);
  const moved = {
    x: dragged.nodes['5']!.x - start.nodes['5']!.x,
    y: dragged.nodes['5']!.y - start.nodes['5']!.y,
  };
  expect(moved.x).toBeLessThan(-30);
  expect(dragged.nodes[load]!.x - start.nodes[load]!.x).toBeCloseTo(moved.x, 1);
  expect(dragged.nodes[load]!.y - start.nodes[load]!.y).toBeCloseTo(moved.y, 1);
  // Nothing else moved, and the load is still connected as it was: square
  // onto its bar. The lines of the bus were routed to where it stands now,
  // each on a run of its own and clear of every bar and device.
  expect(dragged.nodes['6']).toMatchObject({ x: start.nodes['6']!.x, y: start.nodes['6']!.y });
  expect(problems(dragged)).toEqual([]);
  expect(sharedRuns(dragged)).toEqual([]);
  expect(branchesIntoDevices(dragged)).toEqual([]);

  // ---- Undo puts the bus and its load back ----------------------------------
  await page.getByTestId('topbar-menu-edit-trigger').click();
  await expect(page.getByTestId('topbar-menu-edit-undo')).toHaveText(/Undo: move bus Bus 5/);
  await page.keyboard.press('Escape');
  await Promise.all([layoutWritten(page), page.keyboard.press('Control+z')]);
  const back = await settled(page);
  expect(placement(back)).toEqual(placement(start));
  expect(branchPaths(back)).toEqual(branchPaths(start));

  // ---- Two buses picked with Ctrl held, and lined up ------------------------
  // Buses 5 and 8 stand in different columns, at different heights.
  const bar = (id: string) => page.getByTestId(`bus-bar-${id}`);
  await bar('5').click();
  await bar('8').click({ modifiers: ['Control'] });
  await expect(page.getByTestId('sld-selection-count')).toHaveText('2 picked');
  expect(start.nodes['8']!.y).not.toBe(start.nodes['5']!.y);
  await Promise.all([layoutWritten(page), page.getByTestId('sld-align-top').click()]);
  const aligned = await settled(page);
  const top = Math.min(start.nodes['5']!.y, start.nodes['8']!.y);
  expect(aligned.nodes['5']!.y).toBe(top);
  expect(aligned.nodes['8']!.y).toBe(top);
  expect(aligned.nodes['5']!.x).toBe(start.nodes['5']!.x);
  expect(aligned.nodes['8']!.x).toBe(start.nodes['8']!.x);
  // The load of the bus that moved went with it.
  expect(aligned.nodes[load]!.y - start.nodes[load]!.y).toBe(
    aligned.nodes['5']!.y - start.nodes['5']!.y,
  );

  // ---- Snap to grid: a drag lands on the grid -------------------------------
  await page.getByTestId('sld-arrange-trigger').click();
  await page.getByTestId('sld-snap-toggle').check();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sld-arrange-menu')).toBeHidden();
  await dragBy(page, '3', 53, 27);
  const snapped = await settled(page);
  expect(Math.abs(snapped.nodes['3']!.x % GRID_STEP)).toBe(0);
  expect(Math.abs(snapped.nodes['3']!.y % GRID_STEP)).toBe(0);
  expect(snapped.nodes['3']!.x).not.toBe(start.nodes['3']!.x);

  // ---- Tidy and re-layout ---------------------------------------------------
  // A load is dragged far from its bus first.
  await dragBy(page, 'load-PQ_2', 260, -180);
  const messy = await settled(page);
  await page.getByTestId('sld-arrange-trigger').click();
  await Promise.all([layoutWritten(page), page.getByTestId('sld-arrange-tidy-relayout').click()]);
  await expect(page.getByText('Diagram tidied and laid out again')).toBeVisible();
  const laidOut = await settled(page);
  for (const [id, node] of Object.entries(laidOut.nodes)) {
    if (node.type !== 'bus') continue;
    expect(Math.abs(node.x % GRID_STEP), `bus ${id}`).toBe(0);
    expect(Math.abs(node.y % GRID_STEP), `bus ${id}`).toBe(0);
  }
  // Every device stands over or under its bar again: each connector drops square.
  for (const [id, edge] of Object.entries(laidOut.edges)) {
    if (!id.startsWith('stub-')) continue;
    expect(edge.points, id).toHaveLength(2);
    expect(Math.abs(edge.points[0]![0] - edge.points[1]![0]), id).toBeLessThan(NEAR);
  }
  expect(problems(laidOut)).toEqual([]);
  expect(branchesIntoDevices(laidOut)).toEqual([]);
  expect(sharedRuns(laidOut)).toEqual([]);

  // One Undo takes the whole of it back.
  await Promise.all([layoutWritten(page), page.keyboard.press('Control+z')]);
  await expect(page.getByText('Undone: tidy and re-layout')).toBeVisible();
  const restored = await settled(page);
  expect(placement(restored)).toEqual(placement(messy));
  expect(branchPaths(restored)).toEqual(branchPaths(messy));

  // What is on screen is what a page loaded afresh draws.
  const final = await drawing(page);
  await page.reload();
  await openCase(page, `${stem}.xlsx`);
  const reopened = await settled(page);
  expect(placement(reopened)).toEqual(placement(final));
  expect(branchPaths(reopened)).toEqual(branchPaths(final));
});
