/**
 * Where the labels of the diagram stand (`labels.ts`): the label of a bus,
 * the P / Q readout of a generator or load, and the label of a branch, each
 * clear of what is drawn and of the ones placed before it.
 *
 * A bus node at `(x, y)` is drawn as a bar from `x` to `x + 92` whose centre
 * line is at `y + 3`, and its label hangs in the strip from `y + 6` to
 * `y + 46`. A device is given as a box, and the readout of one that stands
 * over or under its bar hangs in the strip between the two, 72 wide and 22
 * high, 4 beside the connector. The diagrams are built by hand, with the
 * routes written out, so each test says what runs where.
 */
import { describe, expect, it } from 'vitest';
import {
  LABEL_ROOM,
  labelBoxAt,
  type BarGeometry,
  type ConnectionEdge,
  type ConnectionLayout,
  type ConnectorRoute,
  type LabelPlace,
  type Point,
  type Rect,
} from '@/components/sld/connections';
import {
  BUS_LABEL_BESIDE_GAP,
  LINE_LABEL_BOX,
  boxOnDiagram,
  busLabelBox,
  busLabelClear,
  busLabelReserve,
  busLabelWidth,
  chainBoxes,
  flowLabelWidth,
  limitMarkerBox,
  overlaps,
  placeBranchLabels,
  placeBusLabels,
  placeReadouts,
  placeTransformerSymbols,
  readoutReserve,
  readoutWidth,
  symbolBoxes,
  type LabelNode,
} from '@/components/sld/labels';

const NO_SIZES = new Map<string, { width: number; height: number }>();

function bus(id: string, x: number, y: number): LabelNode {
  return { id, type: 'bus', position: { x, y }, data: { name: id } };
}

/** A device 40 wide and 41 high whose top-left corner is at `(x, y)`. */
function device(
  id: string,
  x: number,
  y: number,
  data: Record<string, unknown> = {},
  width = 40,
): LabelNode {
  return {
    id,
    type: id.split('-')[0],
    position: { x, y },
    initialWidth: width,
    initialHeight: 41,
    data,
  };
}

function bar(taps: BarGeometry['taps'] = [], start = 0, end = 92): BarGeometry {
  return { start, end, taps };
}

/** A connector through `points`, leaving its source by `sourceSide`. */
function route(
  points: Point[],
  sourceSide: ConnectorRoute['sourceSide'] = 'south',
): ConnectorRoute {
  return { points, sourceSide, targetSide: 'north' };
}

function layout(
  bars: Record<string, BarGeometry>,
  routes: Record<string, ConnectorRoute> = {},
): ConnectionLayout {
  return { bars: new Map(Object.entries(bars)), routes: new Map(Object.entries(routes)) };
}

/** Whether a level or upright run of `points` passes through the inside of `box`. */
function crosses(points: readonly Point[], box: Rect): boolean {
  return points.slice(1).some((b, i) => {
    const a = points[i]!;
    return (
      Math.max(a[0], b[0]) > box.left &&
      Math.min(a[0], b[0]) < box.right &&
      Math.max(a[1], b[1]) > box.top &&
      Math.min(a[1], b[1]) < box.bottom
    );
  });
}

describe('busLabelWidth and busLabelBox', () => {
  it('takes a label to be as wide as its name with a marker, or as its values', () => {
    expect(busLabelWidth('BUS1', false)).toBe(6 * 6 + 8);
    expect(busLabelWidth('BUS1', true)).toBe(6 * 9 + 8);
    expect(busLabelWidth('A bus with a long name', true)).toBe(6 * 24 + 8);
  });

  it('hangs the label under the middle of the bar, taller with values in it', () => {
    const node = bus('BUS1', 100, 200);
    expect(busLabelBox(node, false, bar(), undefined)).toEqual({
      left: 146 - 22,
      right: 146 + 22,
      top: 206,
      bottom: 224,
    });
    // Its three lines and the gap to the bar: right down to where the readout
    // of a device at the default distance under the bus begins.
    expect(busLabelBox(node, true, bar(), undefined)).toEqual({
      left: 146 - 31,
      right: 146 + 31,
      top: 206,
      bottom: 246,
    });
  });

  it('stands the label over the bar where `busLabelPlace` puts it there', () => {
    const node = bus('BUS1', 100, 200);
    const box = busLabelBox(node, true, bar(), { below: [[-200, 300]], above: [] });
    expect(box).toEqual({ left: 146 - 31, right: 146 + 31, top: 200 - 4 - 40, bottom: 196 });
  });
});

describe('busLabelClear', () => {
  it('has nothing to keep clear of under a bar that stands alone', () => {
    const nodes = [bus('1', 0, 0)];
    expect(busLabelClear(nodes, layout({ '1': bar() }), NO_SIZES).get('1')).toEqual({
      below: [],
      above: [],
    });
  });

  it('shuts the stretch a symbol under the bar takes, so the label stands clear of it', () => {
    // A generator dragged to just under the left of its bar, and a line that
    // leaves the bar at its right tip.
    const nodes = [bus('1', 0, 100), device('generator-g', -20, 135, {}, 85)];
    const drawn = layout(
      {
        '1': bar([
          { x: 22.5, side: 'south' },
          { x: 89, side: 'south' },
        ]),
      },
      {
        'stub-generator-g': route(
          [
            [22.5, 135],
            [22.5, 103],
          ],
          'north',
        ),
        'line-l': route([
          [89, 103],
          [89, 400],
        ]),
      },
    );
    const clear = busLabelClear(nodes, drawn, NO_SIZES).get('1')!;
    expect(clear.below).toContainEqual([-20, 65]);
    const label = busLabelBox(nodes[0]!, true, drawn.bars.get('1'), clear);
    const generator = boxOnDiagram(nodes[1]!, NO_SIZES, drawn.bars);
    expect(overlaps(label, generator)).toBe(false);
    // Nor does the line run through it: it stands past the tip of the bar.
    expect(crosses(drawn.routes.get('line-l')!.points, label)).toBe(false);
    expect(label.left).toBeGreaterThanOrEqual(89 + 4);
    expect(label.top).toBe(106);
  });

  it('sends the label over the bar when a symbol takes up all the room under it', () => {
    // As wide as the bar and what the label may stand past its tips.
    const nodes = [bus('1', 0, 100), device('generator-g', -100, 135, {}, 300)];
    const drawn = layout({ '1': bar() });
    const clear = busLabelClear(nodes, drawn, NO_SIZES).get('1')!;
    const label = busLabelBox(nodes[0]!, true, drawn.bars.get('1'), clear);
    expect(label.bottom).toBe(96);
    expect(overlaps(label, boxOnDiagram(nodes[1]!, NO_SIZES, drawn.bars))).toBe(false);
  });

  it('shuts the stretch a run covers that passes at the foot of the label', () => {
    // A level run 44 under the bus, where the angle of a label with values is.
    const nodes = [bus('1', 0, 100)];
    const drawn = layout(
      { '1': bar() },
      {
        'line-l': route([
          [20, 144],
          [300, 144],
        ]),
      },
    );
    expect(busLabelClear(nodes, drawn, NO_SIZES).get('1')!.below).toEqual([[20, 184]]);
  });

  it('keeps the label of a bus off the bar of another that stands just under it', () => {
    const nodes = [bus('1', 0, 0), bus('2', 60, 20)];
    const drawn = layout({ '1': bar(), '2': bar() });
    const clear = busLabelClear(nodes, drawn, NO_SIZES);
    const first = busLabelBox(nodes[0]!, true, drawn.bars.get('1'), clear.get('1'));
    expect(overlaps(first, { left: 60, right: 152, top: 20, bottom: 26 })).toBe(false);
  });

  it('keeps the label of a bus off the label of one placed before it', () => {
    // Level with each other, and each has a connector that sends its label
    // towards the other.
    const nodes = [bus('1', 0, 0), bus('2', 100, 0)];
    const drawn = layout({
      '1': bar([{ x: 40, side: 'south' }]),
      '2': bar([{ x: 60, side: 'south' }]),
    });
    const clear = busLabelClear(nodes, drawn, NO_SIZES);
    const first = busLabelBox(nodes[0]!, true, drawn.bars.get('1'), clear.get('1'));
    const second = busLabelBox(nodes[1]!, true, drawn.bars.get('2'), clear.get('2'));
    expect(first).toMatchObject({ left: 44, right: 106 });
    expect(overlaps(first, second)).toBe(false);
    // Placed alone, the second would stand where the first is.
    const alone = busLabelClear([nodes[1]!], layout({ '2': drawn.bars.get('2')! }), NO_SIZES);
    const unaware = busLabelBox(nodes[1]!, true, drawn.bars.get('2'), alone.get('2'));
    expect(overlaps(first, unaware)).toBe(true);
  });
});

describe('placeReadouts', () => {
  // A load under the left of bar 1, its connector square onto the bar at 20.
  const load = device('load-PQ', 0, 173, { valueSide: 'above', parentBus: '1' });
  const nodes = [bus('1', 0, 100), load];
  const stub = route(
    [
      [20, 173],
      [20, 103],
    ],
    'north',
  );
  const right: Rect = { left: 24, right: 96, top: 149, bottom: 171 };
  const left: Rect = { left: -56, right: 16, top: 149, bottom: 171 };

  it('stands the readout right of a connector that leaves by the face it hangs off', () => {
    const drawn = layout({ '1': bar([{ x: 20, side: 'south' }]) }, { 'stub-load-PQ': stub });
    expect(placeReadouts(nodes, drawn, NO_SIZES).get('load-PQ')).toEqual({
      spot: 'right',
      box: right,
    });
  });

  it('stands it left of the connector when a line runs through it on the right', () => {
    const drawn = layout(
      {
        '1': bar([
          { x: 20, side: 'south' },
          { x: 60, side: 'south' },
        ]),
      },
      {
        'stub-load-PQ': stub,
        'line-l': route([
          [60, 103],
          [60, 400],
        ]),
      },
    );
    expect(placeReadouts(nodes, drawn, NO_SIZES).get('load-PQ')).toEqual({
      spot: 'left',
      box: left,
    });
  });

  it('goes to the far side of the device when a line runs through it on either side', () => {
    const drawn = layout(
      {
        '1': bar([
          { x: 20, side: 'south' },
          { x: 60, side: 'south' },
        ]),
      },
      {
        'stub-load-PQ': stub,
        'line-l': route([
          [60, 103],
          [60, 400],
        ]),
        'line-m': route([
          [-20, 0],
          [-20, 160],
          [-90, 160],
        ]),
      },
    );
    const place = placeReadouts(nodes, drawn, NO_SIZES).get('load-PQ')!;
    expect(place.spot).toBe('far');
    // Under the load, about its middle.
    expect(place.box).toEqual({ left: 20 - 36, right: 20 + 36, top: 216, bottom: 238 });
  });

  it('stands beside the symbol when the far side is taken as well', () => {
    const drawn = layout(
      {
        '1': bar([
          { x: 20, side: 'south' },
          { x: 60, side: 'south' },
        ]),
      },
      {
        'stub-load-PQ': stub,
        // Past the load on its right, then under it.
        'line-l': route([
          [60, 103],
          [60, 226],
          [-200, 226],
        ]),
        'line-m': route([
          [-20, 0],
          [-20, 160],
          [-90, 160],
        ]),
      },
    );
    const place = placeReadouts(nodes, drawn, NO_SIZES).get('load-PQ')!;
    // The line passes on the east; the west of the symbol is free.
    expect(place.spot).toBe('west');
    expect(place.box).toEqual({ left: -4 - 72, right: -4, top: 193.5 - 11, bottom: 193.5 + 11 });
  });

  it('is left off when no place is free, with the box it would first take', () => {
    const drawn = layout(
      {
        '1': bar([
          { x: 20, side: 'south' },
          { x: 60, side: 'south' },
        ]),
      },
      {
        'stub-load-PQ': stub,
        'line-l': route([
          [60, 103],
          [60, 226],
          [-200, 226],
        ]),
        'line-m': route([
          [-20, 0],
          [-20, 400],
        ]),
      },
    );
    const place = placeReadouts(nodes, drawn, NO_SIZES).get('load-PQ')!;
    expect(place.spot).toBe('none');
    // Right of the connector, under the load: where it stands with nothing in the way.
    expect(place.box).toEqual(
      placeReadouts(
        nodes,
        layout({ '1': bar([{ x: 20, side: 'south' }]) }, { 'stub-load-PQ': stub }),
        NO_SIZES,
      ).get('load-PQ')!.box,
    );
  });

  it('keeps out of a symbol that stands where it would', () => {
    // A shunt in the strip right of the connector.
    const shunt = device('shunt-S', 40, 140, {}, 30);
    const drawn = layout({ '1': bar([{ x: 20, side: 'south' }]) }, { 'stub-load-PQ': stub });
    expect(placeReadouts([...nodes, shunt], drawn, NO_SIZES).get('load-PQ')!.spot).toBe('left');
  });

  it('keeps out of the label of a bus', () => {
    const drawn = layout({ '1': bar([{ x: 20, side: 'south' }]) }, { 'stub-load-PQ': stub });
    const busLabels = new Map([['1', { left: 30, right: 92, top: 106, bottom: 160 }]]);
    expect(placeReadouts(nodes, drawn, NO_SIZES, { busLabels }).get('load-PQ')!.spot).toBe('left');
  });

  it('stands on the side its connector does not go off to', () => {
    // Past the west tip of the bar: the connector goes up and to the right.
    const far = device('load-PQ', -100, 173, { valueSide: 'above', parentBus: '1' });
    const drawn = layout(
      { '1': bar([{ x: 3, side: 'south' }]) },
      {
        'stub-load-PQ': route(
          [
            [-80, 173],
            [3, 103],
          ],
          'north',
        ),
      },
    );
    expect(placeReadouts([nodes[0]!, far], drawn, NO_SIZES).get('load-PQ')!.spot).toBe('left');
  });

  it('stands under or over the middle of a device whose connector leaves by another face', () => {
    // Level with the bar, beyond its east tip: the connector leaves by the west face.
    const beside = device('load-PQ', 150, 83, { valueSide: 'above', parentBus: '1' });
    const drawn = layout(
      { '1': bar([{ x: 89, side: 'east' }]) },
      {
        'stub-load-PQ': route(
          [
            [150, 103.5],
            [89, 103],
          ],
          'west',
        ),
      },
    );
    const place = placeReadouts([nodes[0]!, beside], drawn, NO_SIZES).get('load-PQ')!;
    expect(place.spot).toBe('centre');
    expect(place.box).toMatchObject({ left: 170 - 36, right: 170 + 36 });
  });

  it('gives every device its first choice before any gets its second', () => {
    // A generator 100 along the bar from the load. A line runs through the
    // place right of the generator's connector, so it would take the left,
    // which is where the readout of the load stands.
    const generator = device('generator-G', 90, 173, { valueSide: 'above', parentBus: '1' }, 60);
    const drawn = layout(
      {
        '1': bar(
          [
            { x: 20, side: 'south' },
            { x: 120, side: 'south' },
            { x: 160, side: 'south' },
          ],
          0,
          170,
        ),
      },
      {
        'stub-generator-G': route(
          [
            [120, 173],
            [120, 103],
          ],
          'north',
        ),
        'stub-load-PQ': stub,
        'line-l': route([
          [160, 103],
          [160, 400],
        ]),
      },
    );
    // The generator comes first among the nodes.
    const places = placeReadouts([nodes[0]!, generator, load], drawn, NO_SIZES);
    expect(places.get('load-PQ')!.spot).toBe('right');
    expect(places.get('generator-G')!.spot).toBe('far');
    expect(overlaps(places.get('load-PQ')!.box, places.get('generator-G')!.box)).toBe(false);
  });

  it('keeps the readout of a unit whose chain is drawn out on the side of its bus', () => {
    const drawn = layout(
      {
        '1': bar([
          { x: 20, side: 'south' },
          { x: 60, side: 'south' },
        ]),
      },
      {
        'stub-load-PQ': stub,
        'line-l': route([
          [60, 103],
          [60, 400],
        ]),
        'line-m': route([
          [-20, 0],
          [-20, 160],
          [-90, 160],
        ]),
      },
    );
    // Both places beside the connector are taken. Without a chain the far
    // side of the device would do; with one drawn out there, the readout is
    // left off rather than drawn over the chain.
    const chains = new Map([['load-PQ', { left: -20, right: 60, top: 218, bottom: 260 }]]);
    expect(placeReadouts(nodes, drawn, NO_SIZES).get('load-PQ')!.spot).toBe('far');
    expect(placeReadouts(nodes, drawn, NO_SIZES, { chains }).get('load-PQ')!.spot).toBe('none');
  });

  it('places the readouts of generators and loads only', () => {
    const shunt = device('shunt-S', 200, 173);
    const drawn = layout({ '1': bar([{ x: 20, side: 'south' }]) }, { 'stub-load-PQ': stub });
    expect([...placeReadouts([...nodes, shunt], drawn, NO_SIZES).keys()]).toEqual(['load-PQ']);
  });
});

describe('readoutReserve', () => {
  const load = device('load-PQ', 0, 173, { valueSide: 'above', parentBus: '1' });
  const nodes = [bus('1', 0, 100), load];
  const stub = route(
    [
      [20, 173],
      [20, 103],
    ],
    'north',
  );

  it('keeps the two places beside the connector and the far side of each device', () => {
    const drawn = layout({ '1': bar([{ x: 20, side: 'south' }]) }, { 'stub-load-PQ': stub });
    expect(readoutReserve(nodes, drawn, NO_SIZES)).toEqual([
      [
        { left: 24, right: 96, top: 149, bottom: 171 },
        { left: -56, right: 16, top: 149, bottom: 171 },
        { left: -16, right: 56, top: 216, bottom: 238 },
      ],
    ]);
  });

  it('leaves out a place the connector of another device runs through, or a symbol stands in', () => {
    const neighbour = device('load-N', 50, 173, { valueSide: 'above', parentBus: '1' });
    const drawn = layout(
      {
        '1': bar([
          { x: 20, side: 'south' },
          { x: 70, side: 'south' },
        ]),
      },
      {
        'stub-load-PQ': stub,
        'stub-load-N': route(
          [
            [70, 173],
            [70, 103],
          ],
          'north',
        ),
      },
    );
    const [first, second] = readoutReserve([...nodes, neighbour], drawn, NO_SIZES);
    // The first load: the connector of its neighbour runs through the right.
    expect(first).toEqual([
      { left: -56, right: 16, top: 149, bottom: 171 },
      { left: -16, right: 56, top: 216, bottom: 238 },
    ]);
    // The neighbour: the connector of the first runs through its left, and
    // its far side reaches into the one the first takes.
    expect(second![0]).toEqual({ left: 74, right: 146, top: 149, bottom: 171 });
  });

  it('leaves out the places that reach into what the device beside it takes first', () => {
    // Two loads 140 apart: left of the second is right of the first.
    const second = device('load-N', 140, 173, { valueSide: 'above', parentBus: '2' });
    const drawn = layout(
      { '1': bar([{ x: 20, side: 'south' }]), '2': bar([{ x: 20, side: 'south' }]) },
      {
        'stub-load-PQ': stub,
        'stub-load-N': route(
          [
            [160, 173],
            [160, 103],
          ],
          'north',
        ),
      },
    );
    const room = readoutReserve([...nodes, bus('2', 140, 100), second], drawn, NO_SIZES);
    expect(room[0]).toHaveLength(3);
    // Right of its connector and its far side: not the left, which the first has.
    expect(room[1]).toEqual([
      { left: 164, right: 236, top: 149, bottom: 171 },
      { left: 124, right: 196, top: 216, bottom: 238 },
    ]);
  });

  it('has nothing to keep for a diagram with no generator or load', () => {
    expect(readoutReserve([bus('1', 0, 0)], layout({ '1': bar() }), NO_SIZES)).toEqual([]);
  });
});

describe('placeBranchLabels', () => {
  const line = (id: string, type = 'topology'): ConnectionEdge => ({
    id,
    type,
    source: '1',
    target: '2',
  });
  const nodes = [bus('1', 0, 0), bus('2', 0, 300)];
  const down = route([
    [46, 3],
    [46, 303],
  ]);
  const boxOf = (place: LabelPlace): Rect =>
    labelBoxAt(place, LINE_LABEL_BOX.width, LINE_LABEL_BOX.height);

  it('stands the flow of a line on its line where nothing is in the way', () => {
    const drawn = layout({ '1': bar(), '2': bar() }, { 'line-l': down });
    const places = placeBranchLabels(nodes, [line('line-l')], drawn, NO_SIZES, {
      busLabels: new Map(),
      readouts: [],
    });
    expect(places.get('line-l')).toEqual({ x: 46, y: 153, angleDeg: 90 });
  });

  it('keeps it off a device, the readout of one and the label of a bus', () => {
    // A load close beside the line from top to bottom, with its readout,
    // and the label of bus 1 on the other side of the line.
    const load = device('load-PQ', 54, 20, {}, 40);
    const tall = { ...load, initialHeight: 260 };
    const readout: Rect = { left: 54, right: 126, top: 281, bottom: 300 };
    const busLabel: Rect = { left: -40, right: 42, top: 6, bottom: 48 };
    const drawn = layout({ '1': bar(), '2': bar() }, { 'line-l': down });
    const place = placeBranchLabels([...nodes, tall], [line('line-l')], drawn, NO_SIZES, {
      busLabels: new Map([['1', busLabel]]),
      readouts: [readout],
    }).get('line-l')!;
    const box = boxOf(place);
    // Beside the line, on the side the load is not on.
    expect(place.label).toBeDefined();
    expect(box.right).toBeLessThan(46);
    for (const other of [boxOnDiagram(tall, NO_SIZES, drawn.bars), readout, busLabel]) {
      expect(overlaps(box, other)).toBe(false);
    }
  });

  it('keeps the flow of a line a little way off the symbol of a device, and off the limit mark of a generator', () => {
    // A load all along the right of the line, and two devices on its left,
    // one over the other: the only room for the label is beside the line in
    // the gap between those two.
    const tall = { ...device('load-PQ', 50, 12), initialHeight: 280 };
    const upper = { ...device('generator-A', -16, 12, {}, 60), initialHeight: 131 };
    const lowerAt = (top: number, id = 'generator-B'): LabelNode => ({
      ...device(id, -16, top, {}, 60),
      initialHeight: 292 - top,
    });
    const drawn = layout({ '1': bar(), '2': bar() }, { 'line-l': down });
    const placeWith = (lower: LabelNode): LabelPlace =>
      placeBranchLabels([...nodes, tall, upper, lower], [line('line-l')], drawn, NO_SIZES, {
        busLabels: new Map(),
        readouts: [],
      }).get('line-l')!;
    const gapTo = (place: LabelPlace, other: Rect): number => {
      const box = boxOf(place);
      return Math.max(
        other.left - box.right,
        box.left - other.right,
        other.top - box.bottom,
        box.top - other.bottom,
      );
    };
    // A gap the label fits flush against both: it is left off.
    expect(placeWith(lowerAt(164)).hidden).toBe(true);
    // A gap that leaves it its distance from two symbols.
    const load = lowerAt(169, 'load-B');
    const between = placeWith(load);
    expect(between.hidden).toBeUndefined();
    for (const other of [upper, load]) {
      expect(gapTo(between, boxOnDiagram(other, NO_SIZES, drawn.bars))).toBeGreaterThanOrEqual(
        LABEL_ROOM,
      );
    }
    // Not from the mark on the corner of a generator, which reaches out of
    // its box: the same gap under a generator has no place for the label,
    // and one that much wider has.
    expect(placeWith(lowerAt(169)).hidden).toBe(true);
    const generator = lowerAt(171);
    const clear = placeWith(generator);
    expect(clear.hidden).toBeUndefined();
    expect(gapTo(clear, limitMarkerBox(generator, NO_SIZES)!)).toBeGreaterThanOrEqual(LABEL_ROOM);
  });

  it('keeps the symbol of a transformer on its line', () => {
    const load = { ...device('load-PQ', 54, 20), initialHeight: 260 };
    const drawn = layout({ '1': bar(), '2': bar() }, { 'transformer-t': down });
    const place = placeBranchLabels(
      [...nodes, load],
      [line('transformer-t', 'transformer')],
      drawn,
      NO_SIZES,
      { busLabels: new Map(), readouts: [] },
    ).get('transformer-t')!;
    expect(place.label).toBeUndefined();
    expect(place.x).toBe(46);
  });

  it('takes the symbols of the transformers where it is told they stand, and keeps a flow label off them', () => {
    // A transformer and a line side by side, 40 apart; the symbol stands
    // where the label of the line would stand beside its line.
    const beside = route([
      [86, 3],
      [86, 303],
    ]);
    const drawn = layout({ '1': bar(), '2': bar() }, { 'transformer-t': down, 'line-l': beside });
    const edges = [line('transformer-t', 'transformer'), line('line-l')];
    const symbols = new Map<string, LabelPlace>([
      ['transformer-t', { x: 46, y: 153, angleDeg: 90 }],
    ]);
    const places = placeBranchLabels(nodes, edges, drawn, NO_SIZES, {
      busLabels: new Map(),
      readouts: [],
      symbols,
    });
    expect(places.get('transformer-t')).toBe(symbols.get('transformer-t'));
    const symbol: Rect = { left: 31, right: 61, top: 138, bottom: 168 };
    expect(overlaps(boxOf(places.get('line-l')!), symbol)).toBe(false);
    // Without the values of a power flow, the symbols are all there is.
    const plain = placeBranchLabels(nodes, edges, drawn, NO_SIZES, {
      busLabels: new Map(),
      readouts: [],
      symbols,
      values: false,
    });
    expect([...plain.keys()]).toEqual(['transformer-t']);
  });

  it('places no label for a device connector', () => {
    const load = device('load-PQ', 0, 70);
    const drawn = layout(
      { '1': bar(), '2': bar() },
      {
        'stub-load-PQ': route(
          [
            [20, 70],
            [20, 3],
          ],
          'north',
        ),
      },
    );
    const stub: ConnectionEdge = {
      id: 'stub-load-PQ',
      type: 'stub',
      source: 'load-PQ',
      target: '1',
    };
    const places = placeBranchLabels([...nodes, load], [stub], drawn, NO_SIZES, {
      busLabels: new Map(),
      readouts: [],
    });
    expect(places.size).toBe(0);
  });
});

describe('placeTransformerSymbols', () => {
  const transformer: ConnectionEdge = {
    id: 'transformer-t',
    type: 'transformer',
    source: '1',
    target: '2',
  };
  const nodes = [bus('1', 0, 0), bus('2', 0, 300)];
  const down = route([
    [46, 3],
    [46, 303],
  ]);
  const place = (
    routes: Record<string, ConnectorRoute>,
    standing: LabelNode[] = [],
    edges: ConnectionEdge[] = [transformer],
  ) => {
    const drawn = layout({ '1': bar(), '2': bar() }, routes);
    return placeTransformerSymbols([...nodes, ...standing], edges, drawn, NO_SIZES);
  };

  it('stands the symbol half way along its line where nothing is in the way, and places nothing for a line', () => {
    const line: ConnectionEdge = { id: 'line-l', type: 'topology', source: '1', target: '2' };
    const beside = route([
      [78, 3],
      [78, 303],
    ]);
    const places = place({ 'transformer-t': down, 'line-l': beside }, [], [transformer, line]);
    expect([...places.keys()]).toEqual(['transformer-t']);
    expect(places.get('transformer-t')).toEqual({ x: 46, y: 153, angleDeg: 90 });
    expect(symbolBoxes(places).get('transformer-t')).toEqual({
      left: 31,
      right: 61,
      top: 138,
      bottom: 168,
    });
  });

  it('moves along its line, clear of a line that crosses it and of a symbol beside it', () => {
    // A line across the middle of the transformer, and a load beside it
    // from there down.
    const across = route([
      [-100, 153],
      [200, 153],
    ]);
    const load = { ...device('load-PQ', 50, 140), initialHeight: 120 };
    const at = place({ 'transformer-t': down, 'line-x': across }, [load]).get('transformer-t')!;
    const box = symbolBoxes(new Map([['transformer-t', at]])).get('transformer-t')!;
    expect(at.x).toBe(46);
    expect(at.label).toBeUndefined();
    expect(crosses(across.points, box)).toBe(false);
    expect(box.bottom).toBeLessThanOrEqual(140);
  });

  it('stands beside a line that passes close by, and on no line', () => {
    // A line 16 from the transformer all the way: on the next line of the
    // grid, which the symbol does not reach.
    const close = route([
      [62, 3],
      [62, 303],
    ]);
    const at = place({ 'transformer-t': down, 'line-x': close }).get('transformer-t')!;
    expect(at).toMatchObject({ x: 46, y: 153 });
    // One that runs 12 from it all the way is through the symbol wherever
    // it stands: with a stretch of the route that it leaves, the symbol
    // stands there.
    const through = route([
      [58, 3],
      [58, 200],
      [120, 200],
      [120, 303],
    ]);
    const moved = place({ 'transformer-t': down, 'line-x': through }).get('transformer-t')!;
    const box = symbolBoxes(new Map([['transformer-t', moved]])).get('transformer-t')!;
    expect(crosses(through.points, box)).toBe(false);
    expect(moved.y).toBeGreaterThan(200);
  });

  it('is tried in every place of a long route before it is put on something', () => {
    // A route of over a thousand, with lines right beside it all the way
    // but for a stretch of 40 near one end.
    const far = [bus('1', 0, 0), bus('2', 0, 1200)];
    const long = route([
      [46, 3],
      [46, 1203],
    ]);
    const left = route([
      [36, 3],
      [36, 1100],
      [-60, 1100],
      [-60, 1203],
    ]);
    const right = route([
      [56, 3],
      [56, 1100],
      [160, 1100],
      [160, 1203],
    ]);
    const drawn = layout(
      { '1': bar(), '2': bar() },
      { 'transformer-t': long, 'line-a': left, 'line-b': right },
    );
    const at = placeTransformerSymbols(far, [transformer], drawn, NO_SIZES).get('transformer-t')!;
    const box = symbolBoxes(new Map([['transformer-t', at]])).get('transformer-t')!;
    expect(crosses(left.points, box)).toBe(false);
    expect(crosses(right.points, box)).toBe(false);
    expect(box.bottom).toBeLessThanOrEqual(1200);
  });
});

describe('chainBoxes', () => {
  it('finds the chain of each unit that is drawn out, on the side its node says', () => {
    const members = [
      { kind: 'PV', idx: '1', role: 'generator', depth: 0, nodeId: 'generator-1' },
      { kind: 'GENROU', idx: '1', role: 'machine', depth: 1, nodeId: 'generator-1' },
    ];
    const open = device('generator-1', 100, 100, {
      unit: { members, expanded: true, side: 'above' },
    });
    const shut = device('generator-2', 300, 100, { unit: { members, expanded: false } });
    const boxes = chainBoxes([open, shut, device('load-PQ', 0, 0)], NO_SIZES);
    expect([...boxes.keys()]).toEqual(['generator-1']);
    const box = boxes.get('generator-1')!;
    // Over the symbol, about its middle.
    expect(box.bottom).toBe(96);
    expect((box.left + box.right) / 2).toBe(120);
  });
});

describe('placeBusLabels', () => {
  const node = bus('BUS1', 100, 200);
  /** An upright connector at `x` through the strips under and over the bar. */
  const through = (x: number): ConnectorRoute =>
    route([
      [x, 100],
      [x, 300],
    ]);
  /** Upright connectors `step` apart from `from` to `to`: no label fits between two of them. */
  const fence = (from: number, to: number, step = 40): Record<string, ConnectorRoute> => {
    const lines: Record<string, ConnectorRoute> = {};
    for (let x = from; x <= to; x += step) lines[`fence-${x}`] = through(x);
    return lines;
  };

  it('hangs the label under the middle of a bar that stands alone', () => {
    const label = placeBusLabels([node], layout({ BUS1: bar() }), NO_SIZES, true).get('BUS1')!;
    expect(label.side).toBe('below');
    expect(label.offset).toBe(46);
    expect(label.box).toEqual({ left: 146 - 31, right: 146 + 31, top: 206, bottom: 246 });
  });

  it('stands it over the bar where the strip under the bar is shut and the one over it is not', () => {
    // A symbol all along under the bar.
    const below = device('load-PQ', 0, 210, {}, 300);
    const label = placeBusLabels([node, below], layout({ BUS1: bar() }), NO_SIZES, true).get(
      'BUS1',
    )!;
    expect(label.side).toBe('above');
    expect(label.box.bottom).toBe(196);
  });

  it('stands it beside a tip of the bar, level with it, where neither strip has a place', () => {
    // A wide symbol in the strip under the bar and one in the strip over it,
    // both clear of the height of the bar itself.
    const under = device('load-PQ', -100, 228, {}, 500);
    const over = device('generator-G', -100, 130, {}, 500);
    const drawn = layout({ BUS1: bar() });
    const label = placeBusLabels([node, under, over], drawn, NO_SIZES, true).get('BUS1')!;
    expect(label.side).toBe('east');
    // Right of the tip, its middle at the height of the bar.
    expect(label.box.left).toBe(100 + 92 + BUS_LABEL_BESIDE_GAP);
    expect((label.box.top + label.box.bottom) / 2).toBe(203);
    // With something there as well, left of the other tip.
    const beside = device('shunt-S', 200, 183);
    const west = placeBusLabels([node, under, over, beside], drawn, NO_SIZES, true).get('BUS1')!;
    expect(west.side).toBe('west');
    expect(west.box.right).toBe(100 - BUS_LABEL_BESIDE_GAP);
  });

  it('stands it in the nearest clear place away from the bar where it has none by it', () => {
    // Connectors through both strips, all along the bar and far past its tips.
    const drawn = layout({ BUS1: bar() }, fence(-200, 500));
    const label = placeBusLabels([node], drawn, NO_SIZES, true).get('BUS1')!;
    expect(label.side).toBe('away');
    // Under the connectors, which end at 300: nothing runs through it.
    expect(label.box.top).toBeGreaterThanOrEqual(300);
    for (const { points } of drawn.routes.values()) expect(crosses(points, label.box)).toBe(false);
    // Its middle is what the node is told.
    expect(label.offset).toBe((label.box.left + label.box.right) / 2 - 100);
  });

  it('keeps the label off the symbol of a transformer that stands under the bar', () => {
    const symbol: Rect = { left: 131, right: 161, top: 210, bottom: 240 };
    const alone = placeBusLabels([node], layout({ BUS1: bar() }), NO_SIZES, true).get('BUS1')!;
    expect(overlaps(alone.box, symbol)).toBe(true);
    const label = placeBusLabels(
      [node],
      layout({ BUS1: bar() }),
      NO_SIZES,
      true,
      new Map(),
      new Map([['transformer-t', symbol]]),
    ).get('BUS1')!;
    expect(overlaps(label.box, symbol)).toBe(false);
    // Still under its bar, beside the symbol.
    expect(label.side).toBe('below');
  });

  it('shows the name alone next to the bar where the name with the values has no place there', () => {
    // Connectors 50 apart through both strips, along the bar and past its
    // tips: the label with a voltage in it is 62 wide, the name 44.
    const drawn = layout({ BUS1: bar() }, fence(-155, 495, 50));
    const withValues = placeBusLabels([node], drawn, NO_SIZES, true).get('BUS1')!;
    expect(withValues.compact).toBe(true);
    expect(withValues.box.right - withValues.box.left).toBe(busLabelWidth('BUS1', false));
    expect(withValues.box.bottom - withValues.box.top).toBe(18);
    // Next to the bar: under it, over it or beside a tip.
    const gapX = Math.max(0, withValues.box.left - 192, 100 - withValues.box.right);
    const gapY = Math.max(0, withValues.box.top - 206, 200 - withValues.box.bottom);
    expect(Math.hypot(gapX, gapY)).toBeLessThanOrEqual(16);
    for (const { points } of drawn.routes.values()) {
      expect(crosses(points, withValues.box)).toBe(false);
    }
    // The name alone is what a diagram without values shows anyway.
    const plain = placeBusLabels([node], drawn, NO_SIZES, false).get('BUS1')!;
    expect(plain.compact).toBeUndefined();
    expect(plain.box).toEqual(withValues.box);
  });

  it('stays next to the bar: no further past a tip than a label still reads as that of its bus', () => {
    // Symbols under the bar and over it, from far left of it to 30 past
    // its east tip, and one beside each tip.
    const under = device('load-PQ', -300, 210, {}, 522);
    const over = device('generator-G', -300, 150, {}, 522);
    const east = device('shunt-E', 198, 183);
    const west = device('shunt-W', 54, 183);
    const drawn = layout({ BUS1: bar() });
    const label = placeBusLabels([node, under, over, east, west], drawn, NO_SIZES, false).get(
      'BUS1',
    )!;
    // The first clear place in the rows by the bar is 30 past the tip:
    // further than next to the bar. The label goes a row further off
    // instead of far along the bar, as the last place there is.
    expect(label.side).toBe('away');
    const nextToBar = label.box.left <= 100 + 92 + 16 && label.box.right >= 100 - 16;
    const rowByBar = label.box.top === 210 || label.box.bottom === 196;
    expect(nextToBar && rowByBar).toBe(false);
    for (const other of [under, over, east, west]) {
      expect(overlaps(label.box, boxOnDiagram(other, NO_SIZES, drawn.bars))).toBe(false);
    }
  });

  it('keeps the label of a bus clear of the label placed before it, and of a chain that is drawn out', () => {
    // Two buses on one spot of the diagram, one a little lower.
    const first = bus('BUS1', 100, 200);
    const second = bus('BUS2', 110, 204);
    const labels = placeBusLabels(
      [first, second],
      layout({ BUS1: bar(), BUS2: bar() }),
      NO_SIZES,
      true,
    );
    expect(overlaps(labels.get('BUS1')!.box, labels.get('BUS2')!.box)).toBe(false);
    const chain = { left: 100, right: 200, top: 206, bottom: 250 };
    const moved = placeBusLabels(
      [first],
      layout({ BUS1: bar() }),
      NO_SIZES,
      true,
      new Map([['generator-1', chain]]),
    ).get('BUS1')!;
    expect(overlaps(moved.box, chain)).toBe(false);
  });
});

describe('placeBusLabels: a name that has no place by its bar', () => {
  const node = bus('BUS1', 100, 200);
  // The devices of the bus fill the rows right under and over its bar, from
  // 70 west of it to 108 east of it, and the connector of the load of
  // another bus comes down 20 west of the bar.
  const under = device('load-PQ', 30, 210, { parentBus: 'BUS1' }, 270);
  const over = device('generator-G', 30, 150, { parentBus: 'BUS1' }, 270);
  const foreign = route([
    [80, 100],
    [80, 300],
  ]);

  it('stands where nothing of another bus is between it and the bar, though a place nearer is clear', () => {
    // Without the connector the nearest clear place is west of the devices.
    const alone = placeBusLabels([node, under, over], layout({ BUS1: bar() }), NO_SIZES, false).get(
      'BUS1',
    )!;
    expect(alone.side).toBe('away');
    expect(alone.box.right).toBeLessThanOrEqual(30);
    // With it, a name there would read as that of the load the connector
    // belongs to: it stands east of the devices, which are its own bus's.
    const drawn = layout({ BUS1: bar() }, { 'stub-load-other': foreign });
    const label = placeBusLabels([node, under, over], drawn, NO_SIZES, false).get('BUS1')!;
    expect(label.side).toBe('away');
    expect(label.box.left).toBeGreaterThanOrEqual(300);
    // The fence of connectors in the test above leaves no place with a clear
    // way to the bar, and the nearest clear place is taken all the same.
  });
});

describe('placeBusLabels: a label that stands over its bar', () => {
  // A symbol all along under the bar of the bus: its label stands over the
  // bar, 4 from it.
  const node = bus('BUS2', 100, 200);
  const below = device('load-PQ', 0, 210, {}, 300);

  it('does not stand right under the bar of another bus, where the label of that bus would hang', () => {
    // The bar of bus 1 a row over it: the label would stand 2 under it.
    const upper = bus('BUS1', 60, 148);
    const drawn = layout({ BUS1: bar(), BUS2: bar() });
    const label = placeBusLabels([upper, node, below], drawn, NO_SIZES, true).get('BUS2')!;
    const underUpper =
      label.box.top < 200 &&
      label.box.top - 154 < 8 &&
      label.box.left < 152 &&
      label.box.right > 60;
    expect(underUpper).toBe(false);
    expect(overlaps(label.box, boxOnDiagram(below, NO_SIZES, drawn.bars))).toBe(false);
    // The label of bus 1 hangs under its own bar, where it is.
    expect(placeBusLabels([upper, node, below], drawn, NO_SIZES, true).get('BUS1')!.side).toBe(
      'below',
    );
  });

  it('stands over its bar where the bar of the other bus is further up', () => {
    const upper = bus('BUS1', 60, 100);
    const drawn = layout({ BUS1: bar(), BUS2: bar() });
    const label = placeBusLabels([upper, node, below], drawn, NO_SIZES, false).get('BUS2')!;
    expect(label.side).toBe('above');
    expect(label.box.bottom).toBe(196);
  });
});

describe('the limit mark of a generator', () => {
  it('takes the top right corner of the symbol, and reaches a little out of it', () => {
    const generator = device('generator-G', 100, 200, {}, 85);
    expect(limitMarkerBox(generator, NO_SIZES)).toEqual({
      left: 185 - 6,
      right: 185 + 2,
      top: 200 - 2,
      bottom: 200 + 6,
    });
    // By the size the browser measured, where there is one.
    const sizes = new Map([['generator-G', { width: 100, height: 41 }]]);
    expect(limitMarkerBox(generator, sizes)!.right).toBe(202);
    expect(limitMarkerBox(device('load-PQ', 100, 200), NO_SIZES)).toBeNull();
    expect(limitMarkerBox(bus('BUS1', 0, 0), NO_SIZES)).toBeNull();
  });

  it('is kept clear of by the label of a bus', () => {
    // A generator of another bus under the bar, clear of where the label
    // hangs by a pixel either way: only its mark reaches into it.
    const node = bus('BUS1', 100, 200);
    const generator = device('generator-G', 76, 247);
    const drawn = layout({ BUS1: bar() });
    const alone = placeBusLabels([node], drawn, NO_SIZES, true).get('BUS1')!;
    const marker = limitMarkerBox(generator, NO_SIZES)!;
    expect(overlaps(alone.box, boxOnDiagram(generator, NO_SIZES, drawn.bars))).toBe(false);
    expect(overlaps(alone.box, marker)).toBe(true);
    const label = placeBusLabels([node, generator], drawn, NO_SIZES, true).get('BUS1')!;
    expect(overlaps(label.box, marker)).toBe(false);
  });

  it('is kept clear of by the readout of the device beside it', () => {
    // A load right of a generator, both under their bar: the readout of
    // the load stands left of its connector only while that keeps it off
    // the mark on the corner of the generator.
    const node = bus('BUS1', 0, 0);
    const generator = device('generator-G', 0, 73, { valueSide: 'above' });
    const load = device('load-PQ', 110, 50, { valueSide: 'above' });
    const drawn = layout(
      { BUS1: bar([], 0, 200) },
      {
        'stub-generator-G': route(
          [
            [20, 73],
            [20, 3],
          ],
          'north',
        ),
        'stub-load-PQ': route(
          [
            [130, 50],
            [130, 3],
          ],
          'north',
        ),
        // A line that takes the place right of the connector of the load.
        'line-x': route([
          [160, 3],
          [160, 300],
        ]),
      },
    );
    const marker = limitMarkerBox(generator, NO_SIZES)!;
    const readouts = placeReadouts([node, generator, load], drawn, NO_SIZES);
    for (const { spot, box } of readouts.values()) {
      if (spot !== 'none') expect(overlaps(box, marker)).toBe(false);
    }
  });
});

describe('busLabelReserve', () => {
  it('keeps places for the label under the bar, over it and beside its tips, as large as it is with values', () => {
    const places = busLabelReserve([bus('BUS1', 100, 200)], layout({ BUS1: bar() }), NO_SIZES);
    expect(places).toHaveLength(1);
    expect(places[0]).toHaveLength(8);
    // Under the middle of the bar: the label, with a little room either side.
    expect(places[0]![0]).toEqual({ left: 146 - 36, right: 146 + 36, top: 206, bottom: 246 });
    for (const place of places[0]!) expect(place.bottom - place.top).toBe(40);
  });

  it('leaves out a place a device connector runs through, or a symbol stands in', () => {
    const load = device('load-PQ', 126, 270);
    const drawn = layout(
      { BUS1: bar([{ x: 46, side: 'south' }]) },
      {
        'stub-load-PQ': route(
          [
            [146, 270],
            [146, 203],
          ],
          'north',
        ),
      },
    );
    const [places] = busLabelReserve([bus('BUS1', 100, 200), load], drawn, NO_SIZES);
    const connector = drawn.routes.get('stub-load-PQ')!.points;
    expect(places!.length).toBeLessThan(8);
    for (const place of places!) expect(crosses(connector, place)).toBe(false);
  });
});

describe('the widths of the values', () => {
  it('takes a readout to be as wide as the longer of its two lines', () => {
    expect(readoutWidth('40.0 MW', '30.4 MVAr')).toBe(Math.ceil(5.4 * 9 + 8));
    expect(readoutWidth('-1575.0 MW', null)).toBe(62);
  });

  it('takes a flow label to be as wide as its arrow, its flow and its loading', () => {
    // An arrow and the flow, a gap between them.
    expect(flowLabelWidth('50.10 MW', null)).toBe(6 * 9 + 4 + 14);
    // The loading after it, another gap on.
    expect(flowLabelWidth('50.10 MW', '87.3%')).toBe(6 * 14 + 8 + 14);
    // The loading alone, when the labels are hidden and the line is near its rating.
    expect(flowLabelWidth(null, '87.3%')).toBe(6 * 5 + 14);
  });

  it('stands a readout that is narrower where the widest would not fit', () => {
    // A line 62 right of the connector of a load under its bar.
    const nodes = [bus('1', 0, 100), device('load-PQ', 0, 173)];
    const drawn = layout(
      { '1': bar([{ x: 20, side: 'south' }]) },
      {
        'stub-load-PQ': route(
          [
            [20, 173],
            [20, 103],
          ],
          'north',
        ),
        'line-l': route([
          [86, 0],
          [86, 400],
        ]),
      },
    );
    // At its widest (72) the line runs through it on the right; 57 wide it stands there.
    expect(placeReadouts(nodes, drawn, NO_SIZES).get('load-PQ')!.spot).not.toBe('right');
    const narrow = placeReadouts(nodes, drawn, NO_SIZES, {
      widths: new Map([['load-PQ', 57]]),
    }).get('load-PQ')!;
    expect(narrow.spot).toBe('right');
    expect(narrow.box.right - narrow.box.left).toBe(57);
  });
});
