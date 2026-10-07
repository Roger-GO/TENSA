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
import { routeChecker } from '@/components/sld/routeCheck';

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
