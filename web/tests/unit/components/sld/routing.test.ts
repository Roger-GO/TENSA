/**
 * The routes the canvas draws the branches along (`routing.ts`): the one
 * stored for a branch while that holds, and a new one, around everything
 * else, for a branch whose route does not hold any more.
 *
 * A bus node at `(x, y)` is drawn as a bar from `x` to `x + 92` whose centre
 * line is at `y + 3`. Each test is a small diagram built by hand; the
 * example cases are held to the same rule, whole, in `noOverlap.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  TAP_SPACING,
  layoutConnections,
  type ConnectionEdge,
  type Point,
} from '@/components/sld/connections';
import { findOverlaps, type DrawnDiagram } from '@/components/sld/overlapCheck';
import { DRAG_STEPS, LIVE_STEPS, routeDiagram } from '@/components/sld/routing';
import type { TidyNode } from '@/components/sld/tidy';

function bus(id: string, x: number, y: number): TidyNode {
  return { id, type: 'bus', position: { x, y }, data: { name: `B${id}` } };
}

/** A 40 x 40 device whose top-left corner is at `(x, y)`. */
function device(id: string, x: number, y: number): TidyNode {
  return { id, type: 'load', position: { x, y }, initialWidth: 40, initialHeight: 40 };
}

function stub(deviceId: string, busId: string): ConnectionEdge {
  return { id: `stub-${deviceId}`, type: 'stub', source: deviceId, target: busId };
}

function line(id: string, from: string, to: string): ConnectionEdge {
  return { id, type: 'topology', source: from, target: to };
}

/** A line with a route stored for it, made for its buses where `nodes` has them. */
function routed(
  id: string,
  from: string,
  to: string,
  bendPoints: Point[],
  nodes: readonly TidyNode[],
): ConnectionEdge {
  const at = (bus: string) => ({ ...nodes.find((n) => n.id === bus)!.position });
  return {
    id,
    type: 'routed',
    source: from,
    target: to,
    data: { bendPoints, bendAnchors: { source: at(from), target: at(to) } },
  };
}

/** The lines and the bars of what was drawn, as the overlap checker reads them. */
function structure(
  nodes: readonly TidyNode[],
  edges: readonly ConnectionEdge[],
  connections: ReturnType<typeof layoutConnections>,
): DrawnDiagram {
  return {
    lines: edges.map((edge) => ({
      id: edge.id,
      points: connections.routes.get(edge.id)!.points,
      from: edge.source,
      to: edge.target,
    })),
    bars: nodes
      .filter((n) => n.type === 'bus')
      .map((n) => {
        const bar = connections.bars.get(n.id)!;
        return {
          id: n.id,
          left: n.position.x + bar.start,
          right: n.position.x + bar.end,
          y: n.position.y + 3,
        };
      }),
    boxes: nodes
      .filter((n) => n.type !== 'bus')
      .map((n) => ({
        id: n.id,
        kind: 'symbol' as const,
        box: {
          left: n.position.x,
          right: n.position.x + 40,
          top: n.position.y,
          bottom: n.position.y + 40,
        },
      })),
  };
}

describe('routeDiagram: a route that holds', () => {
  const nodes = [bus('1', 0, 0), bus('2', 0, 160)];
  const straight: Point[] = [
    [48, 3],
    [48, 163],
  ];

  it('draws a branch along the route stored for it, and changes nothing', () => {
    const edges = [routed('l', '1', '2', straight, nodes)];
    const result = routeDiagram(nodes, edges);
    expect(result.connections.routes.get('l')!.points).toEqual(straight);
    expect(result.edges).toEqual(edges);
    expect([...result.changed.keys()]).toEqual([]);
    expect(result.unrouted).toEqual([]);
  });

  it('routes a branch that has no route, and answers the route with where its buses stand', () => {
    const result = routeDiagram(nodes, [line('l', '1', '2')]);
    const made = result.changed.get('l')!;
    expect(made.points).toHaveLength(2);
    expect(made.points[0]![0]).toBe(made.points[1]![0]);
    expect(made.anchors).toEqual({ source: { x: 0, y: 0 }, target: { x: 0, y: 160 } });
    // The edges as drawn carry it, so the connection pass draws along it.
    const drawn = result.edges[0]!.data as { bendPoints: Point[]; bendAnchors: unknown };
    expect(drawn.bendPoints).toEqual(made.points);
    expect(drawn.bendAnchors).toEqual(made.anchors);
    expect(result.connections.routes.get('l')!.points).toEqual(made.points);
  });

  it('finds the route it made in place when it is kept as the stored one', () => {
    const first = routeDiagram(nodes, [line('l', '1', '2')]);
    const again = routeDiagram(nodes, first.edges);
    expect([...again.changed.keys()]).toEqual([]);
    expect(again.connections.routes.get('l')).toEqual(first.connections.routes.get('l'));
  });
});

describe('routeDiagram: a route that does not hold any more', () => {
  it('routes the branches of a bus that was moved, and leaves every other where it was', () => {
    const before = [bus('1', 0, 0), bus('2', 0, 160), bus('3', 300, 0), bus('4', 300, 160)];
    const edges = [
      routed(
        'moved',
        '1',
        '2',
        [
          [48, 3],
          [48, 163],
        ],
        before,
      ),
      routed(
        'still',
        '3',
        '4',
        [
          [348, 3],
          [348, 163],
        ],
        before,
      ),
    ];
    // Bus 2 goes a long way to the right, under bus 3 and 4.
    const nodes = before.map((n) => (n.id === '2' ? { ...n, position: { x: 150, y: 320 } } : n));
    const result = routeDiagram(nodes, edges);
    expect([...result.changed.keys()]).toEqual(['moved']);
    expect(result.connections.routes.get('still')!.points).toEqual([
      [348, 3],
      [348, 163],
    ]);
    const made = result.connections.routes.get('moved')!.points;
    expect(made[0]![1]).toBe(3);
    expect(made[made.length - 1]![1]).toBe(323);
    expect(findOverlaps(structure(nodes, result.edges, result.connections))).toEqual([]);
  });

  it('takes a line round a device that was dropped on it', () => {
    const buses = [bus('1', 0, 0), bus('2', 0, 240), bus('3', 200, 100)];
    const edges = [
      routed(
        'l',
        '1',
        '2',
        [
          [48, 3],
          [48, 243],
        ],
        buses,
      ),
      stub('load-x', '3'),
    ];
    // Clear of the line at first: nothing is routed.
    const away = [...buses, device('load-x', 220, 160)];
    expect([...routeDiagram(away, edges).changed.keys()]).toEqual([]);
    // Dropped on it: the line goes round.
    const on = [...buses, device('load-x', 30, 110)];
    const result = routeDiagram(on, edges);
    expect([...result.changed.keys()]).toEqual(['l']);
    expect(findOverlaps(structure(on, result.edges, result.connections))).toEqual([]);
  });

  it('parts two stored routes that lie on each other', () => {
    // As a layout of an earlier version stores them: both along one level
    // run, on top of each other.
    const nodes = [bus('1', 0, 0), bus('3', 300, 0), bus('2', -150, 240), bus('4', -300, 240)];
    const edges = [
      routed(
        'near',
        '1',
        '2',
        [
          [30, 3],
          [30, 120],
          [-104, 120],
          [-104, 243],
        ],
        nodes,
      ),
      routed(
        'far',
        '3',
        '4',
        [
          [346, 3],
          [346, 120],
          [-254, 120],
          [-254, 243],
        ],
        nodes,
      ),
    ];
    const asStored = layoutConnections(nodes, edges);
    expect(findOverlaps(structure(nodes, edges, asStored)).map(({ kind }) => kind)).toContain(
      'line-line',
    );
    const result = routeDiagram(nodes, edges);
    expect(result.unrouted).toEqual([]);
    expect([...result.changed.keys()].sort()).toEqual(['far', 'near']);
    expect(findOverlaps(structure(nodes, result.edges, result.connections))).toEqual([]);
  });

  it('keeps a stored route whose end the connection pass moved along its bar, and says so', () => {
    // A load hangs right where the stored route leaves the bar: the end of
    // the route moves a spacing aside, and the route is still clear.
    const nodes = [bus('1', 0, 0), bus('2', 0, 240), device('load-x', 26, 60)];
    const edges = [
      routed(
        'l',
        '1',
        '2',
        [
          [46, 3],
          [46, 120],
          [20, 120],
          [20, 243],
        ],
        nodes,
      ),
      stub('load-x', '1'),
    ];
    const result = routeDiagram(nodes, edges);
    const drawn = result.connections.routes.get('l')!.points;
    expect(Math.abs(drawn[0]![0] - 46)).toBeGreaterThanOrEqual(TAP_SPACING);
    expect(result.changed.get('l')!.points).toEqual(drawn);
    expect(findOverlaps(structure(nodes, result.edges, result.connections))).toEqual([]);
  });
});

describe('routeDiagram: a branch no way is found for', () => {
  const nodes = [bus('1', 0, 0), bus('2', 300, 200), bus('3', 150, 100)];
  const edges = [line('l', '1', '2')];

  it('is drawn from tap to tap, without a route, and named', () => {
    const result = routeDiagram(nodes, edges, { steps: 0 });
    expect(result.unrouted).toEqual(['l']);
    expect([...result.changed.keys()]).toEqual([]);
    expect((result.edges[0]!.data as { bendPoints?: unknown }).bendPoints).toBeUndefined();
    const points = result.connections.routes.get('l')!.points;
    expect(points[0]![1]).toBe(3);
    expect(points[points.length - 1]![1]).toBe(203);
  });

  it('is drawn as one straight line where the steps of that would run through a symbol', () => {
    // Stepped from tap to tap it turns half way down, where a load stands.
    const withLoad = [bus('1', 0, 0), bus('2', 300, 200), device('load-x', 120, 85)];
    const stepped = layoutConnections(withLoad, edges);
    expect(stepped.routes.get('l')!.points).toHaveLength(4);
    const result = routeDiagram(withLoad, edges, { steps: 0 });
    expect(result.unrouted).toEqual(['l']);
    const points = result.connections.routes.get('l')!.points;
    expect(points).toEqual([
      [89, 3],
      [303, 203],
    ]);
    expect(findOverlaps(structure(withLoad, result.edges, result.connections))).toEqual([]);
  });

  it('takes no route that holds down with it', () => {
    // A stored route crosses where the straight line of the other runs.
    const four = [bus('1', 0, 0), bus('2', 300, 200), bus('3', 300, 0), bus('4', 0, 200)];
    const kept = routed(
      'kept',
      '3',
      '4',
      [
        [348, 3],
        [348, 96],
        [48, 96],
        [48, 203],
      ],
      four,
    );
    const result = routeDiagram(four, [kept, line('l', '1', '2')], { steps: 0 });
    expect(result.unrouted).toEqual(['l']);
    expect(result.connections.routes.get('kept')!.points).toEqual([
      [348, 3],
      [348, 96],
      [48, 96],
      [48, 203],
    ]);
    expect([...result.changed.keys()]).toEqual([]);
  });
});

describe('routeDiagram: how much work it does', () => {
  it('has fewer steps for a pass in a drag than for one at rest', () => {
    expect(DRAG_STEPS).toBeLessThan(LIVE_STEPS);
  });

  it('routes within the steps of a drag what a diagram of a few buses needs', () => {
    const nodes = [bus('1', 0, 0), bus('2', 0, 160), bus('3', 200, 160), bus('4', 200, 0)];
    const edges = [
      line('a', '1', '2'),
      line('b', '1', '3'),
      line('c', '4', '3'),
      line('d', '4', '2'),
    ];
    const result = routeDiagram(nodes, edges, { dragging: true });
    expect(result.unrouted).toEqual([]);
    expect(findOverlaps(structure(nodes, result.edges, result.connections))).toEqual([]);
  });

  it('does not route on a grid larger than a drag allows, and draws those branches straight', () => {
    const nodes = [bus('1', 0, 0), bus('2', 0, 160)];
    const result = routeDiagram(nodes, [line('l', '1', '2')], { dragging: true, gridPoints: 10 });
    expect(result.unrouted).toEqual(['l']);
    expect(result.connections.routes.get('l')!.points).toHaveLength(2);
  });
});
