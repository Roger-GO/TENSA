/**
 * The diagram as it is drawn (`picture.ts`): what `pictureOf` works out from
 * the nodes and the edges, and what `drawnDiagram` hands the overlap checker
 * of it. The whole example cases are held to the checker in
 * `noOverlap.test.ts`; this is about what a picture holds, on a diagram
 * small enough to read.
 */
import { describe, expect, it } from 'vitest';
import type { TopologyEntry, TopologySummary } from '@/api/types';
import type { ConnectionEdge } from '@/components/sld/connections';
import { buildGraph, defaultBarLengths, type BuildGraphOptions } from '@/components/sld/graph';
import { LINE_LABEL_BOX, TRANSFORMER_LABEL_BOX, overlaps } from '@/components/sld/labels';
import { findOverlaps } from '@/components/sld/overlapCheck';
import { drawnDiagram, drawsClear, pictureOf, type PictureOptions } from '@/components/sld/picture';

function entry(idx: string | number, kind: string, params: TopologyEntry['params']): TopologyEntry {
  return { idx, name: `${kind} ${idx}`, kind, params };
}

/**
 * Four buses, two to a row: lines from bus 1 to bus 2 and to bus 3, a
 * transformer from bus 2 to bus 4, a machine with an exciter and a governor
 * on bus 1 and a load on bus 4.
 */
function square(): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [1, 2, 3, 4].map((i) => entry(i, 'Bus', {})),
    lines: [entry('L12', 'Line', { bus1: 1, bus2: 2 }), entry('L13', 'Line', { bus1: 1, bus2: 3 })],
    transformers: [entry('T24', 'Line', { bus1: 2, bus2: 4 })],
    generators: [entry('G1', 'GENROU', { bus: 1 })],
    loads: [entry('PQ_1', 'PQ', { bus: 4 })],
    shunts: [],
    controllers: [entry('E1', 'EXST1', { syn: 'G1' }), entry('T1', 'TGOV1', { syn: 'G1' })],
  };
}

const COORDS = {
  '1': { x: 0, y: 160 },
  '2': { x: 320, y: 160 },
  '3': { x: 0, y: 384 },
  '4': { x: 320, y: 384 },
};

/** `square()` with its buses at `COORDS` and nothing else placed or routed. */
function diagram(options: Pick<BuildGraphOptions, 'unitStates'> = {}) {
  const topology = square();
  const barLengths = defaultBarLengths(topology);
  const { nodes, edges } = buildGraph(topology, COORDS, { barLengths, ...options });
  const draw = (extra: Partial<PictureOptions> = {}) =>
    pictureOf(nodes, edges as ConnectionEdge[], { barLengths, values: false, ...extra });
  return { nodes, edges, draw };
}

describe('pictureOf', () => {
  it('gives every branch a route, every bus its bar and its label, and each transformer the place of its symbol', () => {
    const { nodes, draw } = diagram();
    const picture = draw();
    expect(picture.unrouted).toEqual([]);
    for (const id of ['line-L12', 'line-L13', 'transformer-T24']) {
      const points = picture.connections.routes.get(id)!.points;
      expect(points.length, id).toBeGreaterThanOrEqual(2);
      // The edges carry the route they are drawn along, for the positions it is for.
      const edge = picture.edges.find((e) => e.id === id)!;
      expect(edge.data?.bendPoints, id).toEqual(points);
      // Nothing was stored for it, so it is among the routes that were made.
      expect(picture.changed.get(id)?.points, id).toEqual(points);
    }
    expect(picture.changed.get('line-L13')?.anchors).toEqual({
      source: COORDS['1'],
      target: COORDS['3'],
    });
    expect([...picture.connections.bars.keys()].sort()).toEqual(['1', '2', '3', '4']);
    expect([...picture.busLabels.keys()].sort()).toEqual(['1', '2', '3', '4']);
    expect([...picture.labelPlaces.keys()]).toEqual(['transformer-T24']);
    // Nothing shows a value yet: no readout is placed, and no chain is drawn out.
    expect(picture.readouts.size).toBe(0);
    expect(picture.chains.size).toBe(0);
    expect(findOverlaps(drawnDiagram(nodes, picture, { values: false }))).toEqual([]);
  });

  it('places the readouts and the flow labels once values show, clear of everything', () => {
    const { nodes, draw } = diagram();
    const picture = draw({ values: true });
    expect([...picture.readouts.keys()].sort()).toEqual(['generator-G1', 'load-PQ_1']);
    expect([...picture.labelPlaces.keys()].sort()).toEqual([
      'line-L12',
      'line-L13',
      'transformer-T24',
    ]);
    // The label of a bus is taller with a voltage and an angle in it.
    const plain = draw().busLabels.get('3')!.box;
    const withValues = picture.busLabels.get('3')!.box;
    expect(withValues.bottom - withValues.top).toBeGreaterThan(plain.bottom - plain.top);
    expect(findOverlaps(drawnDiagram(nodes, picture, { values: true }))).toEqual([]);
  });

  it('routes the same whether or not values show: showing them moves no line', () => {
    const { draw } = diagram();
    const routesOf = (values: boolean) =>
      [...draw({ values }).connections.routes].map(([id, route]) => [id, route.points]);
    expect(routesOf(true)).toEqual(routesOf(false));
  });

  it('keeps the routes it is handed, and makes none again', () => {
    const { nodes, draw } = diagram();
    const first = draw();
    const again = pictureOf(nodes, first.edges, {
      barLengths: defaultBarLengths(square()),
      values: false,
    });
    expect(again.changed.size).toBe(0);
    expect([...again.connections.routes]).toEqual([...first.connections.routes]);
  });

  it('stands a chain that is drawn out beside its unit, and routes round it', () => {
    const { nodes, draw } = diagram({
      unitStates: new Map([['G1', { expanded: true, bus: null }]]),
    });
    const picture = draw();
    const chain = picture.chains.get('generator-G1');
    expect(chain).toBeDefined();
    // On the side away from the bar, where nothing is in its way.
    const unit = nodes.find((n) => n.id === 'generator-G1')!;
    expect(chain!.side).toBe(unit.position.y < COORDS['1'].y ? 'above' : 'below');
    // No line runs through it, and no bar or symbol stands in it.
    const drawn = drawnDiagram(nodes, picture, { values: false });
    expect(drawn.boxes.find((b) => b.id === 'chain:generator-G1')).toMatchObject({
      kind: 'block',
      box: chain!.box,
      of: ['generator-G1'],
    });
    expect(findOverlaps(drawn)).toEqual([]);
  });

  it('draws nothing over anything while a node is dragged either, with less looked at', () => {
    // In a drag the routes are made within a smaller budget and the labels
    // are placed once (`dragging`): what is drawn is held to the same rule.
    const { nodes, edges } = diagram();
    const barLengths = defaultBarLengths(square());
    const moved = nodes.map((n) =>
      n.id === '2' ? { ...n, position: { x: n.position.x + 48, y: n.position.y + 64 } } : n,
    );
    const picture = pictureOf(moved, edges as ConnectionEdge[], {
      barLengths,
      values: true,
      dragging: true,
    });
    expect(picture.unrouted).toEqual([]);
    // The lines of the bus that moved are routed to where it is now.
    expect([...picture.changed.keys()].sort()).toContain('line-L12');
    expect(findOverlaps(drawnDiagram(moved, picture, { values: true }))).toEqual([]);
  });

  it('measures a device by the size React Flow reports for it', () => {
    const { nodes, draw } = diagram();
    const sizes = new Map([['load-PQ_1', { width: 120, height: 60 }]]);
    const hinted = drawnDiagram(nodes, draw(), { values: false });
    const measured = drawnDiagram(nodes, draw({ sizes }), { values: false, sizes });
    const boxOf = (drawn: typeof hinted) => drawn.boxes.find((b) => b.id === 'load-PQ_1')!.box;
    expect(boxOf(measured).right - boxOf(measured).left).toBe(120);
    expect(boxOf(measured).bottom - boxOf(measured).top).toBe(60);
    expect(boxOf(hinted).right - boxOf(hinted).left).not.toBe(120);
  });
});

describe('drawnDiagram', () => {
  it('lists every connector as a line, every bar, and every box that is drawn', () => {
    const { nodes, edges, draw } = diagram();
    const picture = draw();
    const drawn = drawnDiagram(nodes, picture, { values: false });
    expect(drawn.lines.map((line) => line.id).sort()).toEqual(edges.map((e) => e.id).sort());
    const line = drawn.lines.find((l) => l.id === 'line-L13')!;
    expect(line).toMatchObject({ from: '1', to: '3' });
    expect(line.points).toBe(picture.connections.routes.get('line-L13')!.points);
    // A bar is the middle line of its bus, as long as it is drawn.
    const bar = picture.connections.bars.get('1')!;
    expect(drawn.bars.find((b) => b.id === '1')).toEqual({
      id: '1',
      left: COORDS['1'].x + bar.start,
      right: COORDS['1'].x + bar.end,
      y: COORDS['1'].y + 3,
    });
    expect(drawn.boxes.map((b) => `${b.kind} ${b.id}`).sort()).toEqual(
      [
        'label label:1',
        'label label:2',
        'label label:3',
        'label label:4',
        'symbol generator-G1',
        'symbol load-PQ_1',
        'symbol marker:generator-G1',
        'symbol symbol:transformer-T24',
      ].sort(),
    );
    // The mark a generator at a reactive limit carries on its top right
    // corner hangs out of its box: its room is a box of its own, which only
    // its generator may touch.
    const generator = drawn.boxes.find((b) => b.id === 'generator-G1')!.box;
    const marker = drawn.boxes.find((b) => b.id === 'marker:generator-G1')!;
    expect(marker.of).toEqual(['generator-G1']);
    expect(marker.box).toEqual({
      left: generator.right - 6,
      right: generator.right + 2,
      top: generator.top - 2,
      bottom: generator.top + 6,
    });
    // The symbol of a transformer sits on its own line, which is no overlap.
    const symbol = drawn.boxes.find((b) => b.id === 'symbol:transformer-T24')!;
    expect(symbol.of).toEqual(['transformer-T24']);
    expect(symbol.box.right - symbol.box.left).toBe(TRANSFORMER_LABEL_BOX.width);
  });

  it('adds the readouts and the flow labels with values, each as wide as what it shows', () => {
    const { nodes, draw } = diagram();
    const labelWidths = {
      readouts: new Map([['load-PQ_1', 40]]),
      flows: new Map([['line-L13', 30]]),
    };
    const picture = draw({ values: true, labelWidths });
    const drawn = drawnDiagram(nodes, picture, { values: true, labelWidths });
    const box = (id: string) => drawn.boxes.find((b) => b.id === id)!;
    expect(box('readout:load-PQ_1').kind).toBe('readout');
    expect(box('readout:load-PQ_1').box).toEqual(picture.readouts.get('load-PQ_1')!.box);
    expect(box('readout:load-PQ_1').box.right - box('readout:load-PQ_1').box.left).toBe(40);
    // A label with no width of its own is taken at its widest.
    const narrow = box('flow:line-L13').box;
    const wide = box('flow:line-L12').box;
    const span = (b: typeof narrow) => Math.max(b.right - b.left, b.bottom - b.top);
    expect(span(narrow)).toBe(30);
    expect(span(wide)).toBe(LINE_LABEL_BOX.width);
    expect(box('flow:line-L13').of).toEqual(['line-L13']);
    // Without values none of them is drawn, whatever the picture holds.
    const hidden = drawnDiagram(nodes, picture, { values: false });
    expect(hidden.boxes.some((b) => b.kind === 'readout' || b.id.startsWith('flow:'))).toBe(false);
  });

  it('leaves out a readout and a flow label that found no place', () => {
    const { nodes, draw } = diagram();
    const picture = draw({ values: true });
    picture.readouts.set('load-PQ_1', { ...picture.readouts.get('load-PQ_1')!, spot: 'none' });
    picture.labelPlaces.set('line-L13', {
      ...picture.labelPlaces.get('line-L13')!,
      hidden: true,
    });
    const drawn = drawnDiagram(nodes, picture, { values: true });
    expect(drawn.boxes.some((b) => b.id === 'readout:load-PQ_1')).toBe(false);
    expect(drawn.boxes.some((b) => b.id === 'flow:line-L13')).toBe(false);
    expect(drawn.boxes.some((b) => b.id === 'flow:line-L12')).toBe(true);
  });

  it('is what the checker reads: a symbol moved onto a line shows as an overlap', () => {
    const { nodes, draw } = diagram();
    const picture = draw();
    const drawn = drawnDiagram(nodes, picture, { values: false });
    const line = drawn.lines.find((l) => l.id === 'line-L13')!;
    const [a, b] = [line.points[0]!, line.points[1]!];
    const middle = { x: (a[0]! + b[0]!) / 2, y: (a[1]! + b[1]!) / 2 };
    const load = drawn.boxes.find((box) => box.id === 'load-PQ_1')!;
    const [width, height] = [load.box.right - load.box.left, load.box.bottom - load.box.top];
    load.box = {
      left: middle.x - width / 2,
      right: middle.x + width / 2,
      top: middle.y - height / 2,
      bottom: middle.y + height / 2,
    };
    expect(overlaps(load.box, { left: a[0]!, right: a[0]! + 1, top: a[1]!, bottom: b[1]! })).toBe(
      true,
    );
    expect(findOverlaps(drawn).map((o) => `${o.kind} ${o.a} ${o.b}`)).toContain(
      'line-box line-L13 load-PQ_1',
    );
  });
});

describe('drawsClear', () => {
  /** `nodes` with the node `id` at `to`. */
  const withNodeAt = <N extends { id: string; position: { x: number; y: number } }>(
    nodes: readonly N[],
    id: string,
    to: { x: number; y: number },
  ): N[] => nodes.map((n) => (n.id === id ? { ...n, position: to } : n));

  it('passes the diagram as it stands, and a device moved to free ground', () => {
    const { nodes, edges } = diagram();
    const barLengths = defaultBarLengths(square());
    const clear = drawsClear(nodes, edges as ConnectionEdge[], { barLengths, values: false });
    expect(clear(nodes)).toBe(true);
    const load = nodes.find((n) => n.id === 'load-PQ_1')!;
    expect(
      clear(withNodeAt(nodes, 'load-PQ_1', { x: load.position.x + 60, y: load.position.y })),
    ).toBe(true);
  });

  it('refuses a place from where the connector of a device would run through the bar of another bus', () => {
    // The load of bus 4, set down west of bus 3 and level with its bar: its
    // connector runs east to bar 4, along bar 3 and through it.
    const { nodes, edges } = diagram();
    const barLengths = defaultBarLengths(square());
    const clear = drawsClear(nodes, edges as ConnectionEdge[], { barLengths, values: false });
    const there = withNodeAt(nodes, 'load-PQ_1', { x: COORDS['3'].x - 200, y: COORDS['3'].y - 20 });
    const picture = pictureOf(there, edges as ConnectionEdge[], { barLengths, values: false });
    const found = findOverlaps(drawnDiagram(there, picture, { values: false }));
    expect(found.map((o) => `${o.kind} ${o.a} ${o.b}`)).toEqual(['line-bar stub-load-PQ_1 3']);
    expect(clear(there)).toBe(false);
  });

  it('does not hold against a move what the diagram had on each other before it', () => {
    // The diagram comes with the load on the generator: two symbols on each
    // other, which no move of something else put there.
    const { nodes, edges } = diagram();
    const barLengths = defaultBarLengths(square());
    const generator = nodes.find((n) => n.id === 'generator-G1')!;
    const came = withNodeAt(nodes, 'load-PQ_1', {
      x: generator.position.x + 10,
      y: generator.position.y + 4,
    });
    const options = { barLengths, values: false };
    const before = findOverlaps(
      drawnDiagram(came, pictureOf(came, edges as ConnectionEdge[], options), options),
    );
    expect(before).not.toEqual([]);
    const clear = drawsClear(came, edges as ConnectionEdge[], options);
    expect(clear(came)).toBe(true);
    // Bus 3 moved a little way along its row changes nothing about that.
    const bus3 = came.find((n) => n.id === '3')!;
    expect(clear(withNodeAt(came, '3', { x: bus3.position.x - 16, y: bus3.position.y }))).toBe(
      true,
    );
  });
});
