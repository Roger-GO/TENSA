/**
 * Where the connectors of the diagram attach and how they run
 * (`connections.ts`): the taps on a bar and the room they need, the face of
 * a device its connector leaves by, the straight and the right-angled
 * connector, and the two ways a branch is routed (from tap to tap, and
 * through a stored route whose ends are brought onto the bars).
 *
 * A bus node at `(x, y)` is drawn as a bar from `x` to `x + 92` whose centre
 * line is at `y + 3`; its taps run from the middle of one rounded tip to the
 * middle of the other, `x + 3` to `x + 89`.
 */
import { describe, expect, it } from 'vitest';
import {
  BAR_LENGTH,
  BAR_THICKNESS,
  TAP_INSET,
  TAP_SPACING,
  barLengthFor,
  busLabelOffset,
  faceSpan,
  layoutConnections,
  routeMidpoint,
  routePath,
  simplifyRoute,
  spreadTaps,
  stepRoute,
  type ConnectionEdge,
  type ConnectionNode,
  type Point,
} from '@/components/sld/connections';

function bus(id: string, x: number, y: number): ConnectionNode {
  return { id, type: 'bus', position: { x, y } };
}

/** A 40 x 40 device whose middle is at `(cx, cy)`. */
function device(id: string, cx: number, cy: number, type = 'load'): ConnectionNode {
  return {
    id,
    type,
    position: { x: cx - 20, y: cy - 20 },
    initialWidth: 40,
    initialHeight: 40,
  };
}

function stub(deviceId: string, busId: string): ConnectionEdge {
  return { id: `stub-${deviceId}`, type: 'stub', source: deviceId, target: busId };
}

function line(
  id: string,
  from: string,
  to: string,
  data?: Record<string, unknown>,
): ConnectionEdge {
  return { id, type: 'topology', source: from, target: to, data };
}

/** A line that carries a stored route, made for buses at `source` and `target`. */
function routedLine(
  id: string,
  from: string,
  to: string,
  bendPoints: Point[],
  source: { x: number; y: number },
  target: { x: number; y: number },
): ConnectionEdge {
  return line(id, from, to, { bendPoints, bendAnchors: { source, target } });
}

describe('constants', () => {
  it('puts the outermost tap at the middle of the rounded tip', () => {
    expect(BAR_LENGTH).toBe(92);
    expect(TAP_INSET).toBe(BAR_THICKNESS / 2);
  });
});

describe('spreadTaps', () => {
  it('gives each tap what it asks for when they are far enough apart', () => {
    expect(spreadTaps([{ desired: 10 }, { desired: 40 }, { desired: 80 }], 3, 89)).toEqual([
      10, 40, 80,
    ]);
    expect(spreadTaps([], 3, 89)).toEqual([]);
  });

  it('spreads two that ask for the same spot half a spacing either side of it', () => {
    expect(spreadTaps([{ desired: 46 }, { desired: 46 }], 3, 89)).toEqual([39, 53]);
  });

  it('keeps the spacing between every pair of neighbours', () => {
    const taps = spreadTaps(
      [{ desired: 40 }, { desired: 42 }, { desired: 44 }, { desired: 80 }, { desired: 81 }],
      3,
      89,
    );
    for (let i = 1; i < taps.length; i += 1) {
      expect(taps[i]! - taps[i - 1]!).toBeGreaterThanOrEqual(TAP_SPACING - 1e-9);
    }
    // The three that crowd each other stay about the middle of what they asked for.
    expect((taps[0]! + taps[1]! + taps[2]!) / 3).toBeCloseTo(42);
  });

  it('keeps the taps on the bar: a group at a tip runs inwards from it', () => {
    expect(spreadTaps([{ desired: 89 }, { desired: 89 }, { desired: 89 }], 3, 89)).toEqual([
      61, 75, 89,
    ]);
    expect(spreadTaps([{ desired: 3 }, { desired: 3 }], 3, 89)).toEqual([3, 17]);
  });

  it('leaves a pinned tap where it is and makes the others give way', () => {
    const after = spreadTaps([{ desired: 30, pinned: true }, { desired: 30 }], 3, 89);
    expect(after[0]).toBeCloseTo(30, 3);
    expect(after[1]).toBeCloseTo(44, 3);
    const before = spreadTaps([{ desired: 30 }, { desired: 30, pinned: true }], 3, 89);
    expect(before[0]).toBeCloseTo(16, 3);
    expect(before[1]).toBeCloseTo(30, 3);
  });

  it('lets a pinned tap stay outside the span', () => {
    const taps = spreadTaps([{ desired: -20, pinned: true }, { desired: 46 }], 3, 89);
    expect(taps[0]).toBeCloseTo(-20, 3);
    expect(taps[1]).toBeCloseTo(46, 3);
  });

  it('centres taps that do not fit, so they run over both ends alike', () => {
    const taps = spreadTaps(
      Array.from({ length: 9 }, () => ({ desired: 46 })),
      3,
      89,
    );
    expect(taps).toHaveLength(9);
    expect(taps[0]! + taps[8]!).toBeCloseTo(92);
    expect(taps[8]! - taps[0]!).toBeCloseTo(8 * TAP_SPACING);
  });
});

describe('barLengthFor', () => {
  it('is the room the taps of one face need', () => {
    expect(barLengthFor(0)).toBe(2 * TAP_INSET);
    expect(barLengthFor(1)).toBe(2 * TAP_INSET);
    expect(barLengthFor(7)).toBe(6 * TAP_SPACING + 2 * TAP_INSET);
    // Seven taps fit on a bar of the default length; an eighth does not.
    expect(barLengthFor(7)).toBeLessThanOrEqual(BAR_LENGTH);
    expect(barLengthFor(8)).toBeGreaterThan(BAR_LENGTH);
  });
});

describe('simplifyRoute, routePath and routeMidpoint', () => {
  it('drops repeated points and points on a straight run', () => {
    expect(
      simplifyRoute([
        [0, 0],
        [0, 0],
        [0, 10],
        [0, 20],
        [30, 20],
        [30, 20],
      ]),
    ).toEqual([
      [0, 0],
      [0, 20],
      [30, 20],
    ]);
  });

  it('writes the path with straight runs and square corners', () => {
    expect(
      routePath([
        [1, 2],
        [1, 30],
        [40, 30],
      ]),
    ).toBe('M1,2 L1,30 L40,30');
  });

  it('finds the point half way along, and the direction of the run it is on', () => {
    // 20 down, then 60 across: half way (40) is 20 into the second run.
    const mid = routeMidpoint([
      [0, 0],
      [0, 20],
      [60, 20],
    ]);
    expect(mid).toEqual({ x: 20, y: 20, angleDeg: 0 });
    expect(
      routeMidpoint([
        [5, 0],
        [5, 100],
      ]),
    ).toEqual({ x: 5, y: 50, angleDeg: 90 });
    expect(routeMidpoint([[7, 9]])).toEqual({ x: 7, y: 9, angleDeg: 0 });
  });
});

describe('stepRoute', () => {
  it('runs straight between two faces whose taps are in line', () => {
    expect(stepRoute([46, 3], 'south', [46, 203], 'north')).toEqual([
      [46, 3],
      [46, 203],
    ]);
  });

  it('steps across half way between two faces that are not in line', () => {
    expect(stepRoute([89, 3], 'south', [153, 203], 'north')).toEqual([
      [89, 3],
      [89, 103],
      [153, 103],
      [153, 203],
    ]);
    // The same route the other way up.
    expect(stepRoute([153, 203], 'north', [89, 3], 'south')).toEqual([
      [153, 203],
      [153, 103],
      [89, 103],
      [89, 3],
    ]);
  });

  it('does the same, turned, between two ends', () => {
    expect(stepRoute([89, 3], 'east', [303, 3], 'west')).toEqual([
      [89, 3],
      [303, 3],
    ]);
    expect(stepRoute([89, 3], 'east', [303, 53], 'west')).toEqual([
      [89, 3],
      [196, 3],
      [196, 53],
      [303, 53],
    ]);
  });

  it('bridges over two bars it leaves by the same face', () => {
    expect(stepRoute([80, 3], 'north', [310, 3], 'north')).toEqual([
      [80, 3],
      [80, -21],
      [310, -21],
      [310, 3],
    ]);
    // Below, it clears the labels that hang under the bars.
    expect(stepRoute([80, 3], 'south', [310, 13], 'south')).toEqual([
      [80, 3],
      [80, 57],
      [310, 57],
      [310, 13],
    ]);
  });

  it('turns once between a face and an end when the corner lies ahead of both', () => {
    expect(stepRoute([46, 3], 'south', [200, 150], 'west')).toEqual([
      [46, 3],
      [46, 150],
      [200, 150],
    ]);
    expect(stepRoute([200, 150], 'west', [46, 3], 'south')).toEqual([
      [200, 150],
      [46, 150],
      [46, 3],
    ]);
  });

  it('goes round when two faces that look away from each other must meet', () => {
    // `a` leaves downwards but `b` is above it.
    const route = stepRoute([0, 200], 'south', [200, 0], 'north');
    expect(route[0]).toEqual([0, 200]);
    expect(route[route.length - 1]).toEqual([200, 0]);
    for (let i = 1; i < route.length; i += 1) {
      const [a, b] = [route[i - 1]!, route[i]!];
      expect(a[0] === b[0] || a[1] === b[1]).toBe(true);
    }
    // Out of each end the way it leaves.
    expect(route[1]![1]).toBeGreaterThan(200);
    expect(route[route.length - 2]![1]).toBeLessThan(0);
  });
});

describe('layoutConnections: device connectors', () => {
  it('drops the connector of a device above the bar square onto it, from the south face', () => {
    const { routes, bars } = layoutConnections(
      [bus('1', 0, 100), device('load-A', 46, 50)],
      [stub('load-A', '1')],
    );
    expect(routes.get('stub-load-A')).toEqual({
      points: [
        [46, 70],
        [46, 103],
      ],
      sourceSide: 'south',
      targetSide: 'north',
    });
    expect(bars.get('1')).toEqual({ start: 0, end: 92, taps: [{ x: 46, side: 'north' }] });
  });

  it('leaves a device below the bar by its north face', () => {
    const { routes } = layoutConnections(
      [bus('1', 0, 100), device('load-A', 30, 180)],
      [stub('load-A', '1')],
    );
    expect(routes.get('stub-load-A')).toEqual({
      points: [
        [30, 160],
        [30, 103],
      ],
      sourceSide: 'north',
      targetSide: 'south',
    });
  });

  it('lands at the tip of the bar when the device is past it, from the face that looks at the bar', () => {
    // Up and to the right of the bar, more across than up: the west face.
    const { routes, bars } = layoutConnections(
      [bus('1', 0, 100), device('load-A', 150, 50)],
      [stub('load-A', '1')],
    );
    expect(routes.get('stub-load-A')).toEqual({
      points: [
        [130, 50],
        [89, 103],
      ],
      sourceSide: 'west',
      targetSide: 'north',
    });
    // The bar does not follow the device.
    expect(bars.get('1')).toMatchObject({ start: 0, end: 92 });
  });

  it('never leaves by a corner or by the far side, wherever the device is', () => {
    const middle = { x: 46, y: 103 };
    for (let angle = 0; angle < 360; angle += 15) {
      const cx = middle.x + 160 * Math.cos((angle * Math.PI) / 180);
      const cy = middle.y + 160 * Math.sin((angle * Math.PI) / 180);
      const { routes } = layoutConnections(
        [bus('1', 0, 100), device('load-A', cx, cy)],
        [stub('load-A', '1')],
      );
      const route = routes.get('stub-load-A')!;
      const [from, tap] = [route.points[0]!, route.points[route.points.length - 1]!];
      // From the middle of a face: 20 from the middle of the box along one axis.
      const offset = [from[0] - cx, from[1] - cy];
      expect(Math.abs(offset[0]!) + Math.abs(offset[1]!)).toBeCloseTo(20);
      expect(Math.abs(offset[0]!) * Math.abs(offset[1]!)).toBeCloseTo(0);
      // From the near side: the port is closer to the tap than the middle of the box is.
      expect(Math.hypot(tap[0] - from[0], tap[1] - from[1])).toBeLessThan(
        Math.hypot(tap[0] - cx, tap[1] - cy),
      );
      // And onto the bar.
      expect(tap[1]).toBe(103);
      expect(tap[0]).toBeGreaterThanOrEqual(3);
      expect(tap[0]).toBeLessThanOrEqual(89);
    }
  });

  it('runs a device that sits level with the bar straight into its end', () => {
    const { routes, bars } = layoutConnections(
      [bus('1', 0, 100), device('load-A', 150, 105)],
      [stub('load-A', '1')],
    );
    expect(routes.get('stub-load-A')).toEqual({
      points: [
        [130, 105],
        [89, 103],
      ],
      sourceSide: 'west',
      targetSide: 'east',
    });
    expect(bars.get('1')!.taps).toEqual([{ x: 89, side: 'east' }]);
  });

  it('gives two devices over the same spot a tap each, a spacing apart', () => {
    const { routes, bars } = layoutConnections(
      [bus('1', 0, 100), device('load-A', 46, 50), device('load-B', 46, 0)],
      [stub('load-A', '1'), stub('load-B', '1')],
    );
    const taps = bars.get('1')!.taps.map((tap) => tap.x);
    expect(taps).toEqual([39, 53]);
    const landings = ['stub-load-A', 'stub-load-B'].map((id) => routes.get(id)!.points[1]![0]);
    expect(landings.sort()).toEqual([39, 53]);
  });

  it('lets a device above the bar and one below it share a tap', () => {
    const { bars } = layoutConnections(
      [bus('1', 0, 100), device('generator-G', 46, 50, 'generator'), device('load-L', 46, 180)],
      [stub('generator-G', '1'), stub('load-L', '1')],
    );
    expect(bars.get('1')!.taps).toEqual([
      { x: 46, side: 'north' },
      { x: 46, side: 'south' },
    ]);
  });

  it('gives the outer tap to the nearer of two devices past the same tip', () => {
    // Both up and to the left; `near` is closer to the bar's level.
    const { routes } = layoutConnections(
      [bus('1', 0, 100), device('load-near', -60, 50), device('load-far', -60, -40)],
      [stub('load-far', '1'), stub('load-near', '1')],
    );
    expect(routes.get('stub-load-near')!.points[1]).toEqual([3, 103]);
    expect(routes.get('stub-load-far')!.points[1]).toEqual([17, 103]);
  });

  it('grows the bar, about its middle, when a face has more taps than fit', () => {
    const devices = Array.from({ length: 8 }, (_, i) => device(`load-${i}`, 46, 50 - 50 * i));
    const { bars } = layoutConnections(
      [bus('1', 0, 100), ...devices],
      devices.map((d) => stub(d.id, '1')),
    );
    const bar = bars.get('1')!;
    expect(bar.end - bar.start).toBe(barLengthFor(8));
    expect(bar.start + bar.end).toBe(BAR_LENGTH);
    const taps = bar.taps.map((tap) => tap.x);
    expect(taps[0]).toBeCloseTo(bar.start + TAP_INSET);
    expect(taps[7]).toBeCloseTo(bar.end - TAP_INSET);
    for (let i = 1; i < taps.length; i += 1) {
      expect(taps[i]! - taps[i - 1]!).toBeCloseTo(TAP_SPACING);
    }
  });

  it('draws a bar at the length a layout sets, and lands a device over it square', () => {
    const { bars, routes } = layoutConnections(
      [bus('1', 0, 100), device('load-A', 130, 50)],
      [stub('load-A', '1')],
      { barLengths: new Map([['1', 200]]) },
    );
    expect(bars.get('1')).toMatchObject({ start: -54, end: 146 });
    expect(routes.get('stub-load-A')!.points).toEqual([
      [130, 70],
      [130, 103],
    ]);
  });

  it('takes the measured size of a device over its size hint', () => {
    // Measured 60 wide and 30 high: the south port is at the middle of that box.
    const { routes } = layoutConnections(
      [bus('1', 0, 100), device('load-A', 46, 50)],
      [stub('load-A', '1')],
      { sizes: new Map([['load-A', { width: 60, height: 30 }]]) },
    );
    expect(routes.get('stub-load-A')!.points).toEqual([
      [56, 60],
      [56, 103],
    ]);
  });

  describe('with a right angle', () => {
    const elbow = { connectorStyle: 'elbow' as const };

    it('still drops straight down from a device that stands square over its tap', () => {
      const { routes } = layoutConnections(
        [bus('1', 0, 100), device('load-A', 46, 50)],
        [stub('load-A', '1')],
        elbow,
      );
      expect(routes.get('stub-load-A')!.points).toEqual([
        [46, 70],
        [46, 103],
      ]);
    });

    it('runs sideways out of a device past the tip, then square onto the bar', () => {
      const { routes } = layoutConnections(
        [bus('1', 0, 100), device('load-A', 150, 50)],
        [stub('load-A', '1')],
        elbow,
      );
      expect(routes.get('stub-load-A')).toEqual({
        points: [
          [130, 50],
          [89, 50],
          [89, 103],
        ],
        sourceSide: 'west',
        targetSide: 'north',
      });
    });

    it('turns onto a face from a device that is not quite level with the bar', () => {
      // 12 below the bar's line: straight, that is level and runs into the end.
      const nodes = [bus('1', 0, 100), device('load-A', 150, 115)];
      const straight = layoutConnections(nodes, [stub('load-A', '1')]);
      expect(straight.routes.get('stub-load-A')!.targetSide).toBe('east');
      const turned = layoutConnections(nodes, [stub('load-A', '1')], elbow);
      expect(turned.routes.get('stub-load-A')).toEqual({
        points: [
          [130, 115],
          [89, 115],
          [89, 103],
        ],
        sourceSide: 'west',
        targetSide: 'south',
      });
    });

    it('goes down to the bar and along into its tip when the tap is too close for a run sideways', () => {
      // Just past the tip (the middle of the device is at 100, the tip at 92).
      const { routes } = layoutConnections(
        [bus('1', 0, 100), device('load-A', 100, 30)],
        [stub('load-A', '1')],
        elbow,
      );
      expect(routes.get('stub-load-A')).toEqual({
        points: [
          [100, 50],
          [100, 103],
          [89, 103],
        ],
        sourceSide: 'south',
        targetSide: 'north',
      });
    });

    it('is drawn straight where neither turn has room', () => {
      // Over the bar, its tap moved 7 aside by a second device over the same spot.
      const { routes } = layoutConnections(
        [bus('1', 0, 100), device('load-A', 46, 50), device('load-B', 46, 0)],
        [stub('load-A', '1'), stub('load-B', '1')],
        elbow,
      );
      const points = routes.get('stub-load-A')!.points;
      expect(points).toHaveLength(2);
      expect(points[0]).toEqual([46, 70]);
      expect(Math.abs(points[1]![0] - 46)).toBe(7);
    });
  });
});

describe('layoutConnections: branches routed from where their buses sit', () => {
  it('runs straight between two bars that stand one above the other', () => {
    const { routes, bars } = layoutConnections(
      [bus('1', 0, 0), bus('2', 0, 200)],
      [line('line-L', '1', '2')],
    );
    expect(routes.get('line-L')).toEqual({
      points: [
        [46, 3],
        [46, 203],
      ],
      sourceSide: 'south',
      targetSide: 'north',
    });
    expect(bars.get('1')!.taps).toEqual([{ x: 46, side: 'south' }]);
    expect(bars.get('2')!.taps).toEqual([{ x: 46, side: 'north' }]);
  });

  it('runs straight through the part where two offset bars overlap', () => {
    const { routes } = layoutConnections(
      [bus('1', 0, 0), bus('2', 60, 200)],
      [line('line-L', '1', '2')],
    );
    // Bar 1 has taps from 3 to 89, bar 2 from 63 to 149: the middle of 63..89.
    expect(routes.get('line-L')!.points).toEqual([
      [76, 3],
      [76, 203],
    ]);
  });

  it('steps between two bars that do not overlap, from the tips nearest each other', () => {
    const { routes } = layoutConnections(
      [bus('1', 0, 0), bus('2', 150, 200)],
      [line('line-L', '1', '2')],
    );
    expect(routes.get('line-L')!.points).toEqual([
      [89, 3],
      [89, 103],
      [153, 103],
      [153, 203],
    ]);
  });

  it('joins two bars that stand side by side end to end', () => {
    const { routes, bars } = layoutConnections(
      [bus('1', 0, 0), bus('2', 300, 0)],
      [line('line-L', '1', '2')],
    );
    expect(routes.get('line-L')).toEqual({
      points: [
        [89, 3],
        [303, 3],
      ],
      sourceSide: 'east',
      targetSide: 'west',
    });
    expect(bars.get('1')!.taps).toEqual([{ x: 89, side: 'east' }]);
    expect(bars.get('2')!.taps).toEqual([{ x: 3, side: 'west' }]);
  });

  it('bridges a second line between two level bars over them, since an end takes one', () => {
    const { routes } = layoutConnections(
      [bus('1', 0, 0), bus('2', 300, 0)],
      [line('line-A', '1', '2'), line('line-B', '1', '2')],
    );
    expect(routes.get('line-A')!.sourceSide).toBe('east');
    const second = routes.get('line-B')!;
    expect(second.sourceSide).toBe('north');
    expect(second.targetSide).toBe('north');
    // A face tap keeps a spacing from the end the first line runs into.
    expect(second.points).toEqual([
      [75, 3],
      [75, -21],
      [317, -21],
      [317, 3],
    ]);
  });

  it('keeps two parallel lines between stacked bars parallel', () => {
    const { routes } = layoutConnections(
      [bus('1', 0, 0), bus('2', 0, 200)],
      [line('line-A', '1', '2'), line('line-B', '1', '2')],
    );
    expect(routes.get('line-A')!.points).toEqual([
      [39, 3],
      [39, 203],
    ]);
    expect(routes.get('line-B')!.points).toEqual([
      [53, 3],
      [53, 203],
    ]);
  });

  it('shares a face between a branch and a device, a spacing apart', () => {
    // The load hangs under bar 1 at the very spot the line leaves from.
    const { bars } = layoutConnections(
      [bus('1', 0, 0), bus('2', 0, 200), device('load-A', 46, 80)],
      [line('line-L', '1', '2'), stub('load-A', '1')],
    );
    const south = bars
      .get('1')!
      .taps.filter((tap) => tap.side === 'south')
      .map((tap) => tap.x);
    expect(south).toEqual([39, 53]);
  });

  it('gives the end of a bar to a branch before a device that sits level with it', () => {
    const { routes } = layoutConnections(
      [bus('1', 0, 0), bus('2', 300, 0), device('load-A', 150, 5)],
      [line('line-L', '1', '2'), stub('load-A', '1')],
    );
    expect(routes.get('line-L')!.sourceSide).toBe('east');
    // The device lands on a face instead, a spacing in from the end.
    const connector = routes.get('stub-load-A')!;
    expect(connector.targetSide).toBe('south');
    expect(connector.points[connector.points.length - 1]).toEqual([75, 3]);
  });

  it('brings the two taps of a branch in line when one of them is free to move', () => {
    // The load under bar 1 stands where the line leaves it, so the line's tap
    // on bar 1 moves aside. Its tap on bar 2 has that face to itself, and
    // follows: the line still runs straight down.
    const { routes, bars } = layoutConnections(
      [bus('1', 0, 0), bus('2', 0, 200), device('load-A', 46, 80)],
      [line('line-L', '1', '2'), stub('load-A', '1')],
    );
    const points = routes.get('line-L')!.points;
    expect(points).toHaveLength(2);
    expect(points[0]![0]).toBe(points[1]![0]);
    expect(Math.abs(points[0]![0] - 46)).toBe(7);
    expect(bars.get('2')!.taps).toEqual([{ x: points[0]![0], side: 'north' }]);
  });

  it('leaves a tap where it is when moving it would crowd another, and steps across instead', () => {
    // Two lines from bar 1 down to bars 2 and 3, which stand side by side
    // under it: each end has one place it can be, and they are not in line.
    const { routes } = layoutConnections(
      [bus('1', 100, 0), bus('2', 0, 200), bus('3', 200, 200)],
      [line('line-A', '1', '2'), line('line-B', '1', '3')],
    );
    // Bar 1 has taps from 103 to 189, bar 2 from 3 to 89: no overlap.
    expect(routes.get('line-A')!.points).toEqual([
      [103, 3],
      [103, 103],
      [89, 103],
      [89, 203],
    ]);
  });

  it('keeps the run across clear of the line of a bar that stands between the two buses', () => {
    // Half way between bars 1 and 2 is y = 203, the very line of bar 3,
    // which reaches from 120 to 212 under the run from 89 to 303.
    const between = layoutConnections(
      [bus('1', 0, 0), bus('2', 300, 400), bus('3', 120, 200)],
      [line('line-L', '1', '2')],
    );
    expect(between.routes.get('line-L')!.points).toEqual([
      [89, 3],
      [89, 187],
      [303, 187],
      [303, 403],
    ]);
    // A bar at that height that the run does not pass leaves it half way.
    const aside = layoutConnections(
      [bus('1', 0, 0), bus('2', 300, 400), bus('3', 500, 200)],
      [line('line-L', '1', '2')],
    );
    expect(aside.routes.get('line-L')!.points).toEqual([
      [89, 3],
      [89, 203],
      [303, 203],
      [303, 403],
    ]);
  });

  it('ignores an edge whose bus is not drawn', () => {
    const { routes } = layoutConnections([bus('1', 0, 0)], [line('line-L', '1', 'gone')]);
    expect(routes.size).toBe(0);
  });
});

describe('layoutConnections: branches with a stored route', () => {
  // The auto-layout routes for a box around the bus (92 wide, 40 high), so a
  // route ends on the boundary of that box: on the bar's top edge for a
  // north port, 40 below it for a south port, and anywhere down the side
  // for an east or a west port.
  const first = { x: 0, y: 0 };
  const second = { x: 0, y: 120 };

  it('brings an end that hangs under the bar up onto it', () => {
    const { routes, bars } = layoutConnections(
      [bus('1', 0, 0), bus('2', 0, 120)],
      [
        routedLine(
          'line-L',
          '1',
          '2',
          [
            [30, 40],
            [30, 120],
          ],
          first,
          second,
        ),
      ],
    );
    expect(routes.get('line-L')).toEqual({
      points: [
        [30, 3],
        [30, 123],
      ],
      sourceSide: 'south',
      targetSide: 'north',
    });
    expect(bars.get('1')!.taps).toEqual([{ x: 30, side: 'south' }]);
  });

  it('keeps the bends, and moves a run that leaves by an end onto the line of the bar', () => {
    const target = { x: 200, y: 130 };
    const { routes } = layoutConnections(
      [bus('1', 0, 0), bus('2', 200, 130)],
      [
        routedLine(
          'line-L',
          '1',
          '2',
          [
            [92, 20],
            [140, 20],
            [140, 150],
            [200, 150],
          ],
          first,
          target,
        ),
      ],
    );
    expect(routes.get('line-L')).toEqual({
      points: [
        [89, 3],
        [140, 3],
        [140, 133],
        [203, 133],
      ],
      sourceSide: 'east',
      targetSide: 'west',
    });
  });

  it('reads a route that turns while still over the bar as leaving by a face', () => {
    // Routed for a box narrower than the bar: out of its side at 60, down at 75.
    const { routes } = layoutConnections(
      [bus('1', 0, 0), bus('2', 0, 120)],
      [
        routedLine(
          'line-L',
          '1',
          '2',
          [
            [60, 20],
            [75, 20],
            [75, 120],
          ],
          first,
          second,
        ),
      ],
    );
    expect(routes.get('line-L')).toEqual({
      points: [
        [75, 3],
        [75, 123],
      ],
      sourceSide: 'south',
      targetSide: 'north',
    });
  });

  it('straightens a route the layout drew straight when the taps at its two ends were spread apart', () => {
    // The automatic layout runs every branch of one side of a bus through
    // one port, so the two that leave bar 1 downwards share x = 46. On bar 1
    // they are spread a spacing apart; bar 2 has only the one, which follows
    // it, so the route stays the straight line it was.
    const third = { x: 200, y: 120 };
    const { routes } = layoutConnections(
      [bus('1', 0, 0), bus('2', 0, 120), bus('3', 200, 120)],
      [
        routedLine(
          'line-A',
          '1',
          '2',
          [
            [46, 40],
            [46, 120],
          ],
          first,
          second,
        ),
        routedLine(
          'line-B',
          '1',
          '3',
          [
            [46, 40],
            [46, 80],
            [246, 80],
            [246, 120],
          ],
          first,
          third,
        ),
      ],
    );
    const straight = routes.get('line-A')!.points;
    expect(straight).toHaveLength(2);
    expect(straight[0]![0]).toBe(straight[1]![0]);
    const bent = routes.get('line-B')!.points;
    // The two leave bar 1 a spacing apart, and the bend of the second slid with its tap.
    expect(Math.abs(bent[0]![0] - straight[0]![0])).toBeCloseTo(TAP_SPACING, 3);
    expect(bent[1]![0]).toBe(bent[0]![0]);
    expect(bent[bent.length - 1]).toEqual([246, 123]);
  });

  it('holds its tap against a device that wants the same spot', () => {
    const { routes } = layoutConnections(
      [bus('1', 0, 0), bus('2', 0, 120), device('load-A', 30, 70)],
      [
        routedLine(
          'line-L',
          '1',
          '2',
          [
            [30, 40],
            [30, 120],
          ],
          first,
          second,
        ),
        stub('load-A', '1'),
      ],
    );
    expect(routes.get('line-L')!.points[0]![0]).toBeCloseTo(30, 3);
    // The device's tap gives way by a spacing.
    const connector = routes.get('stub-load-A')!;
    expect(connector.points[connector.points.length - 1]![0]).toBeCloseTo(44, 3);
  });

  it('routes the branch from tap to tap once a bus has moved from where the route was made', () => {
    const edge = routedLine(
      'line-L',
      '1',
      '2',
      [
        [30, 40],
        [30, 120],
      ],
      first,
      second,
    );
    // Bus 2 was dragged 100 to the right.
    const { routes } = layoutConnections([bus('1', 0, 0), bus('2', 100, 120)], [edge]);
    expect(routes.get('line-L')!.points).toEqual([
      [89, 3],
      [89, 63],
      [103, 63],
      [103, 123],
    ]);
  });

  it('keeps a branch that runs into an end clear of one routed from the taps', () => {
    // The stored route holds the east end of bar 1; the second line to the
    // same side has to take the faces.
    const target = { x: 300, y: 0 };
    const { routes } = layoutConnections(
      [bus('1', 0, 0), bus('2', 300, 0)],
      [
        routedLine(
          'line-A',
          '1',
          '2',
          [
            [92, 20],
            [300, 20],
          ],
          first,
          target,
        ),
        line('line-B', '1', '2'),
      ],
    );
    expect(routes.get('line-A')).toEqual({
      points: [
        [89, 3],
        [303, 3],
      ],
      sourceSide: 'east',
      targetSide: 'west',
    });
    expect(routes.get('line-B')!.sourceSide).toBe('north');
  });

  it('follows a route drawn at an angle to where it leaves the bar', () => {
    const { routes } = layoutConnections(
      [bus('1', 0, 0), bus('2', 200, 200)],
      [
        routedLine(
          'line-L',
          '1',
          '2',
          [
            [40, 40],
            [120, 110],
            [246, 200],
          ],
          first,
          { x: 200, y: 200 },
        ),
      ],
    );
    const points = routes.get('line-L')!.points;
    // The bend stays; each end lands under where the route heads.
    expect(points).toEqual([
      [89, 3],
      [120, 110],
      [203, 203],
    ]);
  });
});

describe('faceSpan and busLabelOffset', () => {
  it('runs a face from tip to tip, and stops a spacing short of an end that is taken', () => {
    expect(faceSpan({ start: 0, end: 92, taps: [] })).toEqual({ lo: 3, hi: 89 });
    expect(
      faceSpan({
        start: -10,
        end: 102,
        taps: [
          { x: -7, side: 'west' },
          { x: 99, side: 'east' },
        ],
      }),
    ).toEqual({ lo: 7, hi: 85 });
  });

  it('hangs the label under the middle of the bar when nothing comes down there', () => {
    expect(busLabelOffset(undefined, 40)).toBe(46);
    expect(busLabelOffset({ start: 0, end: 92, taps: [{ x: 46, side: 'north' }] }, 40)).toBe(46);
    expect(busLabelOffset({ start: 0, end: 92, taps: [{ x: 10, side: 'south' }] }, 40)).toBe(46);
  });

  it('moves the label beside a connector that comes down through the middle', () => {
    // A label 40 wide keeps 4 clear: its middle is 24 from the connector.
    expect(busLabelOffset({ start: 0, end: 92, taps: [{ x: 46, side: 'south' }] }, 40)).toBe(22);
    expect(busLabelOffset({ start: 0, end: 92, taps: [{ x: 40, side: 'south' }] }, 40)).toBe(64);
  });

  it('uses the gap between two connectors when it is wide enough, and goes outside when not', () => {
    const between = busLabelOffset(
      {
        start: 0,
        end: 92,
        taps: [
          { x: 10, side: 'south' },
          { x: 80, side: 'south' },
        ],
      },
      40,
    );
    expect(between).toBe(46);
    const outside = busLabelOffset(
      {
        start: 0,
        end: 92,
        taps: [
          { x: 30, side: 'south' },
          { x: 60, side: 'south' },
        ],
      },
      40,
    );
    // Beside the outermost connector, on the side nearer the middle of the bar.
    expect(outside).toBe(84);
  });
});
