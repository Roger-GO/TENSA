/**
 * Nothing on the diagram is drawn over anything else.
 *
 *   open each example case with no saved layout -> every line and
 *   transformer has a run and a tap of its own, none passes through a bar,
 *   a symbol or a label, and no two boxes reach into each other -> Tidy
 *   diagram and Tidy and re-layout both say there is nothing to do -> run a
 *   power flow -> the same holds with the readouts of the devices and the
 *   flow labels of the lines drawn, and with the labels of the buses grown
 *   by a voltage and an angle -> nothing was written beside the case for
 *   being opened and looked at
 *
 *   in a copy of each: move a bus, put a load beside its bar and another
 *   across it -> the lines are routed round them as each is dropped, and
 *   the rule still holds -> drop a load on a generator -> it is put in the
 *   nearest free place, a notice says so, and the rule still holds -> Tidy
 *   and re-layout -> it holds, and every bus is on the grid
 *
 *   in a copy of Kundur: drop a generator on another -> it is put beside
 *   it -> Tidy diagram -> nothing is drawn over anything else, the marks
 *   on the corners of the generators at a reactive limit included, and no
 *   flow label stands flush against a symbol -> drop a generator far
 *   beyond the bar of another bus, where its connector has no way back ->
 *   it goes back where it stood, a notice says so, and nothing is written
 *
 * What is on screen is read off the page (`drawnOnScreen` in
 * `sldDrawing.ts`) and handed to the checker the diagram itself routes by
 * (`findOverlaps` in `overlapCheck.ts`), so the boxes are the ones the
 * browser laid out: the unit tests hold the same rule on the sizes the
 * diagram works its places out with, and on a case of over a hundred buses,
 * which no example case seeded into a workspace is (`noOverlap.test.ts`).
 *
 * The drags are done in a copy saved under a name of this run's own, so the
 * example cases the other specs open keep their automatic layout.
 */
import { test, expect } from './fixtures';
import {
  NEAR,
  branchesIntoDevices,
  dragInDiagram,
  drawing,
  dropInDiagram,
  flowLabelsBySymbols,
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

/**
 * The example cases, each with what is moved by hand in its copy, in the
 * diagram's own units: a bus, a load that is put beside its bar, and a load
 * that is put across its bar or further along it. Each is dropped on free
 * ground: where a node is dropped on another, the two overlap because they
 * were put so.
 */
const EXAMPLES: {
  file: string;
  moves: [id: string, dx: number, dy: number][];
}[] = [
  {
    file: 'ieee14_full.xlsx',
    moves: [
      ['13', -155, 42],
      ['load-PQ_4', 70, -64],
      ['load-PQ_9', 14, -191],
    ],
  },
  {
    file: 'kundur_full.xlsx',
    moves: [
      ['3', -154, 68],
      ['load-PQ_0', -257, 0],
      ['load-PQ_1', 68, -223],
    ],
  },
  {
    file: 'wscc9.xlsx',
    moves: [
      ['6', -150, 56],
      ['load-PQ_0', 75, 207],
      ['load-PQ_2', -113, 66],
    ],
  },
];

for (const { file, moves } of EXAMPLES) {
  test(`${file}: nothing is drawn over anything else as it opens, with values, moved by hand, and laid out again`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const written: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/api/workspace/layout')) {
        written.push(request.url());
      }
    });

    // ---- As it opens ----------------------------------------------------------
    await page.goto('/');
    await openCase(page, file);
    const opened = await settled(page);
    expect(await overlapsOnScreen(page)).toEqual([]);
    expect(problems(opened)).toEqual([]);
    expect(branchesIntoDevices(opened)).toEqual([]);
    // Every device stands over or under its bar: each connector drops square.
    for (const [id, edge] of Object.entries(opened.edges)) {
      if (!id.startsWith('stub-')) continue;
      expect(edge.points, id).toHaveLength(2);
      expect(Math.abs(edge.points[0]![0] - edge.points[1]![0]), id).toBeLessThan(NEAR);
    }
    // It is arranged already: neither tidy finds anything to change, and
    // the button keeps saying so after the notice has gone.
    await page.getByTestId('sld-tidy').click();
    await expect(page.getByText('The diagram is already tidy.').last()).toBeVisible();
    await expect(page.getByTestId('sld-tidy-note')).toHaveText('Already tidy: nothing was changed');
    await page.getByTestId('sld-arrange-trigger').click();
    await page.getByTestId('sld-arrange-tidy-relayout').click();
    await expect(
      page.getByText(/Every bus is on the grid, every device beside its bus/),
    ).toBeVisible();
    await expect(page.getByTestId('sld-tidy-count')).toHaveCount(0);

    // ---- With the values of a power flow --------------------------------------
    await runPowerFlow(page);
    await settled(page);
    expect(await overlapsOnScreen(page)).toEqual([]);
    expect(await labelProblems(page)).toEqual([]);
    // Opening a case, tidying a tidy diagram and running a power flow write
    // nothing beside it.
    expect(written).toEqual([]);

    // ---- Moved by hand, in a copy ---------------------------------------------
    await openCopy(page, `no-overlap-${file.replace(/[_.].*$/, '')}-${Date.now()}`);
    await settled(page);
    await runPowerFlow(page);
    await settled(page);
    for (const [id, dx, dy] of moves) {
      await dragInDiagram(page, id, dx, dy);
      const moved = await settled(page);
      expect(await overlapsOnScreen(page), `after ${id} was moved`).toEqual([]);
      expect(branchesIntoDevices(moved), `after ${id} was moved`).toEqual([]);
      // No line was left drawn through a symbol or a bar for a tidy to put right.
      await expect(page.getByTestId('sld-tidy-count')).toHaveCount(0);
    }

    // ---- Dropped on a symbol ---------------------------------------------------
    // A load let go on a generator does not stay on it: it stands in the
    // nearest free place, and the diagram says that it was moved there.
    const before = await drawing(page);
    const idOf = (type: string): string =>
      Object.entries(before.nodes).find(([, node]) => node.type === type)![0];
    const [load, generator] = [idOf('load'), idOf('generator')];
    const onto = before.nodes[generator]!;
    await dragInDiagram(
      page,
      load,
      onto.x + 10 - before.nodes[load]!.x,
      onto.y + 6 - before.nodes[load]!.y,
    );
    await expect(page.getByText('Moved to the nearest free place').last()).toBeVisible();
    const put = await settled(page);
    const [a, b] = [put.nodes[load]!, put.nodes[generator]!];
    const apart =
      a.x >= b.x + b.width ||
      b.x >= a.x + a.width ||
      a.y >= b.y + b.height ||
      b.y >= a.y + a.height;
    expect(apart, `${load} and ${generator}`).toBe(true);
    expect(await overlapsOnScreen(page), `after ${load} was dropped on ${generator}`).toEqual([]);
    expect(branchesIntoDevices(put), `after ${load} was dropped on ${generator}`).toEqual([]);

    // ---- Laid out again -------------------------------------------------------
    await page.getByTestId('sld-arrange-trigger').click();
    await Promise.all([layoutWritten(page), page.getByTestId('sld-arrange-tidy-relayout').click()]);
    await expect(
      page.getByText('Diagram tidied and laid out again', { exact: true }).last(),
    ).toBeVisible();
    const laidOut = await settled(page);
    for (const [id, node] of Object.entries(laidOut.nodes)) {
      if (node.type !== 'bus') continue;
      expect(Math.abs(node.x % GRID_STEP), `bus ${id}`).toBe(0);
      expect(Math.abs(node.y % GRID_STEP), `bus ${id}`).toBe(0);
    }
    for (const [id, edge] of Object.entries(laidOut.edges)) {
      if (!id.startsWith('stub-')) continue;
      expect(edge.points, id).toHaveLength(2);
      expect(Math.abs(edge.points[0]![0] - edge.points[1]![0]), id).toBeLessThan(NEAR);
    }
    expect(problems(laidOut)).toEqual([]);
    expect(branchesIntoDevices(laidOut)).toEqual([]);
    expect(await overlapsOnScreen(page)).toEqual([]);
    expect(await labelProblems(page)).toEqual([]);
  });
}

test('kundur_full.xlsx: a tidy keeps the labels off the marks of the generators, and a generator with no clear place goes back', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await openCase(page, 'kundur_full.xlsx');
  await settled(page);
  await openCopy(page, `no-overlap-kundur-marks-${Date.now()}`);
  await settled(page);
  await runPowerFlow(page);
  await settled(page);
  // The generators at a reactive limit carry a mark on their corner.
  await expect(page.locator('[data-testid^="generator-q-marker-"]').first()).toBeVisible();
  expect(await overlapsOnScreen(page)).toEqual([]);
  expect(await flowLabelsBySymbols(page)).toEqual([]);

  // ---- One generator dropped on another, and tidied ---------------------------
  const opened = await drawing(page);
  const [g3, g4] = [opened.nodes['generator-3']!, opened.nodes['generator-4']!];
  await dragInDiagram(page, 'generator-3', g4.x + 12 - g3.x, g4.y + 8 - g3.y);
  await expect(page.getByText('Moved to the nearest free place').last()).toBeVisible();
  await settled(page);
  expect(await overlapsOnScreen(page)).toEqual([]);
  expect(await flowLabelsBySymbols(page)).toEqual([]);
  await page.getByTestId('sld-tidy').click();
  await expect(page.getByTestId('sld-tidy-note')).toBeVisible();
  await settled(page);
  expect(await overlapsOnScreen(page), 'after the tidy').toEqual([]);
  expect(await flowLabelsBySymbols(page), 'after the tidy').toEqual([]);
  expect(await labelProblems(page), 'after the tidy').toEqual([]);

  // ---- A generator dropped where its connector has no way back -----------------
  // Far east of its bus and below it, beyond the bars of the buses between:
  // no place near there can be drawn, so the move is not made.
  const written: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/api/workspace/layout')) {
      written.push(request.url());
    }
  });
  const stood = (await settled(page)).nodes['generator-3']!;
  await dropInDiagram(page, 'generator-3', 320, 70);
  await expect(page.getByText('Put back where it was').last()).toBeVisible();
  const back = (await settled(page)).nodes['generator-3']!;
  expect({ x: back.x, y: back.y }).toEqual({ x: stood.x, y: stood.y });
  expect(await overlapsOnScreen(page)).toEqual([]);
  expect(written).toEqual([]);
});
