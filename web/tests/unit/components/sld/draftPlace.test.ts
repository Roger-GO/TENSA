/**
 * Where a draft comes to stand (`draftPlace.ts`): where it is dropped, or
 * the nearest place to that where it is on nothing; where it goes when
 * something comes to stand on it; and where it goes when it is given a bus
 * in its form that its connector has no good way to from where it stands.
 *
 * The example cases are held to the no-overlap rule with drafts on them,
 * whole, in `noOverlapDrafts*.test.ts`; here each answer is looked at on
 * its own.
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `layout.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import {
  TAP_SPACING,
  layoutConnections,
  type ConnectionEdge,
  type ConnectionNode,
} from '@/components/sld/connections';
import {
  CONNECTOR_REACH,
  DRAFT_REACH,
  connectedPlace,
  draftDrop,
  draftPlace,
  settledPlaces,
} from '@/components/sld/draftPlace';
import { DROP_CLEARANCE, DROP_REACH } from '@/components/sld/dropPlace';
import { DRAFT_NODE_SIZE, DRAFT_NODE_TYPE } from '@/components/sld/drafts';
import { symbolBoxes } from '@/components/sld/labels';
import { connectorDrawn } from '@/components/sld/picture';
import { GRID_STEP } from '@/components/sld/tidy';
import { IEEE14 } from '../../helpers/exampleCases';
import { drawn, opened, overlapsOf, settled, type Diagram } from '../../helpers/diagramStates';
import { withDrafts } from '../../helpers/draftSweeps';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

const { width: W, height: H } = DRAFT_NODE_SIZE;

function bus(id: string, x: number, y: number): ConnectionNode {
  return { id, type: 'bus', position: { x, y } };
}

function device(id: string, x: number, y: number): ConnectionNode {
  return { id, type: 'load', position: { x, y }, initialWidth: 40, initialHeight: 40 };
}

function draftNode(id: string, x: number, y: number): ConnectionNode {
  return {
    id,
    type: DRAFT_NODE_TYPE,
    position: { x, y },
    initialWidth: W,
    initialHeight: H,
  };
}

function stub(deviceId: string, busId: string): ConnectionEdge {
  return { id: `stub-${deviceId}`, type: 'stub', source: deviceId, target: busId };
}

describe('where a draft that is dropped comes to stand', () => {
  const nodes = [bus('1', 0, 100), device('load-A', 26, 30)];
  const edges = [stub('load-A', '1')];
  const connections = layoutConnections(nodes, edges);

  it('is with the middle of its box where the pointer was let go, on free ground', () => {
    const place = draftPlace(nodes, edges, { x: 400, y: 300 }, connections);
    expect(place).toEqual({ position: { x: 400 - W / 2, y: 300 - H / 2 }, shift: null });
  });

  it('is the nearest place where it is on nothing, when it is dropped on a bar or a symbol', () => {
    const onBar = draftPlace(nodes, edges, { x: 46, y: 103 }, connections);
    expect(onBar.shift).toMatchObject({ onto: 'symbol-bar' });
    // Clear of the bar, above it or under it.
    const { y } = onBar.position;
    expect(y + H <= 100 || y >= 106).toBe(true);
    const onSymbol = draftPlace(nodes, edges, { x: 46, y: 50 }, connections);
    expect(onSymbol.shift).not.toBeNull();
    const at = onSymbol.position;
    const apart = at.x >= 66 || at.x + W <= 26 || at.y >= 70 || at.y + H <= 30;
    expect(apart).toBe(true);
  });

  it('is on the grid the nodes snap to, while they do', () => {
    const place = draftPlace(nodes, edges, { x: 405, y: 297 }, connections, { step: GRID_STEP });
    expect(place.position.x % GRID_STEP).toBe(0);
    expect(place.position.y % GRID_STEP).toBe(0);
    expect(place.shift).toBeNull();
  });

  it('is not where the picture of the diagram would have something on something', async () => {
    const first = settled(await opened(IEEE14));
    const { connections: drawnAs } = drawn(first);
    // The middle of the diagram, where the lines run close together.
    const centre = { x: 250, y: 500 };
    const place = draftPlace(first.nodes, first.edges as ConnectionEdge[], centre, drawnAs, {
      atRest: drawnAs,
      picture: { barLengths: first.barLengths, values: false },
    });
    const there = settled(
      withDrafts(first, [{ id: 'draft-1', kind: 'PV', position: place.position, values: {} }]),
    );
    expect(overlapsOf(there)).toEqual([]);
  });
});

describe('a draft that is dropped on a line', () => {
  it('stands beside the line, and no line is routed again for it', async () => {
    const first = settled(await opened(IEEE14));
    const { connections: drawnAs } = drawn(first);
    // The middle of the longest upright run of a line of the case.
    let run: { x: number; from: number; to: number } | null = null;
    for (const edge of first.edges) {
      const points = (edge.data?.bendPoints as [number, number][] | undefined) ?? [];
      if (edge.type === 'stub') continue;
      for (let i = 1; i < points.length; i += 1) {
        const [a, b] = [points[i - 1]!, points[i]!];
        const long = Math.abs(a[1] - b[1]);
        if (
          Math.abs(a[0] - b[0]) < 0.5 &&
          long > (run === null ? 80 : Math.abs(run.to - run.from))
        ) {
          run = { x: a[0], from: a[1], to: b[1] };
        }
      }
    }
    expect(run).not.toBeNull();
    const centre = { x: run!.x, y: (run!.from + run!.to) / 2 };
    const place = draftPlace(first.nodes, first.edges as ConnectionEdge[], centre, drawnAs, {
      atRest: drawnAs,
      picture: { barLengths: first.barLengths, values: false },
    });
    // Moved off the line it was dropped on.
    expect(place.shift).not.toBeNull();
    expect(place.position.x >= run!.x || place.position.x + W <= run!.x).toBe(true);
    const there = withDrafts(first, [
      { id: 'draft-1', kind: 'PV', position: place.position, values: {} },
    ]);
    // Every route the diagram kept still holds with the draft there.
    expect(drawn(there).changed.size).toBe(0);
    expect(overlapsOf(there)).toEqual([]);
  });

  it('stands on free ground in the middle of a diagram, where the lines run close together', async () => {
    const first = settled(await opened(IEEE14));
    const picture = drawn(first);
    const five = first.nodes.find((n) => n.id === '5')!.position;
    // Over the bar of bus 5, where the lines from buses 1, 2 and 4 come
    // down to it side by side: no room for a draft between two of them.
    for (const centre of [
      { x: five.x + 54, y: five.y - 80 },
      { x: five.x + 74, y: five.y - 60 },
    ]) {
      for (const step of [undefined, GRID_STEP]) {
        const place = draftPlace(
          first.nodes,
          first.edges as ConnectionEdge[],
          centre,
          picture.connections,
          {
            atRest: picture.connections,
            step,
            picture: { barLengths: first.barLengths, values: false },
            symbols: [...symbolBoxes(picture.symbols).values()],
          },
        );
        expect(place.shift).toMatchObject({ onto: 'line' });
        const { x, y } = place.position;
        // Off every line of the diagram, by the room a symbol keeps.
        for (const edge of first.edges) {
          if (edge.type === 'stub') continue;
          const points = picture.connections.routes.get(edge.id)!.points;
          for (let i = 1; i < points.length; i += 1) {
            const [a, b] = [points[i - 1]!, points[i]!];
            const off =
              x >= Math.max(a[0], b[0]) + DROP_CLEARANCE ||
              x + W <= Math.min(a[0], b[0]) - DROP_CLEARANCE ||
              y >= Math.max(a[1], b[1]) + DROP_CLEARANCE ||
              y + H <= Math.min(a[1], b[1]) - DROP_CLEARANCE;
            expect(off).toBe(true);
          }
        }
        const there = withDrafts(first, [
          { id: 'draft-1', kind: 'PQ', position: place.position, values: {} },
        ]);
        // No line gives way to it, and nothing is drawn over anything.
        expect(drawn(there).changed.size).toBe(0);
        expect(overlapsOf(there)).toEqual([]);
      }
    }
  });

  it('is looked for free ground farther away than a device that is dragged is', () => {
    // Lines side by side over more ground than a drop looks across, too
    // close together for a draft to stand between two of them.
    const nodes = [bus('a', -3000, -3000), bus('b', 3000, 3000)];
    const edges: ConnectionEdge[] = [];
    const routes = new Map<string, { points: [number, number][] }>();
    for (let at = 0; at <= 720; at += 60) {
      edges.push({ id: `line-${at}`, source: 'a', target: 'b' });
      routes.set(`line-${at}`, {
        points: [
          [at, -500],
          [at, 500],
        ],
      });
    }
    const drawnAs = { bars: new Map(), routes } as unknown as Parameters<typeof draftPlace>[3];
    const place = draftPlace(nodes, edges, { x: 360, y: 0 }, drawnAs);
    expect(place.shift).toMatchObject({ onto: 'line' });
    const far = Math.hypot(place.shift!.dx, place.shift!.dy);
    expect(far).toBeGreaterThan(DROP_REACH);
    expect(far).toBeLessThanOrEqual(Math.SQRT2 * DRAFT_REACH);
    // Beside the lines, to the left of the first or the right of the last.
    const { x } = place.position;
    expect(x + W <= -DROP_CLEARANCE || x >= 720 + DROP_CLEARANCE).toBe(true);
  });
});

describe('a draft that is dragged and let go', () => {
  /** IEEE 14 with a load draft beside it, and the same with the draft dragged to `to`. */
  async function draggedTo(to: (first: Diagram) => { x: number; y: number }) {
    const first = settled(await opened(IEEE14));
    const xs = first.nodes.map((n) => n.position.x);
    const stood = { x: Math.min(...xs) - 300, y: 200 };
    const draft = { id: 'draft-1', kind: 'PQ', values: {} };
    const before = withDrafts(first, [{ ...draft, position: stood }]);
    const at = to(first);
    const there = withDrafts(first, [{ ...draft, position: at }]);
    const drop = (pictures?: number) =>
      draftDrop(
        there.nodes,
        there.edges as ConnectionEdge[],
        new Set(['draft-1']),
        drawn(there, { values: false, dragging: true }).connections,
        {
          atRest: drawn(before).connections,
          picture: { barLengths: first.barLengths, values: false },
          before: before.nodes,
          back: { dx: stood.x - at.x, dy: stood.y - at.y },
          pictures,
        },
      );
    return { first, there, at, drop };
  }

  const onLines = (first: Diagram) => {
    const three = first.nodes.find((n) => n.id === '3')!.position;
    return { x: three.x - 128, y: three.y - 90 };
  };

  it('stays where it was let go, on free ground', async () => {
    const { there, drop } = await draggedTo((first) => {
      const ys = first.nodes.map((n) => n.position.y);
      return { x: Math.min(...first.nodes.map((n) => n.position.x)) - 200, y: Math.max(...ys) };
    });
    expect(drop()).toBeNull();
    expect(drawn(there).changed.size).toBe(0);
  });

  it('stands beside the lines it was let go on, where free ground is a little way off', async () => {
    // On the lines that run down from buses 1 and 2 to bus 5, left of bus 3.
    const { first, there, at, drop } = await draggedTo(onLines);
    // Let go there, lines would have to go round it.
    expect(drawn(there).changed.size).toBeGreaterThan(0);
    const shift = drop()!;
    expect(shift).toMatchObject({ onto: 'line' });
    expect(shift.back).toBeUndefined();
    const moved = withDrafts(first, [
      {
        id: 'draft-1',
        kind: 'PQ',
        position: { x: at.x + shift.dx, y: at.y + shift.dy },
        values: {},
      },
    ]);
    expect(drawn(moved).changed.size).toBe(0);
    expect(overlapsOf(moved)).toEqual([]);
  });

  it('is dropped as a device is, the lines round it, where no such place is asked about', async () => {
    const { there, drop } = await draggedTo(onLines);
    // One place only: the one it was let go in, which the diagram can be drawn with.
    expect(drop(1)).toBeNull();
    expect(overlapsOf(there)).toEqual([]);
  });
});

describe('where a draft goes when something comes to stand on it', () => {
  const edges = [stub('load-A', '1')];

  it('stays where it is while it is on nothing', () => {
    const nodes = [bus('1', 0, 100), device('load-A', 26, 30), draftNode('draft-1', 300, 200)];
    const moves = settledPlaces(nodes, edges, ['draft-1'], layoutConnections(nodes, edges));
    expect(moves.size).toBe(0);
  });

  it('is the nearest place where it is on nothing', () => {
    // The bar of bus 1 runs through the draft.
    const nodes = [bus('1', 0, 100), device('load-A', 26, 30), draftNode('draft-1', 10, 80)];
    const moves = settledPlaces(nodes, edges, ['draft-1'], layoutConnections(nodes, edges));
    const to = moves.get('draft-1')!;
    expect(to).toBeDefined();
    expect(to.y + H <= 100 || to.y >= 106 || to.x >= 92 || to.x + W <= 0).toBe(true);
  });

  it('settles one draft after the other, each clear of where the one before went', () => {
    const nodes = [
      bus('1', 0, 100),
      draftNode('draft-1', 300, 200),
      draftNode('draft-2', 310, 210),
    ];
    const moves = settledPlaces(nodes, [], ['draft-1', 'draft-2'], layoutConnections(nodes, []));
    const at = (id: string) => moves.get(id) ?? nodes.find((n) => n.id === id)!.position;
    const [a, b] = [at('draft-1'), at('draft-2')];
    expect(Math.abs(a.x - b.x) >= W || Math.abs(a.y - b.y) >= H).toBe(true);
  });

  it('leaves a draft beside its own bar, and across another bar from it, where it stands', () => {
    // Just over the bar it is connected to, nearer than it may be to a bar
    // that is not its own; and bus 3 stands between another and its bus.
    const near = [bus('1', 0, 100), draftNode('draft-1', 0, 100 - H - 10)];
    const wired = [stub('draft-1', '1')];
    expect(settledPlaces(near, wired, ['draft-1'], layoutConnections(near, wired)).size).toBe(0);
    expect(settledPlaces(near, [], ['draft-1'], layoutConnections(near, [])).size).toBe(1);
    const across = [bus('1', 0, 300), bus('3', 0, 150), draftNode('draft-1', 0, 0)];
    expect(settledPlaces(across, wired, ['draft-1'], layoutConnections(across, wired)).size).toBe(
      0,
    );
  });
});

describe('where a draft goes when it is given a bus in its form', () => {
  /** IEEE 14 with a load draft at `position`, connected to `busId`. */
  function given(first: Diagram, position: { x: number; y: number }, busId: string) {
    const there = withDrafts(first, [
      { id: 'draft-1', kind: 'PQ', position, values: { bus: busId } },
    ]);
    const { connections, symbols } = drawn(there);
    const ask = (justGiven: boolean) =>
      connectedPlace(there.nodes, there.edges as ConnectionEdge[], 'draft-1', connections, {
        atRest: connections,
        picture: { barLengths: first.barLengths, values: false },
        given: justGiven,
        symbols: [...symbolBoxes(symbols).values()],
      });
    return { there, ask };
  }
  const busAt = (diagram: Diagram, id: string) => diagram.nodes.find((n) => n.id === id)!.position;
  /** IEEE 14 with the load draft at `position`, connected to `busId`. */
  const wired = (first: Diagram, position: { x: number; y: number }, busId: string) =>
    withDrafts(first, [{ id: 'draft-1', kind: 'PQ', position, values: { bus: busId } }]);
  /** By how much the line of `diagram` that is drawn the longest way round is longer than in `first`. */
  function farthestRound(first: Diagram, diagram: Diagram): number {
    const [was, is] = [drawn(first), drawn(diagram)].map((picture) => picture.connections.routes);
    const long = (points: readonly (readonly [number, number])[]) =>
      points.reduce(
        (sum, p, i) =>
          i === 0 ? 0 : sum + Math.hypot(p[0] - points[i - 1]![0], p[1] - points[i - 1]![1]),
        0,
      );
    return Math.max(
      0,
      ...first.edges
        .filter((edge) => edge.type !== 'stub')
        .map((edge) => long(is!.get(edge.id)!.points) - long(was!.get(edge.id)!.points)),
    );
  }

  it('stays where it was dropped when its connector runs clear from there, and crosses nothing', async () => {
    const first = settled(await opened(IEEE14));
    // Left of bus 12, the leftmost bar of its row, level with it.
    const twelve = busAt(first, '12');
    const { there, ask } = given(first, { x: twelve.x - 180, y: twelve.y - H / 2 }, '12');
    expect(ask(true)).toBeNull();
    expect(overlapsOf(settled(there))).toEqual([]);
  });

  it('goes beside its bus when its connector would cross other lines to it, or be long', async () => {
    const first = settled(await opened(IEEE14));
    const xs = first.nodes.map((n) => n.position.x);
    const far = { x: Math.min(...xs) - 250, y: busAt(first, '8').y };
    // Bus 8 stands on the far side of the diagram.
    const { ask } = given(first, far, '8');
    const place = ask(true)!;
    expect(place).not.toBeNull();
    expect(place.beside).toBe(true);
    const eight = busAt(first, '8');
    const middle = { x: place.position.x + W / 2, y: place.position.y + H / 2 };
    expect(Math.hypot(middle.x - (eight.x + 46), middle.y - eight.y)).toBeLessThan(CONNECTOR_REACH);
    // There its connector runs straight to the bar, over nothing.
    const moved = settled(
      withDrafts(first, [
        { id: 'draft-1', kind: 'PQ', position: place.position, values: { bus: '8' } },
      ]),
    );
    expect(overlapsOf(moved)).toEqual([]);
    const connector = drawn(moved).connections.routes.get('stub-draft-1')!.points;
    expect(connector).toHaveLength(2);
    expect(connector[0]![0]).toBeCloseTo(connector[1]![0], 1);
  });

  it('is left where it stands, crossing lines or not, when it was not just given the bus', async () => {
    const first = settled(await opened(IEEE14));
    const xs = first.nodes.map((n) => n.position.x);
    const far = { x: Math.min(...xs) - 250, y: busAt(first, '8').y + 90 };
    const { there, ask } = given(first, far, '8');
    // It reaches bus 8 over nothing, though across the diagram: a draft
    // that was dragged there, or came with the case, is the user's to move.
    expect(overlapsOf(settled(there))).toEqual([]);
    expect(ask(false)).toBeNull();
    expect(ask(true)).not.toBeNull();
  });

  it('is held off the lines as they run without it, not as they run round its connector', async () => {
    const first = settled(await opened(IEEE14));
    const xs = first.nodes.map((n) => n.position.x);
    // Far to the right of the diagram, and bus 12 at its left edge: the
    // connector reaches across, and the lines on its way are routed round it.
    const far = { x: Math.max(...xs) + 250, y: busAt(first, '2').y - 80 };
    const { there, ask } = given(first, far, '12');
    expect(drawn(there).changed.size).toBeGreaterThan(0);
    const place = ask(true)!;
    expect(place).not.toBeNull();
    expect(place.beside).toBe(true);
    // Beside bus 12, with every line of the system where it ran.
    const moved = wired(first, place.position, '12');
    const twelve = busAt(first, '12');
    expect(Math.abs(place.position.x + W / 2 - (twelve.x + 46))).toBeLessThan(CONNECTOR_REACH);
    expect(farthestRound(first, moved)).toBeLessThanOrEqual(2 * TAP_SPACING);
    expect(overlapsOf(moved)).toEqual([]);
  });

  it('sends no line a long way round where the lines of its bus leave no room in its rows', async () => {
    const first = settled(await opened(IEEE14));
    const xs = first.nodes.map((n) => n.position.x);
    // Bus 5: lines come down to its bar side by side, and a load hangs under it.
    const far = { x: Math.min(...xs) - 250, y: busAt(first, '5').y - 100 };
    const { ask } = given(first, far, '5');
    const place = ask(true)!;
    expect(place).not.toBeNull();
    expect(place.beside).toBe(true);
    const moved = wired(first, place.position, '5');
    expect(overlapsOf(moved)).toEqual([]);
    // In the row of its bus, at the place where the lines step aside the
    // least: none of them goes round the buses beside it.
    expect(farthestRound(first, moved)).toBeLessThan(W + H);
    const connector = drawn(moved).connections.routes.get('stub-draft-1')!.points;
    expect(connector).toHaveLength(2);
    expect(connector[0]![0]).toBeCloseTo(connector[1]![0], 1);
  });

  it('goes to free ground beside its bus, its connector at an angle, before a line is made to go round it', async () => {
    const first = settled(await opened(IEEE14));
    const xs = first.nodes.map((n) => n.position.x);
    // Bus 13: its rows are taken by its lines and its load.
    const far = { x: Math.min(...xs) - 250, y: busAt(first, '4').y };
    const { ask } = given(first, far, '13');
    const place = ask(true)!;
    expect(place).toMatchObject({ beside: true, square: false });
    const moved = wired(first, place.position, '13');
    const picture = drawn(moved);
    // No line is routed again for it, and nothing is drawn over anything.
    expect(picture.changed.size).toBe(0);
    expect(overlapsOf(moved)).toEqual([]);
    // Its connector reaches the bar within reach, and crosses no line.
    const as = connectorDrawn(
      moved.nodes,
      moved.edges as ConnectionEdge[],
      { barLengths: first.barLengths, values: false },
      'draft-1',
      'stub-draft-1',
    );
    expect(as).toMatchObject({ over: false, crossings: 0 });
    expect(as.length).toBeLessThanOrEqual(CONNECTOR_REACH);
  });

  it('is not held against a line that goes round another draft', async () => {
    const first = settled(await opened(IEEE14));
    // Another draft stands on the lines that come down to bus 5.
    const five = busAt(first, '5');
    const other = {
      id: 'draft-2',
      kind: 'PV',
      position: { x: five.x + 6, y: five.y - 112 },
      values: {},
    };
    const twelve = busAt(first, '12');
    const at = { x: twelve.x - 180, y: twelve.y - H / 2 };
    const there = withDrafts(first, [
      other,
      { id: 'draft-1', kind: 'PQ', position: at, values: { bus: '12' } },
    ]);
    const picture = drawn(there);
    // Lines go round the other draft in every picture of this diagram.
    expect(picture.changed.size).toBeGreaterThan(0);
    const place = connectedPlace(
      there.nodes,
      there.edges as ConnectionEdge[],
      'draft-1',
      picture.connections,
      {
        atRest: picture.connections,
        picture: { barLengths: first.barLengths, values: false },
        given: true,
        symbols: [...symbolBoxes(picture.symbols).values()],
      },
    );
    // Left of bus 12 and level with it, its connector runs clear: it stays,
    // as it does with no other draft on the diagram.
    expect(place).toBeNull();
  });

  it('goes into the row of its bus when its connector would have to step round a symbol', () => {
    // Load A stands over the bar of bus 1, and the draft over load A: its
    // connector has no straight way down.
    const nodes = [
      { ...bus('1', 0, 100), data: {} },
      { ...device('load-A', 26, 30), data: {} },
      { ...draftNode('draft-1', -2, -60), data: {} },
    ];
    const edges = [stub('load-A', '1'), stub('draft-1', '1')];
    const connections = layoutConnections(nodes, edges);
    const ask = (given: boolean) =>
      connectedPlace(nodes, edges, 'draft-1', connections, {
        atRest: connections,
        picture: { values: false },
        given,
      });
    const drawnAs = connections.routes.get('stub-draft-1')!.points;
    expect(drawnAs.length).toBeGreaterThan(2);
    // On nothing, so it stays where it was dragged to or came with the case.
    expect(ask(false)).toBeNull();
    const place = ask(true)!;
    expect(place.beside).toBe(true);
    // Beside load A, where its connector drops square onto the bar.
    const there = nodes.map((n) => (n.id === 'draft-1' ? { ...n, position: place.position } : n));
    const connector = layoutConnections(there, edges).routes.get('stub-draft-1')!.points;
    expect(connector).toHaveLength(2);
    expect(connector[0]![0]).toBeCloseTo(connector[1]![0], 1);
  });

  it('goes into the row of its bus when its connector would run to the bar as a diagonal', () => {
    // Up and to the right of the bar of bus 1: the connector runs to its tip.
    const nodes = [
      { ...bus('1', 0, 100), data: {} },
      { ...draftNode('draft-1', 180, -20), data: {} },
    ];
    const edges = [stub('draft-1', '1')];
    const connections = layoutConnections(nodes, edges);
    const ask = (given: boolean, at = nodes) =>
      connectedPlace(at, edges, 'draft-1', layoutConnections(at, edges), {
        atRest: connections,
        picture: { values: false },
        given,
      });
    expect(ask(false)).toBeNull();
    const place = ask(true)!;
    expect(place.beside).toBe(true);
    const there = nodes.map((n) => (n.id === 'draft-1' ? { ...n, position: place.position } : n));
    const connector = layoutConnections(there, edges).routes.get('stub-draft-1')!.points;
    expect(connector).toHaveLength(2);
    expect(connector[0]![0]).toBeCloseTo(connector[1]![0], 1);
    // Beside the bar and level with it, a few pixels off by hand: left there.
    const level = nodes.map((n) =>
      n.id === 'draft-1' ? { ...n, position: { x: 180, y: 103 - H / 2 + 3 } } : n,
    );
    expect(ask(true, level)).toBeNull();
  });

  it('has nothing to say of a draft that is connected to no bus', async () => {
    const first = settled(await opened(IEEE14));
    const there = withDrafts(first, [
      { id: 'draft-1', kind: 'PQ', position: { x: -300, y: 0 }, values: {} },
    ]);
    const { connections } = drawn(there);
    expect(
      connectedPlace(there.nodes, there.edges as ConnectionEdge[], 'draft-1', connections, {
        picture: { barLengths: first.barLengths, values: false },
        given: true,
      }),
    ).toBeNull();
  });
});
