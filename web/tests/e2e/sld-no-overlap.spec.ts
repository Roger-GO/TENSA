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
 *   in a copy of Kundur, as a reviewer drags it: a generator beside the bar
 *   of its bus, a load far above its own, Tidy diagram, and the page
 *   reloaded -> the bars keep their gap, no line ends or turns short of a
 *   bar in line with one on its other face, and nothing is drawn over
 *   anything else; the placement is what it was after the reload
 *
 *   in a copy of IEEE 39 and of NPCC, the two larger cases a first run seeds: a
 *   generator put level with the bar of its bus and a load far above its
 *   own, Tidy diagram, and the page reloaded -> nothing is drawn over
 *   anything else and the placement is what it was after the reload
 *
 *   in NPCC, a generator that is put under its bus where a load of that bus
 *   stands between the two -> it stays where it was dropped, with its connector
 *   stepped round the load and 6 or more from it, and nothing is drawn over
 *   anything else, as dropped, after a tidy and after a reload
 *
 *   in WECC 179, a gallery case that is added to the workspace first -> as it
 *   opens, after a tidy, with the values of a power flow and laid out again,
 *   no two bars read as one (buses 108 and 129 stand level, 10 px apart in the
 *   automatic layout once) and nothing is drawn over anything else, and every
 *   machine control is on the symbol of its unit (none is an orphan badge)
 *
 *   in the small gallery cases (Kundur with a stabiliser, IEEE 14 with a fault, PJM 5-bus, IEEE 14 with a
 *   solar plant and with a type-3 wind turbine), added to the workspace first -> as they open, after a tidy
 *   and with the values of a power flow, nothing is drawn over anything else, and every exciter, governor,
 *   stabiliser and converter model is on the symbol of its unit (the seven models of the wind turbine too)
 *
 *   in IEEE 118, a steady-state gallery case of 118 buses that is added to the workspace first -> as it
 *   opens, after a tidy, with the values of a power flow and laid out again, nothing is drawn over
 *   anything else, and the generators' reactive limits that the power flow leaves are counted
 *
 *   in IEEE RTS-24, IEEE 30 and 57 (bundled with TENSA from the PGLib-OPF library), RTS-GMLC (bundled from its
 *   repository, a PSS/E file with up to six generators at one bus), PEGASE 89 and ACTIVSg200 (bundled from MATPOWER) and IEEE 300
 *   (a steady-state gallery case of 300 buses and 710 connectors), each added to the workspace first -> as it
 *   opens, after a tidy, with the values of a power flow and laid out again, nothing is drawn over anything else,
 *   the device connectors that do not drop square are those listed, and the Violations tab counts what the
 *   catalog's entry names
 *
 *   a load of Kundur pulled down level with bus 12 and bus 13, west of the
 *   bar of bus 13 -> it stays where it was dropped, with no notice, and the
 *   bar of bus 12 that is drawn out to its tap keeps its gap to bar 13
 *
 *   in IEEE 14, a load dragged straight up past a generator -> its connector
 *   keeps clear of the block of the generator, and nothing is drawn over
 *   anything else, before and after a reload
 *
 * What is on screen is read off the page (`drawnOnScreen` in
 * `sldDrawing.ts`) and handed to the checker the diagram itself routes by
 * (`findOverlaps` in `overlapCheck.ts`), so the boxes are the ones the
 * browser laid out: the unit tests hold the same rule on the sizes the
 * diagram works its places out with, and on the 118-bus case
 * (`noOverlap.test.ts`).
 *
 * The drags are done in a copy saved under a name of this run's own, so the
 * example cases the other specs open keep their automatic layout.
 */
import { test, expect } from './fixtures';
import {
  NEAR,
  type Drawing,
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
  /**
   * The connectors that do not drop square onto their bar, where a bus is so
   * crowded that its device has no place in line with its tap: one leaves the
   * middle of its face for the end of the bar. None on the small cases.
   */
  slanted?: string[];
  /**
   * Whether a re-layout of the case as it opens finds nothing to move. It does
   * on the small cases. On the 140-bus case it puts buses on the grid that the
   * automatic layout left off it, and writes the layout, which the later check
   * that looking at a case writes nothing would then catch.
   */
  arranged?: boolean;
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
  {
    file: 'ieee39_full.xlsx',
    moves: [
      ['10', -100, 48],
      ['load-PQ_8', 70, -64],
      ['load-PQ_10', 14, -191],
    ],
  },
  {
    file: 'npcc.xlsx',
    moves: [
      ['24', -80, 64],
      ['load-PQ_13', 60, -70],
      ['load-PQ_12', 14, 120],
    ],
    slanted: ['stub-generator-25', 'stub-load-PQ_67'],
    arranged: false,
  },
];

/** The device connectors of a drawing that do not drop square onto their bar. */
function slantedConnectors(edges: Drawing['edges']): string[] {
  const slanted: string[] = [];
  for (const [id, edge] of Object.entries(edges)) {
    if (!id.startsWith('stub-')) continue;
    // A connector is a straight run from the face of its device to its tap.
    expect(edge.points, id).toHaveLength(2);
    if (Math.abs(edge.points[0]![0] - edge.points[1]![0]) >= NEAR) slanted.push(id);
  }
  return slanted.sort();
}

for (const { file, moves, slanted = [], arranged = true } of EXAMPLES) {
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
    expect(slantedConnectors(opened.edges)).toEqual(slanted);
    // It is arranged already: neither tidy finds anything to change, and
    // the button keeps saying so after the notice has gone.
    await page.getByTestId('sld-tidy').click();
    await expect(page.getByText('The diagram is already tidy.').last()).toBeVisible();
    await expect(page.getByTestId('sld-tidy-note')).toHaveText('Already tidy: nothing was changed');
    if (arranged) {
      await page.getByTestId('sld-arrange-trigger').click();
      await page.getByTestId('sld-arrange-tidy-relayout').click();
      await expect(
        page.getByText(/Every bus is on the grid, every device beside its bus/),
      ).toBeVisible();
      await expect(page.getByTestId('sld-tidy-count')).toHaveCount(0);
    }

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
    expect(slantedConnectors(laidOut.edges)).toEqual(slanted);
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

test('kundur_full.xlsx: bars keep their gap and no line reads as going through a bar, after a generator is put beside its bus, a load far above its own, a tidy and a reload', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await openCase(page, 'kundur_full.xlsx');
  await settled(page);
  await openCopy(page, `no-overlap-kundur-clearance-${Date.now()}`);
  await settled(page);
  await runPowerFlow(page);
  const opened = await settled(page);
  expect(problems(opened)).toEqual([]);

  // Generator 3 stands level with the bar of its bus (12), past its east tip,
  // towards bus 13 on the same row: its bar is drawn out to hold the tap.
  // (50 past the end of the bar as it is drawn, which the taps made longer than the node.)
  const [generator, bus] = [opened.nodes['generator-3']!, opened.nodes['3']!];
  await dragInDiagram(
    page,
    'generator-3',
    bus.x + (bus.barLeft ?? 0) + (bus.barLength ?? bus.width) + 50 - generator.x,
    bus.y + 3 - generator.height / 2 - generator.y,
  );
  const aside = await settled(page);
  expect(problems(aside)).toEqual([]);
  expect(await overlapsOnScreen(page), 'with the generator beside its bus').toEqual([]);

  // A load far above its bar, so that its connector comes a long way down.
  await dragInDiagram(page, 'load-PQ_0', 0, -150);
  const moved = await settled(page);
  expect(problems(moved)).toEqual([]);
  expect(await overlapsOnScreen(page), 'with the load far above its bar').toEqual([]);

  await page.getByTestId('sld-tidy').click();
  const tidy = await settled(page);
  expect(problems(tidy)).toEqual([]);
  expect(await overlapsOnScreen(page), 'after the tidy').toEqual([]);

  // Reloaded, it is drawn as it was left.
  await page.reload();
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 90_000 });
  const again = await settled(page);
  expect(problems(again)).toEqual([]);
  expect(await overlapsOnScreen(page), 'after the reload').toEqual([]);
  for (const [id, node] of Object.entries(tidy.nodes)) {
    expect({ x: again.nodes[id]?.x, y: again.nodes[id]?.y }, id).toEqual({ x: node.x, y: node.y });
  }
  for (const [id, edge] of Object.entries(tidy.edges)) {
    expect(again.edges[id]?.points, id).toEqual(edge.points);
  }
});

for (const { file, generator, load } of [
  { file: 'ieee39_full.xlsx', generator: 'generator-4', load: 'load-PQ_8' },
  { file: 'npcc.xlsx', generator: 'generator-13', load: 'load-PQ_19' },
]) {
  test(`${file}: a generator put beside its bus, a load far above its own, a tidy and a reload keep the rule and the placement`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await page.goto('/');
    await openCase(page, file);
    await settled(page);
    await openCopy(page, `no-overlap-${file.replace(/[_.].*$/, '')}-clearance-${Date.now()}`);
    await settled(page);
    await runPowerFlow(page);
    const opened = await settled(page);
    expect(problems(opened)).toEqual([]);

    // The bus the generator hangs from is the one whose bar its connector ends on.
    const tap = opened.edges[`stub-${generator}`]!.points[1]!;
    const bus = Object.values(opened.nodes).find(
      (node) =>
        node.type === 'bus' &&
        Math.abs(node.y - tap[1]) < 12 &&
        tap[0] >= node.x + (node.barLeft ?? 0) - 1 &&
        tap[0] <= node.x + (node.barLeft ?? 0) + (node.barLength ?? node.width) + 1,
    )!;
    expect(bus, `the bus of ${generator}`).toBeDefined();
    const unit = opened.nodes[generator]!;

    // Level with the bar of its bus, past the east tip.
    await dragInDiagram(
      page,
      generator,
      bus.x + (bus.barLeft ?? 0) + (bus.barLength ?? bus.width) + 50 - unit.x,
      bus.y + 3 - unit.height / 2 - unit.y,
    );
    const aside = await settled(page);
    expect(problems(aside)).toEqual([]);
    expect(await overlapsOnScreen(page), 'with the generator beside its bus').toEqual([]);

    // A load far above its bar, so that its connector comes a long way down.
    await dragInDiagram(page, load, 0, -150);
    const moved = await settled(page);
    expect(problems(moved)).toEqual([]);
    expect(await overlapsOnScreen(page), 'with the load far above its bar').toEqual([]);

    await page.getByTestId('sld-tidy').click();
    const tidy = await settled(page);
    expect(problems(tidy)).toEqual([]);
    expect(await overlapsOnScreen(page), 'after the tidy').toEqual([]);

    // Reloaded, it is drawn as it was left.
    await page.reload();
    await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 90_000 });
    const again = await settled(page);
    expect(problems(again)).toEqual([]);
    expect(await overlapsOnScreen(page), 'after the reload').toEqual([]);
    for (const [id, node] of Object.entries(tidy.nodes)) {
      expect({ x: again.nodes[id]?.x, y: again.nodes[id]?.y }, id).toEqual({
        x: node.x,
        y: node.y,
      });
    }
    for (const [id, edge] of Object.entries(tidy.edges)) {
      expect(again.edges[id]?.points, id).toEqual(edge.points);
    }
  });
}

/**
 * The device connectors of WECC 179 that do not drop square onto their bar: four shunts, whose
 * buses are so crowded that the shunt has no place in line with its tap.
 */
const WECC_SLANTED = [
  'stub-shunt-Shunt_11',
  'stub-shunt-Shunt_13',
  'stub-shunt-Shunt_14',
  'stub-shunt-Shunt_3',
];

test('wecc_full.xlsx: a gallery case of 179 buses is drawn with nothing over anything else, and no two bars read as one, as it opens, tidied, with values and laid out again', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  // WECC is not seeded into a workspace: copy it from the user's ANDES, as the gallery's Add
  // does. A workspace another run already added it to answers with a conflict, which is the same.
  const added = await request.post('/api/examples/wecc/add');
  expect([201, 409]).toContain(added.status());
  const written: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/api/workspace/layout')) {
      written.push(request.url());
    }
  });

  // ---- As it opens ------------------------------------------------------------
  await page.goto('/');
  await openCase(page, 'wecc_full.xlsx');
  const opened = await settled(page);
  expect(await overlapsOnScreen(page)).toEqual([]);
  // `problems` holds the bars to `BAR_GAP` apart (buses 129 and 108 were 10 px apart).
  expect(problems(opened)).toEqual([]);
  expect(branchesIntoDevices(opened)).toEqual([]);
  expect(slantedConnectors(opened.edges)).toEqual(WECC_SLANTED);
  // Every exciter, governor and stabiliser names a machine or an exciter of the case that the
  // server lists, so each is on the symbol of its unit and none is left in the gutter.
  await expect(page.locator('.react-flow__node-controller')).toHaveCount(0);
  await expect(page.locator('[data-orphan="true"]')).toHaveCount(0);

  // ---- Tidy ---------------------------------------------------------------------
  await page.getByTestId('sld-tidy').click();
  await expect(page.getByText('The diagram is already tidy.').last()).toBeVisible();
  await expect(page.getByTestId('sld-tidy-note')).toHaveText('Already tidy: nothing was changed');

  // ---- With the values of a power flow ------------------------------------------
  await runPowerFlow(page);
  const shown = await settled(page);
  expect(problems(shown)).toEqual([]);
  expect(await overlapsOnScreen(page)).toEqual([]);
  expect(await labelProblems(page)).toEqual([]);
  // Opening a case, tidying a tidy diagram and running a power flow write nothing beside it.
  expect(written).toEqual([]);

  // ---- Laid out again -----------------------------------------------------------
  await page.getByTestId('sld-arrange-trigger').click();
  await page.getByTestId('sld-arrange-tidy-relayout').click();
  const laidOut = await settled(page);
  expect(problems(laidOut)).toEqual([]);
  expect(branchesIntoDevices(laidOut)).toEqual([]);
  expect(slantedConnectors(laidOut.edges)).toEqual(WECC_SLANTED);
  expect(await overlapsOnScreen(page)).toEqual([]);
});

/** The device connectors of IEEE 118 that do not drop square onto their bar, as it is drawn. */
const IEEE118_SLANTED: string[] = ['stub-load-PQ_46'];

test('case118.m: a steady-state gallery case of 118 buses is drawn with nothing over anything else as it opens, tidied, with values and laid out again', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  // Not seeded: copy it from the user's ANDES, as the gallery's Add does.
  const added = await request.post('/api/examples/ieee118/add');
  expect([201, 409]).toContain(added.status());
  const written: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/api/workspace/layout')) {
      written.push(request.url());
    }
  });

  // ---- As it opens ------------------------------------------------------------
  await page.goto('/');
  await openCase(page, 'case118.m');
  const opened = await settled(page);
  expect(await overlapsOnScreen(page)).toEqual([]);
  expect(problems(opened)).toEqual([]);
  expect(branchesIntoDevices(opened)).toEqual([]);
  expect(slantedConnectors(opened.edges)).toEqual(IEEE118_SLANTED);
  // A static case has no machine control, so no badge of any kind.
  await expect(page.locator('.react-flow__node-controller')).toHaveCount(0);
  await expect(page.locator('[data-orphan="true"]')).toHaveCount(0);

  // ---- Tidy ---------------------------------------------------------------------
  await page.getByTestId('sld-tidy').click();
  await expect(page.getByTestId('sld-tidy-note')).toHaveText('Already tidy: nothing was changed', {
    timeout: 120_000,
  });

  // ---- With the values of a power flow ------------------------------------------
  await runPowerFlow(page);
  const shown = await settled(page);
  expect(problems(shown)).toEqual([]);
  expect(await overlapsOnScreen(page)).toEqual([]);
  expect(await labelProblems(page)).toEqual([]);
  // The six generators past a reactive limit that the catalog's entry names, and the buses near
  // a voltage limit it warns of, are what the Violations tab counts.
  await expect(page.getByTestId('bottom-drawer-tab-violations')).toContainText('6');
  // Opening a case, tidying a tidy diagram and running a power flow write nothing beside it.
  expect(written).toEqual([]);

  // ---- Laid out again -----------------------------------------------------------
  await page.getByTestId('sld-arrange-trigger').click();
  await page.getByTestId('sld-arrange-tidy-relayout').click();
  const laidOut = await settled(page);
  expect(problems(laidOut)).toEqual([]);
  expect(branchesIntoDevices(laidOut)).toEqual([]);
  expect(slantedConnectors(laidOut.edges)).toEqual(IEEE118_SLANTED);
  expect(await overlapsOnScreen(page)).toEqual([]);
});

/**
 * The steady-state gallery cases besides IEEE 118: the example id, the file the gallery copies, the device
 * connectors that do not drop square onto their bar as the diagram draws them, and what the Violations tab
 * counts after a power flow, which is what the entry in the catalog names (a power flow does not enforce
 * reactive limits, so the generators past one are in it, with the buses past a voltage limit and the lines
 * past their rating where the file gives a rating).
 */
const STEADY_GALLERY: [string, string, string[], string][] = [
  ['rts24', 'pglib_opf_case24_ieee_rts.m', ['stub-generator-13', 'stub-generator-33'], '5'],
  ['ieee30', 'pglib_opf_case30_ieee.m', ['stub-load-PQ_1'], '5'],
  ['ieee57', 'pglib_opf_case57_ieee.m', [], '5'],
  ['rts_gmlc', 'RTS-GMLC.RAW', ['stub-generator-52', 'stub-generator-84'], '22'],
  ['pegase89', 'case89pegase.m', [], '1'],
  ['activsg200', 'case_ACTIVSg200.m', [], '4'],
  ['ieee300', 'case300.m', ['stub-load-PQ_137', 'stub-shunt-Shunt_9'], '21'],
];

for (const [id, file, slanted, violations] of STEADY_GALLERY) {
  test(`${file}: a steady-state gallery case is drawn with nothing over anything else as it opens, tidied, with values and laid out again`, async ({
    page,
    request,
  }) => {
    test.setTimeout(400_000);
    // Not seeded: add it to the workspace, as the gallery's Add does (a bundled case from the
    // package, the others from the user's ANDES). A workspace another run already added it to
    // answers with a conflict, which is the same.
    const added = await request.post(`/api/examples/${id}/add`);
    expect([201, 409]).toContain(added.status());
    const written: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/api/workspace/layout')) {
        written.push(request.url());
      }
    });

    await page.goto('/');
    await openCase(page, file);
    const opened = await settled(page);
    expect(await overlapsOnScreen(page)).toEqual([]);
    expect(problems(opened)).toEqual([]);
    expect(branchesIntoDevices(opened)).toEqual([]);
    expect(slantedConnectors(opened.edges)).toEqual(slanted);
    // A static case has no machine control, so no badge of any kind.
    await expect(page.locator('.react-flow__node-controller')).toHaveCount(0);
    await expect(page.locator('[data-orphan="true"]')).toHaveCount(0);

    await page.getByTestId('sld-tidy').click();
    await expect(page.getByTestId('sld-tidy-note')).toHaveText(
      'Already tidy: nothing was changed',
      { timeout: 120_000 },
    );

    await runPowerFlow(page);
    const shown = await settled(page);
    expect(problems(shown)).toEqual([]);
    expect(await overlapsOnScreen(page)).toEqual([]);
    expect(await labelProblems(page)).toEqual([]);
    await expect(page.getByTestId('bottom-drawer-tab-violations')).toHaveText(
      new RegExp(`^Violations\\s*${violations}$`),
    );
    // Opening a case, tidying a tidy diagram and running a power flow write nothing beside it.
    expect(written).toEqual([]);

    await page.getByTestId('sld-arrange-trigger').click();
    await page.getByTestId('sld-arrange-tidy-relayout').click();
    const laidOut = await settled(page);
    expect(problems(laidOut)).toEqual([]);
    expect(branchesIntoDevices(laidOut)).toEqual([]);
    expect(slantedConnectors(laidOut.edges)).toEqual(slanted);
    expect(await overlapsOnScreen(page)).toEqual([]);
  });
}

/**
 * The small cases of the gallery: the example id, the file the gallery copies, and what the
 * Violations tab counts after a power flow where the entry in the catalog says (the generators past
 * a reactive limit, since a power flow does not enforce them).
 */
const SMALL_GALLERY: [string, string, string?][] = [
  ['kundur_pss', 'kundur_ieeest.xlsx'],
  ['ieee14_fault', 'ieee14_fault.xlsx'],
  ['pjm5bus', 'pjm5bus.xlsx'],
  ['ieee14_solar', 'ieee14_solar.xlsx', '2'],
  ['ieee14_wt3', 'ieee14_wt3.xlsx', '2'],
];

for (const [id, file, violations] of SMALL_GALLERY) {
  test(`${file}: a small gallery case is drawn with nothing over anything else, as it opens, tidied and with values`, async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    // Not seeded: copy it from the user's ANDES, as the gallery's Add does. A workspace another
    // run already added it to answers with a conflict, which is the same.
    const added = await request.post(`/api/examples/${id}/add`);
    expect([201, 409]).toContain(added.status());
    await page.goto('/');
    await openCase(page, file);
    const opened = await settled(page);
    expect(await overlapsOnScreen(page)).toEqual([]);
    expect(problems(opened)).toEqual([]);
    expect(branchesIntoDevices(opened)).toEqual([]);
    await expect(page.locator('.react-flow__node-controller')).toHaveCount(0);
    await expect(page.locator('[data-orphan="true"]')).toHaveCount(0);

    await page.getByTestId('sld-tidy').click();
    await expect(page.getByTestId('sld-tidy-note')).toHaveText('Already tidy: nothing was changed');

    await runPowerFlow(page);
    const shown = await settled(page);
    expect(problems(shown)).toEqual([]);
    expect(await overlapsOnScreen(page)).toEqual([]);
    expect(await labelProblems(page)).toEqual([]);
    if (violations !== undefined) {
      await expect(page.getByTestId('bottom-drawer-tab-violations')).toContainText(violations);
    }
  });
}

test('npcc.xlsx: a generator put under its bus, behind a load of that bus, stays where it is dropped with its connector stepped round the load, as dropped, tidied and reloaded', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto('/');
  await openCase(page, 'npcc.xlsx');
  await settled(page);
  await openCopy(page, `no-overlap-npcc-behind-${Date.now()}`);
  await settled(page);
  await runPowerFlow(page);
  const opened = await settled(page);
  expect(problems(opened)).toEqual([]);

  // Generator 31 hangs from bus 86 over its bar; the load PQ_44 of the same bus hangs under it.
  // The generator is put beside the east tip of the bar first, then under the bar, in the column
  // of the load and below it: straight up to the bar, its connector would run through the load.
  const bus = opened.nodes['86']!;
  const load = opened.nodes['load-PQ_44']!;
  const unit = opened.nodes['generator-31']!;
  expect(load.y).toBeGreaterThan(bus.y);
  await dragInDiagram(
    page,
    'generator-31',
    bus.x + (bus.barLeft ?? 0) + (bus.barLength ?? bus.width) + 50 - unit.x,
    bus.y + 3 - unit.height / 2 - unit.y,
  );
  expect(problems(await settled(page))).toEqual([]);
  const beside = (await drawing(page)).nodes['generator-31']!;
  const to = {
    x: load.x + load.width / 2 - unit.width / 2 - 2,
    y: load.y + load.height + 28,
  };
  await dragInDiagram(page, 'generator-31', to.x - beside.x, to.y - beside.y);
  const dropped = await settled(page);
  expect(await overlapsOnScreen(page), 'with the generator behind the load').toEqual([]);

  // It stays where it was dropped (to the pointer, which at the zoom this diagram is fitted at
  // is a few units), below the load, and its connector steps round the load: out of the face that
  // looks at the bar, across, and square onto the bar beside the load. That is the one thing
  // `problems` says of it (a connector has one bend or none, but for one that goes round a
  // symbol).
  const placed = dropped.nodes['generator-31']!;
  expect(Math.abs(placed.x - to.x)).toBeLessThan(12);
  expect(Math.abs(placed.y - to.y)).toBeLessThan(12);
  expect(placed.y).toBeGreaterThan(load.y + load.height);
  expect(problems(dropped)).toEqual(['stub-generator-31: more than one bend']);
  const connector = dropped.edges['stub-generator-31']!.points;
  expect(connector).toHaveLength(4);
  const [, , across, landing] = connector as [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ];
  expect(across[1]).toBeGreaterThan(load.y + load.height);
  expect(landing[0]).toBe(across[0]);
  // 6 or more from the box of the load (`SYMBOL_CLEAR`, less the pixel of slack of the reading).
  const off = Math.max(load.x - landing[0], landing[0] - (load.x + load.width));
  expect(off).toBeGreaterThanOrEqual(6 - NEAR);

  await page.getByTestId('sld-tidy').click();
  const tidy = await settled(page);
  expect(problems(tidy)).toEqual(['stub-generator-31: more than one bend']);
  expect(await overlapsOnScreen(page), 'after the tidy').toEqual([]);
  expect(tidy.edges['stub-generator-31']!.points).toEqual(connector);

  // Reloaded, it is drawn as it was left.
  await page.reload();
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 90_000 });
  const again = await settled(page);
  expect(await overlapsOnScreen(page), 'after the reload').toEqual([]);
  for (const [id, node] of Object.entries(tidy.nodes)) {
    expect({ x: again.nodes[id]?.x, y: again.nodes[id]?.y }, id).toEqual({ x: node.x, y: node.y });
  }
  for (const [id, edge] of Object.entries(tidy.edges)) {
    expect(again.edges[id]?.points, id).toEqual(edge.points);
  }
});

test('kundur_full.xlsx: a load pulled down beside bars 12 and 13 stays where it is dropped, and the bars keep their gap', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await openCase(page, 'kundur_full.xlsx');
  await settled(page);
  await openCopy(page, `no-overlap-kundur-bars-${Date.now()}`);
  await settled(page);
  await runPowerFlow(page);
  const opened = await settled(page);
  const [before, west, east] = [opened.nodes['load-PQ_0']!, opened.nodes['3']!, opened.nodes['8']!];
  const gap = (d: typeof opened): number =>
    d.nodes['8']!.x +
    (d.nodes['8']!.barLeft ?? 0) -
    (d.nodes['3']!.x + (d.nodes['3']!.barLeft ?? 0) + (d.nodes['3']!.barLength ?? 0));
  expect(gap(opened)).toBeGreaterThan(20);
  expect([west.y, east.y]).toEqual([560, 560]);

  // Down to the row of the two buses and 24 west of where it hangs: the bar of
  // bus 12 is drawn out to the tap of its connector, nearly to bar 13.
  await dropInDiagram(page, 'load-PQ_0', -24, 148);
  const moved = await settled(page);
  expect(problems(moved)).toEqual([]);
  expect(await overlapsOnScreen(page)).toEqual([]);
  // Where it was dropped, to a pixel of the pointer: not in the nearest free place.
  const load = moved.nodes['load-PQ_0']!;
  expect(Math.abs(load.x - (before.x - 24))).toBeLessThan(1);
  expect(Math.abs(load.y - (before.y + 148))).toBeLessThan(1);
  await expect(page.getByText('Moved to the nearest free place')).toHaveCount(0);
  expect(gap(moved)).toBeLessThan(gap(opened));
  expect(gap(moved)).toBeGreaterThanOrEqual(12 - NEAR);
});

test('ieee14_full.xlsx: a load dragged straight up past a generator keeps its connector off the block, and after a reload', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await openCase(page, 'ieee14_full.xlsx');
  await settled(page);
  await openCopy(page, `no-overlap-ieee14-connector-${Date.now()}`);
  await settled(page);
  await runPowerFlow(page);
  await settled(page);

  await dropInDiagram(page, 'load-PQ_1', 0, -150);
  const moved = await settled(page);
  expect(problems(moved)).toEqual([]);
  expect(await overlapsOnScreen(page), 'with the load above the generator').toEqual([]);
  // Whichever run of its connector is level with the block of generator 1, it
  // is 6 or more from its edge (the rule of the checker, less the pixel of
  // slack the screen reading is given).
  const block = moved.nodes['generator-1']!;
  const points = moved.edges['stub-load-PQ_1']!.points;
  for (let i = 1; i < points.length; i += 1) {
    const [[x1, y1], [x2, y2]] = [points[i - 1]!, points[i]!];
    if (Math.max(y1, y2) <= block.y || Math.min(y1, y2) >= block.y + block.height) continue;
    const off = Math.max(block.x - Math.max(x1, x2), Math.min(x1, x2) - (block.x + block.width), 0);
    expect(off, `run ${i} of the connector`).toBeGreaterThanOrEqual(6 - NEAR);
  }

  await page.reload();
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 90_000 });
  const again = await settled(page);
  expect(problems(again)).toEqual([]);
  expect(await overlapsOnScreen(page), 'after the reload').toEqual([]);
  expect(again.edges['stub-load-PQ_1']!.points).toEqual(moved.edges['stub-load-PQ_1']!.points);
});
