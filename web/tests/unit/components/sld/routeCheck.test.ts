/**
 * What stands in the way of a route that is being drawn by hand
 * (`routeCheck.ts`), on a small diagram built by hand: two buses one above
 * the other with two lines between them, a third bus off to the right with
 * a transformer to it, and a load on the upper bus.
 *
 * A bus node at `(x, y)` is drawn as a bar from `x` to `x + 92` whose centre
 * line is at `y + 3`.
 */
import { describe, expect, it } from 'vitest';
import type { ConnectionEdge, Point } from '@/components/sld/connections';
import type { LabelNode } from '@/components/sld/labels';
import { pictureOf } from '@/components/sld/picture';
import { HAND_CLEARANCE, HAND_LABEL_CLEARANCE, routeChecker } from '@/components/sld/routeCheck';

function bus(id: string, x: number, y: number): LabelNode {
  return { id, type: 'bus', position: { x, y }, data: { name: `BUS${id}` } };
}

interface Anchors {
  source: { x: number; y: number };
  target: { x: number; y: number };
}

function branch(
  id: string,
  type: 'topology' | 'transformer',
  from: string,
  to: string,
  bendPoints: Point[],
  anchors: Anchors,
): ConnectionEdge {
  return {
    id,
    type,
    source: from,
    target: to,
    data: { name: id.split('-')[1], bendPoints, bendAnchors: anchors },
  };
}

const A = { x: 0, y: 0 };
const B = { x: 0, y: 240 };
const C = { x: 240, y: 240 };

/** A load over the bar of A: its box from (60, -80) to (100, -40). */
const LOAD: LabelNode = {
  id: 'load-PQ_1',
  type: 'load',
  position: { x: 60, y: -80 },
  initialWidth: 40,
  initialHeight: 40,
  data: { name: 'PQ_1' },
};

const NODES: LabelNode[] = [bus('1', A.x, A.y), bus('2', B.x, B.y), bus('3', C.x, C.y), LOAD];

const L1: Point[] = [
  [16, 3],
  [16, 243],
];
const L2: Point[] = [
  [48, 3],
  [48, 243],
];
/** Down from bus 1, across to over bus 3, and down onto it. */
const T1: Point[] = [
  [64, 3],
  [64, 120],
  [286, 120],
  [286, 243],
];
const EDGES: ConnectionEdge[] = [
  branch('line-L1', 'topology', '1', '2', L1, { source: A, target: B }),
  branch('line-L2', 'topology', '1', '2', L2, { source: A, target: B }),
  branch('transformer-T1', 'transformer', '1', '3', T1, { source: A, target: C }),
  { id: 'stub-load-PQ_1', type: 'stub', source: 'load-PQ_1', target: '1', data: { name: 'PQ_1' } },
];

function checkerFor(id: string) {
  const picture = pictureOf(NODES, EDGES, { values: false });
  return routeChecker(NODES, picture, EDGES.find((edge) => edge.id === id)!, { values: false });
}

describe('routeChecker', () => {
  it('finds nothing in the way of the route a line has, or of one that is clear', () => {
    const check = checkerFor('line-L1');
    expect(check(L1)).toBeNull();
    // A step to the left, well clear of everything.
    expect(
      check([
        [16, 3],
        [16, 100],
        [-40, 100],
        [-40, 180],
        [16, 180],
        [16, 243],
      ]),
    ).toBeNull();
  });

  it('names the line a route would lie on, run beside, or turn on', () => {
    const check = checkerFor('line-L1');
    expect(
      check([
        [48, 3],
        [48, 243],
      ]),
    ).toBe('it would lie on line L2');
    expect(
      check([
        [16, 3],
        [16, 60],
        [40, 60],
        [40, 180],
        [16, 180],
        [16, 243],
      ]),
    ).toBe('it would run too close beside line L2');
    expect(
      check([
        [16, 3],
        [16, 60],
        [48, 60],
        [48, 180],
        [16, 180],
        [16, 243],
      ]),
    ).toBe('it would end or turn on line L2');
    // Two lines that cross are a crossing, which is no overlap.
    expect(
      check([
        [16, 3],
        [16, 60],
        [80, 60],
        [80, 180],
        [16, 180],
        [16, 243],
      ]),
    ).toBeNull();
  });

  it('keeps the ends of two lines apart on a bar', () => {
    const check = checkerFor('line-L1');
    // At an angle, so that only the two ends are near each other.
    expect(
      check([
        [40, 3],
        [16, 40],
        [16, 243],
      ]),
    ).toBe('its end would be too close to the end of line L2');
  });

  it('names the bar a route would run through, and the end that would leave its own', () => {
    const check = checkerFor('line-L2');
    // Round by the right, at the height of the bar of bus 3.
    expect(
      check([
        [48, 3],
        [48, 60],
        [260, 60],
        [260, 300],
        [48, 300],
        [48, 243],
      ]),
    ).toBe('it would run through or along the bar of bus BUS3');
    expect(
      check([
        [48, 3],
        [48, 60],
        [120, 60],
        [120, 243],
      ]),
    ).toBe('its end would leave the bar of bus BUS2');
  });

  it('names the symbol a route would run through', () => {
    const check = checkerFor('line-L2');
    expect(
      check([
        [48, 3],
        [48, 20],
        [-30, 20],
        [-30, -60],
        [120, -60],
        [120, 100],
        [48, 100],
        [48, 243],
      ]),
    ).toBe('it would run through the symbol of PQ_1');
  });

  it('keeps a route off the label of a bus', () => {
    const picture = pictureOf(NODES, EDGES, { values: false });
    const label = picture.busLabels.get('3')!.box;
    const y = (label.top + label.bottom) / 2;
    const check = routeChecker(NODES, picture, EDGES[1]!, { values: false });
    // Out to the right through where the label of bus 3 stands, and back.
    const through: Point[] = [
      [48, 3],
      [48, 60],
      [label.right + 30, 60],
      [label.right + 30, y],
      [label.left - 30, y],
      [label.left - 30, 200],
      [48, 200],
      [48, 243],
    ];
    expect(check(through)).toBe('it would run through the label of bus BUS3');
  });

  it('keeps the connector of a device out of its own symbol', () => {
    const check = checkerFor('stub-load-PQ_1');
    expect(
      check([
        [80, -40],
        [80, 3],
      ]),
    ).toBeNull();
    // Out of the south face, up through the box, and round to the bar.
    expect(
      check([
        [80, -40],
        [80, -30],
        [70, -30],
        [70, -70],
        [120, -70],
        [120, -20],
        [88, -20],
        [88, 3],
      ]),
    ).toBe('it would run through its own symbol');
  });

  it('keeps the connector of a device off the edge of its own symbol, and has it leave the symbol', () => {
    const check = checkerFor('stub-load-PQ_1');
    // A neck out of the south face, across, and down onto the bar between
    // the ends of the two lines.
    const stepped = (down: number, to = 32): Point[] => [
      [80, -40],
      [80, -40 + down],
      [to, -40 + down],
      [to, 3],
    ];
    expect(check(stepped(12))).toBeNull();
    // The run across right under the symbol reads as its bottom edge.
    expect(check(stepped(4))).toBe('it would run right beside its own symbol');
    // Along the bottom edge itself, through where it started.
    expect(
      check([
        [80, -40],
        [80, -34],
        [70, -34],
        [70, -40],
        [130, -40],
        [130, 3],
      ]),
    ).toBe('it would run right beside its own symbol');
    // Out of the middle of the face and straight along it.
    expect(
      check([
        [80, -40],
        [130, -40],
        [130, 3],
      ]),
    ).toBe('it would run along the edge of its own symbol and not leave it');
  });

  it('refuses a route that folds back on itself', () => {
    const check = checkerFor('line-L2');
    // Down, back up beside itself six apart, and down again.
    expect(
      check([
        [48, 3],
        [48, 150],
        [54, 150],
        [54, 60],
        [60, 60],
        [60, 200],
        [48, 200],
        [48, 243],
      ]),
    ).toBe('it would fold back on itself');
    // A loop that crosses its own first run.
    expect(
      check([
        [48, 3],
        [48, 150],
        [100, 150],
        [100, 60],
        [20, 60],
        [20, 200],
        [48, 200],
        [48, 243],
      ]),
    ).toBe('it would fold back on itself');
    // A step aside as wide as two lines keep apart folds on nothing.
    expect(
      check([
        [48, 3],
        [48, 150],
        [100, 150],
        [100, 200],
        [48, 200],
        [48, 243],
      ]),
    ).toBeNull();
  });

  /** Line L2 taken round the load, whose box is from (60, -80) to (100, -40): over it, `off` clear of its top. */
  const overLoad = (off: number): Point[] => [
    [48, 3],
    [48, 20],
    [-30, 20],
    [-30, -80 - off],
    [120, -80 - off],
    [120, 100],
    [48, 100],
    [48, 243],
  ];
  /** Line L2 taken over the bar of bus 3, whose top is at 240: `off` clear of it. */
  const overBar = (off: number): Point[] => [
    [48, 3],
    [48, 60],
    [320, 60],
    [320, 240 - off],
    [250, 240 - off],
    [250, 200],
    [48, 200],
    [48, 243],
  ];

  it('keeps the room the router keeps to a symbol, and to a bar it does not end on', () => {
    const check = checkerFor('line-L2');
    expect(check(overLoad(HAND_CLEARANCE))).toBeNull();
    expect(check(overLoad(HAND_CLEARANCE - 3))).toBe(
      'it would pass too close to the symbol of PQ_1',
    );
    // Touching the box is not running through it, and is far too near.
    expect(check(overLoad(0))).toBe('it would pass too close to the symbol of PQ_1');
    expect(check(overBar(HAND_CLEARANCE))).toBeNull();
    expect(check(overBar(HAND_CLEARANCE - 1))).toBe(
      'it would pass too close to the bar of bus BUS3',
    );
  });

  it('keeps a little room to the label of a bus it does not end on', () => {
    const picture = pictureOf(NODES, EDGES, { values: false });
    const label = picture.busLabels.get('3')!.box;
    const check = routeChecker(NODES, picture, EDGES[1]!, { values: false });
    /** Round the far tip of the bar of bus 3 and back under its label, `off` clear of it. */
    const under = (off: number): Point[] => [
      [48, 3],
      [48, 60],
      [400, 60],
      [400, label.bottom + off],
      [120, label.bottom + off],
      [120, 200],
      [48, 200],
      [48, 243],
    ];
    expect(check(under(HAND_LABEL_CLEARANCE))).toBeNull();
    expect(check(under(HAND_LABEL_CLEARANCE - 2))).toBe(
      'it would pass too close to the label of bus BUS3',
    );
  });

  it('lets a line that is nearer than that already stay as near, and come no nearer', () => {
    // A layout that came with line L2 five clear of the load: as near as a
    // route the diagram keeps may pass a symbol.
    const edges = EDGES.map((edge) =>
      edge.id === 'line-L2'
        ? branch('line-L2', 'topology', '1', '2', overLoad(5), { source: A, target: B })
        : edge,
    );
    const picture = pictureOf(NODES, edges, { values: false, steps: 0 });
    expect(picture.connections.routes.get('line-L2')!.points).toEqual(overLoad(5));
    const check = routeChecker(NODES, picture, edges[1]!, { values: false });
    expect(check(overLoad(5))).toBeNull();
    // Another run of it moved, with the one by the load where it was.
    expect(check(overLoad(5).map(([x, y]): Point => [x === 120 ? 140 : x, y]))).toBeNull();
    expect(check(overLoad(6))).toBeNull();
    expect(check(overLoad(3))).toBe('it would pass too close to the symbol of PQ_1');
  });

  it('wants a stretch of a transformer where its symbol has room', () => {
    const check = checkerFor('transformer-T1');
    expect(check(T1)).toBeNull();
    // A transformer between the two buses that stand one above the other,
    // and a third line: between two lines 28 apart a line has room, and
    // the symbol of a transformer, 30 across, has none.
    const edges = [
      ...EDGES.slice(0, 2),
      branch(
        'line-L3',
        'topology',
        '1',
        '2',
        [
          [76, 3],
          [76, 243],
        ],
        { source: A, target: B },
      ),
      branch(
        'transformer-T2',
        'transformer',
        '1',
        '2',
        [
          [0, 3],
          [0, 243],
        ],
        { source: A, target: B },
      ),
    ];
    const nodes = NODES.filter((node) => node !== LOAD);
    const picture = pictureOf(nodes, edges, { values: false });
    const between = routeChecker(nodes, picture, edges[3]!, { values: false });
    expect(
      between([
        [62, 3],
        [62, 243],
      ]),
    ).toBe('the symbol of the transformer would have no room on it');
    // A line has room there.
    const line = routeChecker(
      nodes,
      picture,
      { ...edges[3]!, type: 'topology' },
      { values: false },
    );
    expect(
      line([
        [62, 3],
        [62, 243],
      ]),
    ).toBeNull();
  });

  it('does not hold against a line what it was on before it was touched', () => {
    // A layout that came with two lines on each other.
    const edges = EDGES.map((edge) =>
      edge.id === 'line-L2'
        ? branch(
            'line-L2',
            'topology',
            '1',
            '2',
            [
              [16, 3],
              [16, 243],
            ],
            { source: A, target: B },
          )
        : edge,
    );
    // Drawn as stored: the picture is not asked to mend it.
    const picture = pictureOf(NODES, edges, { values: false, steps: 0 });
    const drawn = picture.connections.routes.get('line-L1')!.points;
    const check = routeChecker(NODES, picture, edges[0]!, { values: false });
    expect(check(drawn)).toBeNull();
  });
});
