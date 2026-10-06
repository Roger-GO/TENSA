/**
 * Where the connectors of the diagram attach and how they run
 * (`connections.ts`): the taps on a bar, which of two gives way and the room
 * they need, the face of a device its connector leaves by, the straight and
 * the right-angled connector and how each keeps out of the other devices,
 * and the two ways a branch is routed (from tap to tap, and through a stored
 * route whose ends are brought onto the bars, with the runs that move along
 * kept off the bars the branch is not connected to).
 *
 * A bus node at `(x, y)` is drawn as a bar from `x` to `x + 92` whose centre
 * line is at `y + 3`; its taps run from the middle of one rounded tip to the
 * middle of the other, `x + 3` to `x + 89`.
 */
import { describe, expect, it } from 'vitest';
import {
  BAR_LENGTH,
  BAR_THICKNESS,
  MIN_BAR_LENGTH,
  SLIDE_CLEARANCE,
  TAP_HOLD,
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

/** A controller badge, 28 square, whose top-left corner is at `(x, y)`. */
function badge(id: string, x: number, y: number): ConnectionNode {
  return { id, type: 'controller', position: { x, y }, initialWidth: 28, initialHeight: 28 };
}

/** Whether the run from `a` to `b` passes through the inside of the box of `node`. */
function passesThrough(a: Point, b: Point, node: ConnectionNode): boolean {
  const left = node.position.x + 1;
  const right = node.position.x + (node.initialWidth ?? 0) - 1;
  const top = node.position.y + 1;
  const bottom = node.position.y + (node.initialHeight ?? 0) - 1;
  // Sampled along the run: the boxes are tens of pixels across.
  const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]));
  for (let i = 0; i <= steps; i += 1) {
    const t = steps === 0 ? 0 : i / steps;
    const x = a[0] + t * (b[0] - a[0]);
    const y = a[1] + t * (b[1] - a[1]);
    if (x > left && x < right && y > top && y < bottom) return true;
  }
  return false;
}

/** Every device connector that runs through a device or badge other than its own, as text. */
function connectorsThroughSymbols(
  nodes: readonly ConnectionNode[],
  routes: ReadonlyMap<string, { points: Point[] }>,
): string[] {
  const found: string[] = [];
  for (const [id, route] of routes) {
    if (!id.startsWith('stub-')) continue;
    for (const node of nodes) {
      if (node.type === 'bus' || `stub-${node.id}` === id) continue;
      const hit = route.points.some(
        (p, i) => i > 0 && passesThrough(route.points[i - 1]!, p, node),
      );
      if (hit) found.push(`${id} runs through ${node.id}`);
    }
  }
  return found;
}

/** Every pair of taps of `bars` that is too close, as text: on one face, or across the two. */
function crowdedTaps(
  bars: ReadonlyMap<string, { taps: { x: number; side: string }[] }>,
  /** How much less than a spacing still counts as one: half a pixel, as the pass has it. */
  slack = 0.5,
): string[] {
  const found: string[] = [];
  for (const [id, bar] of bars) {
    const face = (side: string): number[] =>
      bar.taps.filter((tap) => tap.side === side).map((tap) => tap.x);
    for (const side of ['north', 'south']) {
      const taps = face(side);
      for (let i = 1; i < taps.length; i += 1) {
        if (taps[i]! - taps[i - 1]! < TAP_SPACING - slack - 1e-9) {
          found.push(`bus ${id} ${side}: ${taps[i - 1]} and ${taps[i]}`);
        }
      }
    }
    for (const above of face('north')) {
      for (const below of face('south')) {
        const apart = Math.abs(above - below);
        if (apart > slack && apart < TAP_SPACING - slack - 1e-9) {
          found.push(`bus ${id}: ${above} above and ${below} below`);
        }
      }
    }
  }
  return found;
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

  it('spreads two that ask for spots too close about the middle of what they asked for', () => {
    expect(spreadTaps([{ desired: 44 }, { desired: 48 }], 3, 89)).toEqual([39, 53]);
  });

  it('gives one of several that ask for the very same spot that spot, and the others whole spacings from it', () => {
    // Not half a spacing either side: whatever asks for 46 on the other face
    // of the bar then stands in line with one of these, however many it is.
    expect(spreadTaps([{ desired: 46 }, { desired: 46 }], 3, 89)).toEqual([46, 60]);
    expect(spreadTaps([{ desired: 46 }, { desired: 46 }, { desired: 46 }], 3, 89)).toEqual([
      32, 46, 60,
    ]);
    expect(
      spreadTaps(
        Array.from({ length: 4 }, () => ({ desired: 46 })),
        3,
        89,
      ),
    ).toEqual([32, 46, 60, 74]);
    // Of those in one spot, the ones that hold it most are the ones counted.
    const { route, straight } = TAP_HOLD;
    expect(
      spreadTaps(
        [
          { desired: 46, hold: route },
          { desired: 46, hold: straight },
          { desired: 46, hold: straight },
          { desired: 46, hold: route },
        ],
        3,
        89,
      ),
    ).toEqual([32, 46, 60, 74]);
    expect(
      spreadTaps(
        [
          { desired: 46, hold: route },
          { desired: 46, hold: route },
          { desired: 46, hold: straight },
        ],
        3,
        89,
      ),
    ).toEqual([18, 32, 46]);
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

  it('leaves a tap that holds its place where it is and makes the others give way', () => {
    expect(spreadTaps([{ desired: 30, hold: TAP_HOLD.route }, { desired: 30 }], 3, 89)).toEqual([
      30, 44,
    ]);
    expect(spreadTaps([{ desired: 30 }, { desired: 30, hold: TAP_HOLD.route }], 3, 89)).toEqual([
      16, 30,
    ]);
  });

  it('gives way to the one that holds more firmly, of two that both hold', () => {
    const { route, square, straight } = TAP_HOLD;
    expect(route).toBeLessThan(square);
    expect(square).toBeLessThan(straight);
    // The end of a bent route moves aside for a device that drops square...
    expect(
      spreadTaps(
        [
          { desired: 30, hold: route },
          { desired: 30, hold: square },
        ],
        3,
        89,
      ),
    ).toEqual([16, 30]);
    // ...and the device for the end of a route that runs straight on.
    expect(
      spreadTaps(
        [
          { desired: 30, hold: straight },
          { desired: 30, hold: square },
        ],
        3,
        89,
      ),
    ).toEqual([30, 44]);
    // Of three in one place the one that holds most stays, between the others.
    expect(
      spreadTaps(
        [
          { desired: 46, hold: route },
          { desired: 46, hold: straight },
          { desired: 46, hold: route },
        ],
        3,
        89,
      ),
    ).toEqual([32, 46, 60]);
  });

  it('shares the move between two that hold alike', () => {
    expect(
      spreadTaps(
        [
          { desired: 44, hold: TAP_HOLD.square },
          { desired: 48, hold: TAP_HOLD.square },
        ],
        3,
        89,
      ),
    ).toEqual([39, 53]);
  });

  it('lets a tap that holds its place stay outside the span', () => {
    expect(spreadTaps([{ desired: -20, hold: TAP_HOLD.route }, { desired: 46 }], 3, 89)).toEqual([
      -20, 46,
    ]);
  });

  it('moves a tap at the tip out past it for one that holds its place a little way in', () => {
    // The first asks for the tip (3), the second holds 12: the first makes
    // room on the outside, where the bar will grow to meet it.
    expect(spreadTaps([{ desired: 3 }, { desired: 12, hold: TAP_HOLD.square }], 3, 89)).toEqual([
      -2, 12,
    ]);
    expect(spreadTaps([{ desired: 80, hold: TAP_HOLD.square }, { desired: 89 }], 3, 89)).toEqual([
      80, 94,
    ]);
  });

  it('gives the place to another of several that ask for it alike, where that leaves none up against something', () => {
    // Four at 46, and the third cannot stand to the right of it. With the
    // second on the place the third would stand at 60; with the third on
    // it, they stand one spacing further left and nothing is in the way.
    const third = { desired: 46, blocked: (x: number) => x > 50 };
    const four = [{ desired: 46 }, { desired: 46 }, third, { desired: 46 }];
    expect(spreadTaps(four, 3, 89)).toEqual([18, 32, 46, 60]);
    // The one in the middle keeps the place when that is as good as any other.
    const nowhere = { desired: 46, blocked: () => true };
    expect(spreadTaps([{ desired: 46 }, { desired: 46 }, nowhere, { desired: 46 }], 3, 89)).toEqual(
      [32, 46, 60, 74],
    );
    expect(spreadTaps([{ desired: 46 }, { desired: 46, blocked: () => false }], 3, 89)).toEqual([
      46, 60,
    ]);
  });

  it('takes the way to part them that leaves the fewest up against something', () => {
    // The first cannot stand left of 40 and the last cannot stand right of
    // 50. Two of the four ways leave both in the way and two leave one; of
    // those, the first tried is the one where the first of them has the place.
    const four = [
      { desired: 46, blocked: (x: number) => x < 40 },
      { desired: 46 },
      { desired: 46 },
      { desired: 46, blocked: (x: number) => x > 50 },
    ];
    expect(spreadTaps(four, 3, 89)).toEqual([46, 60, 74, 88]);
  });

  it('parts them another way only within the span, and only where they hold the place alike', () => {
    // The second cannot stand right of 10, but the first cannot be moved
    // left of the tip to make room for it there.
    const second = { desired: 5, blocked: (x: number) => x > 10 };
    expect(spreadTaps([{ desired: 5 }, second], 3, 89)).toEqual([5, 19]);
    // A route that runs straight on has the place before the two that
    // turn, whatever is in the way of those.
    const { route, straight } = TAP_HOLD;
    expect(
      spreadTaps(
        [
          { desired: 46, hold: route },
          { desired: 46, hold: straight },
          { desired: 46, hold: route, blocked: (x: number) => x > 50 },
        ],
        3,
        89,
      ),
    ).toEqual([32, 46, 60]);
    // One that asks for a place of its own is not moved for being in the way there.
    expect(spreadTaps([{ desired: 30, blocked: () => true }, { desired: 60 }], 3, 89)).toEqual([
      30, 60,
    ]);
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
    expect(taps).toEqual([46, 60]);
    // The one further from the bar drops square; the nearer lands beside it.
    expect(routes.get('stub-load-B')!.points[1]).toEqual([46, 103]);
    expect(routes.get('stub-load-A')!.points[1]).toEqual([60, 103]);
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

  it('drops square from a device whose box stands over a tip of the bar, which grows to reach under it', () => {
    // The box reaches from 80 to 120 over the tip at 92.
    const { routes, bars } = layoutConnections(
      [bus('1', 0, 100), device('load-A', 100, 50)],
      [stub('load-A', '1')],
    );
    expect(routes.get('stub-load-A')!.points).toEqual([
      [100, 70],
      [100, 103],
    ]);
    expect(bars.get('1')).toEqual({ start: 0, end: 103, taps: [{ x: 100, side: 'north' }] });
    // One pixel further and the box is clear of the bar: the tip, and a bar of its own length.
    const past = layoutConnections(
      [bus('1', 0, 100), device('load-A', 113, 50)],
      [stub('load-A', '1')],
    );
    expect(past.routes.get('stub-load-A')!.points[1]).toEqual([89, 103]);
    expect(past.bars.get('1')).toMatchObject({ start: 0, end: 92 });
  });

  it('keeps a spacing between a tap past the tip and the end a branch runs into', () => {
    const { routes, bars } = layoutConnections(
      [bus('1', 0, 100), bus('2', 300, 100), device('load-A', 100, 50)],
      [line('line-L', '1', '2'), stub('load-A', '1')],
    );
    expect(routes.get('stub-load-A')!.points[1]).toEqual([100, 103]);
    // The line runs into the east end, which has moved out to stay a spacing clear.
    expect(routes.get('line-L')!.points[0]).toEqual([100 + TAP_SPACING, 103]);
    expect(bars.get('1')!.end).toBe(100 + TAP_SPACING + TAP_INSET);
  });

  it('keeps the tap of a device over the bar square when one past the tip lands beside it', () => {
    // `over` stands over the bar 10 from its tip, `past` beyond that tip: the
    // tap of `past` moves out, onto a bar that grows to hold it.
    const { routes, bars } = layoutConnections(
      [bus('1', 0, 100), device('load-over', 13, 50), device('load-past', -35, 50)],
      [stub('load-over', '1'), stub('load-past', '1')],
    );
    expect(routes.get('stub-load-over')!.points).toEqual([
      [13, 70],
      [13, 103],
    ]);
    expect(routes.get('stub-load-past')!.points[1]).toEqual([13 - TAP_SPACING, 103]);
    expect(bars.get('1')).toMatchObject({ start: 13 - TAP_SPACING - TAP_INSET, end: 92 });
  });

  it('gives the end of a bar to the nearer to level of two devices, and a face to the other', () => {
    const { routes, bars } = layoutConnections(
      [bus('1', 0, 100), device('load-near', 150, 105), device('load-far', 220, 110)],
      [stub('load-far', '1'), stub('load-near', '1')],
    );
    expect(routes.get('stub-load-near')!.targetSide).toBe('east');
    // A spacing in from the end the first runs into.
    expect(routes.get('stub-load-far')).toMatchObject({ sourceSide: 'west', targetSide: 'south' });
    expect(bars.get('1')!.taps).toEqual([
      { x: 89 - TAP_SPACING, side: 'south' },
      { x: 89, side: 'east' },
    ]);
  });

  it('makes room for an end a connection runs into when a face is full', () => {
    // Seven taps fill a face of the default bar. With the east end taken the
    // bar is a spacing longer, and the last tap of the face a spacing from it.
    const past = Array.from({ length: 7 }, (_, i) => device(`load-${i}`, -100, 50 - 50 * i));
    const { bars } = layoutConnections(
      [bus('1', 0, 100), ...past, device('load-E', 150, 105)],
      [...past.map((d) => stub(d.id, '1')), stub('load-E', '1')],
    );
    const bar = bars.get('1')!;
    expect(bar.end - bar.start).toBe(barLengthFor(7) + TAP_SPACING);
    expect(bar.start + bar.end).toBe(BAR_LENGTH);
    expect(bar.taps[0]!.x).toBe(bar.start + TAP_INSET);
    expect(bar.taps[7]).toEqual({ x: bar.end - TAP_INSET, side: 'east' });
    for (let i = 1; i < bar.taps.length; i += 1) {
      expect(bar.taps[i]!.x - bar.taps[i - 1]!.x).toBe(TAP_SPACING);
    }
  });

  it('grows the bar, about its middle, when a face has more taps than fit', () => {
    const devices = Array.from({ length: 9 }, (_, i) => device(`load-${i}`, 46, 50 - 50 * i));
    const { bars } = layoutConnections(
      [bus('1', 0, 100), ...devices],
      devices.map((d) => stub(d.id, '1')),
    );
    const bar = bars.get('1')!;
    expect(bar.end - bar.start).toBe(barLengthFor(9));
    expect(bar.start + bar.end).toBe(BAR_LENGTH);
    const taps = bar.taps.map((tap) => tap.x);
    expect(taps[0]).toBeCloseTo(bar.start + TAP_INSET);
    expect(taps[8]).toBeCloseTo(bar.end - TAP_INSET);
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

  it('never draws a bar shorter than two taps need, whatever length a layout sets', () => {
    const { bars } = layoutConnections(
      [bus('1', 0, 100), device('load-A', 46, 50)],
      [stub('load-A', '1')],
      { barLengths: new Map([['1', 5]]) },
    );
    const bar = bars.get('1')!;
    expect(bar.end - bar.start).toBe(MIN_BAR_LENGTH);
    expect(bar.start + bar.end).toBe(BAR_LENGTH);
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
      // Just clear of the tip: the box starts at 94, the bar ends at 92, and
      // the tap is 25 aside, one short of a run of 6 from a box 20 either way.
      const { routes } = layoutConnections(
        [bus('1', 0, 100), device('load-A', 114, 30)],
        [stub('load-A', '1')],
        elbow,
      );
      expect(routes.get('stub-load-A')).toEqual({
        points: [
          [114, 50],
          [114, 103],
          [89, 103],
        ],
        sourceSide: 'south',
        targetSide: 'north',
      });
      // One pixel further there is room for the run, and it turns over the tap.
      const further = layoutConnections(
        [bus('1', 0, 100), device('load-A', 115, 30)],
        [stub('load-A', '1')],
        elbow,
      );
      expect(further.routes.get('stub-load-A')!.points).toEqual([
        [95, 30],
        [89, 30],
        [89, 103],
      ]);
    });

    it('does not go down to the level of the bar from a device that already reaches it', () => {
      // 12 below the line of the bar, so the box spans it: a run down and
      // along would start inside the box. The connector is drawn straight.
      const { routes } = layoutConnections(
        [bus('1', 0, 100), device('load-A', 114, 115)],
        [stub('load-A', '1')],
        elbow,
      );
      expect(routes.get('stub-load-A')).toEqual({
        points: [
          [94, 115],
          [89, 103],
        ],
        sourceSide: 'west',
        targetSide: 'south',
      });
    });

    it('is drawn straight where neither turn has room', () => {
      // Over the bar, its tap a spacing aside for a second device over the same spot.
      const { routes } = layoutConnections(
        [bus('1', 0, 100), device('load-A', 46, 50), device('load-B', 46, 0)],
        [stub('load-A', '1'), stub('load-B', '1')],
        elbow,
      );
      expect(routes.get('stub-load-A')!.points).toEqual([
        [46, 70],
        [46 + TAP_SPACING, 103],
      ]);
    });
  });
});

describe('layoutConnections: a device connector beside other devices', () => {
  // A row of devices over bar 1 as the diagram places them by default: one
  // over the bar near its west tip, the rest beyond that tip, 8 apart.
  const row = (count: number): ConnectionNode[] =>
    Array.from({ length: count }, (_, i) => device(`load-${i}`, 13 - 48 * i, 50));
  const drawn = (devices: ConnectionNode[], connectorStyle: 'straight' | 'elbow') => {
    const nodes = [bus('1', 0, 100), ...devices];
    return {
      nodes,
      ...layoutConnections(
        nodes,
        devices.map((d) => stub(d.id, '1')),
        { connectorStyle },
      ),
    };
  };

  it('turns at the side of the bar where a turn at the device would run through its neighbour', () => {
    // Sideways out of the second device to over its tap is a run into the
    // first, which stands between the two.
    const { nodes, routes } = drawn(row(2), 'elbow');
    expect(routes.get('stub-load-1')).toEqual({
      points: [
        [-35, 70],
        [-35, 103],
        [-1, 103],
      ],
      sourceSide: 'south',
      targetSide: 'north',
    });
    expect(connectorsThroughSymbols(nodes, routes)).toEqual([]);
  });

  it('still turns at the device where nothing stands in the way', () => {
    const alone = drawn([device('load-1', -35, 50)], 'elbow');
    expect(alone.routes.get('stub-load-1')!.points).toEqual([
      [-15, 50],
      [3, 50],
      [3, 103],
    ]);
  });

  it('keeps out of a controller badge as it does out of a device', () => {
    // The badge sits where the run sideways out of the generator would pass.
    const nodes = [
      bus('1', 0, 100),
      device('generator-G', 150, 50, 'generator'),
      badge('controller-TG', 96, 36),
    ];
    const edges = [stub('generator-G', '1')];
    const turned = layoutConnections(nodes, edges, { connectorStyle: 'elbow' });
    expect(turned.routes.get('stub-generator-G')!.points).toEqual([
      [150, 70],
      [150, 103],
      [89, 103],
    ]);
    // The straight line from the west face would pass through it as well.
    const straight = layoutConnections(nodes, edges);
    expect(straight.routes.get('stub-generator-G')!.points).toEqual([
      [150, 70],
      [89, 103],
    ]);
    expect(connectorsThroughSymbols(nodes, straight.routes)).toEqual([]);
    // Without the badge both leave by the west face.
    const free = layoutConnections(nodes.slice(0, 2), edges);
    expect(free.routes.get('stub-generator-G')!.points).toEqual([
      [130, 50],
      [89, 103],
    ]);
  });

  it('runs along the line of the bar only to the tap at its tip', () => {
    // Three beyond the tip. None can turn at the device, for its neighbour.
    // The outermost has the tap at the tip and turns at the side of the bar;
    // the one between would run over that tap, and is drawn straight.
    const { routes, bars } = drawn(row(3), 'elbow');
    expect(bars.get('1')!.taps.map((tap) => tap.x)).toEqual([-15, -1, 13]);
    expect(routes.get('stub-load-2')!.points).toEqual([
      [-83, 70],
      [-83, 103],
      [-15, 103],
    ]);
    expect(routes.get('stub-load-1')!.points).toEqual([
      [-35, 70],
      [-1, 103],
    ]);
  });

  it('leaves by the face that looks at the bar where the straight line from a side face would enter a neighbour', () => {
    // Six in a row: the outermost are far enough aside that the line from
    // the middle of the box to the tap leaves by a side face.
    const six = Array.from({ length: 6 }, (_, i) => device(`load-${i}`, -98 + 48 * i, 50));
    const { nodes, routes } = drawn(six, 'straight');
    expect(routes.get('stub-load-0')).toMatchObject({ sourceSide: 'south' });
    expect(routes.get('stub-load-0')!.points[0]).toEqual([-98, 70]);
    expect(routes.get('stub-load-5')!.points[0]).toEqual([142, 70]);
    expect(connectorsThroughSymbols(nodes, routes)).toEqual([]);
    // Alone, the same device leaves by the side face.
    const alone = drawn([device('load-0', -98, 50)], 'straight');
    expect(alone.routes.get('stub-load-0')!.sourceSide).toBe('east');
  });

  it.each([2, 4, 6])(
    'runs no connector of a row of %i through another device, in either style',
    (count) => {
      for (const style of ['straight', 'elbow'] as const) {
        const { nodes, routes, bars } = drawn(row(count), style);
        expect(connectorsThroughSymbols(nodes, routes), style).toEqual([]);
        expect(crowdedTaps(bars), style).toEqual([]);
        // The device over the bar drops square whatever stands beside it.
        expect(routes.get('stub-load-0')!.points, style).toEqual([
          [13, 70],
          [13, 103],
        ]);
      }
    },
  );

  it('draws the first way when every way is taken', () => {
    // Boxed in: a neighbour under each way out.
    const nodes = [
      bus('1', 0, 100),
      device('load-A', 150, 30),
      device('load-side', 105, 30),
      device('load-under', 150, 80),
      device('load-between', 118, 75),
    ];
    const { routes } = layoutConnections(nodes, [stub('load-A', '1')], {
      connectorStyle: 'elbow',
    });
    expect(routes.get('stub-load-A')!.points).toEqual([
      [130, 30],
      [89, 30],
      [89, 103],
    ]);
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
    // One through the middle of what the two bars share, the other a spacing beside it.
    expect(routes.get('line-A')!.points).toEqual([
      [46, 3],
      [46, 203],
    ]);
    expect(routes.get('line-B')!.points).toEqual([
      [60, 3],
      [60, 203],
    ]);
  });

  it('shares a face between a branch and a device: the device drops square, the branch a spacing aside', () => {
    // The load hangs under bar 1 at the very spot the line leaves from.
    const { bars, routes } = layoutConnections(
      [bus('1', 0, 0), bus('2', 0, 200), device('load-A', 46, 80)],
      [line('line-L', '1', '2'), stub('load-A', '1')],
    );
    expect(bars.get('1')!.taps).toEqual([
      { x: 46, side: 'south' },
      { x: 46 + TAP_SPACING, side: 'south' },
    ]);
    expect(routes.get('stub-load-A')!.points).toEqual([
      [46, 60],
      [46, 3],
    ]);
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
    expect(points).toEqual([
      [46 + TAP_SPACING, 3],
      [46 + TAP_SPACING, 203],
    ]);
    expect(bars.get('2')!.taps).toEqual([{ x: 46 + TAP_SPACING, side: 'north' }]);
  });

  it('leaves a tap where it is when in line would be within a spacing of another on its face, and steps across', () => {
    // A load under bar 1 moves the line's tap there a spacing aside (60).
    // On bar 2 a load stands at 64, four from that: neither tap of the line
    // can come in line with the other, and the taps of each face stay apart.
    const { routes, bars } = layoutConnections(
      [bus('1', 0, 0), bus('2', 0, 200), device('load-A', 46, 80), device('load-B', 64, 150)],
      [line('line-L', '1', '2'), stub('load-A', '1'), stub('load-B', '2')],
    );
    expect(routes.get('line-L')!.points).toEqual([
      [60, 3],
      [60, 103],
      [46, 103],
      [46, 203],
    ]);
    expect(bars.get('1')!.taps.map((tap) => tap.x)).toEqual([46, 60]);
    expect(bars.get('2')!.taps.map((tap) => tap.x)).toEqual([46, 64]);
    expect(crowdedTaps(bars, 0)).toEqual([]);
  });

  it('does not bring a tap in line past another tap of its face', () => {
    // Bar 1 stands 10 to the left. Its end of the line is at 60, right of
    // the load at 46; the end on bar 2 is at 30, left of the load at 44. In
    // line would be a spacing clear of the load either way, but on the other
    // side of it: the line and the load's connector would change places.
    const { routes, bars } = layoutConnections(
      [bus('1', -10, 0), bus('2', 0, 200), device('load-A', 46, 80), device('load-B', 44, 150)],
      [line('line-L', '1', '2'), stub('load-A', '1'), stub('load-B', '2')],
    );
    expect(routes.get('line-L')!.points).toEqual([
      [60, 3],
      [60, 103],
      [30, 103],
      [30, 203],
    ]);
    // As offsets from each bus: bar 1 starts at -10.
    expect(bars.get('1')!.taps.map((tap) => tap.x)).toEqual([56, 70]);
    expect(bars.get('2')!.taps.map((tap) => tap.x)).toEqual([30, 44]);
  });

  it('does not bring a tap in line to where it would crowd a tap of the other face', () => {
    // The line's end on bar 1 is at 60, beside the load at 46. On bar 2 a
    // load hangs under 53: the end of the line there stands a spacing clear
    // of it, at 39, and 60 would be 7 from it.
    const { routes, bars } = layoutConnections(
      [bus('1', 0, 0), bus('2', 0, 200), device('load-A', 46, 80), device('load-B', 53, 280)],
      [line('line-L', '1', '2'), stub('load-A', '1'), stub('load-B', '2')],
    );
    expect(routes.get('line-L')!.points).toEqual([
      [60, 3],
      [60, 103],
      [39, 103],
      [39, 203],
    ]);
    expect(bars.get('2')!.taps).toEqual([
      { x: 39, side: 'north' },
      { x: 53, side: 'south' },
    ]);
    expect(crowdedTaps(bars, 0)).toEqual([]);
  });

  it('steps across between two bars that do not overlap, where no tap can come in line', () => {
    // Two lines from bar 1 down to bars 2 and 3, which stand side by side
    // under it: each end is at the tip nearest the other bus, and no place
    // on either bar is in line with the tap on the other.
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

  it('keeps a route the layout drew straight where it is, and moves the bent one that shares its port aside', () => {
    // The automatic layout runs every branch of one side of a bus through
    // one port, so the two that leave bar 1 downwards share x = 46. The one
    // that runs straight on to bar 2 keeps it, at both ends; the one that
    // turns right leaves a spacing to its right, and its bend goes with it.
    const third = { x: 200, y: 120 };
    const { routes } = layoutConnections(
      [bus('1', 0, 0), bus('2', 0, 120), bus('3', 200, 120)],
      [
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
      ],
    );
    expect(routes.get('line-A')!.points).toEqual([
      [46, 3],
      [46, 123],
    ]);
    expect(routes.get('line-B')!.points).toEqual([
      [46 + TAP_SPACING, 3],
      [46 + TAP_SPACING, 80],
      [246, 80],
      [246, 123],
    ]);
  });

  it('parts the routes that leave one port without crossing them: by the way each turns, and how soon', () => {
    // Five from the south port of bar 1, given in no order: two turn left,
    // one runs straight on, two turn right. A route that turns nearer the
    // bar lands outside one that turns the same way further down, whose
    // first run it would otherwise have to cross.
    const origin = { x: 0, y: 0 };
    const under = (x: number) => ({ x, y: 200 });
    const turning = (id: string, to: string, turnAt: number, x: number): ConnectionEdge =>
      routedLine(
        id,
        '1',
        to,
        [
          [46, 40],
          [46, turnAt],
          [x + 46, turnAt],
          [x + 46, 200],
        ],
        origin,
        under(x),
      );
    const { routes, bars } = layoutConnections(
      [
        bus('1', 0, 0),
        bus('L1', -300, 200),
        bus('L2', -150, 200),
        bus('S', 0, 200),
        bus('R1', 150, 200),
        bus('R2', 300, 200),
      ],
      [
        turning('line-right-far', 'R2', 100, 300),
        turning('line-left-near', 'L2', 80, -150),
        routedLine(
          'line-straight',
          '1',
          'S',
          [
            [46, 40],
            [46, 200],
          ],
          origin,
          under(0),
        ),
        turning('line-right-near', 'R1', 80, 150),
        turning('line-left-far', 'L1', 100, -300),
      ],
    );
    const leaves = (id: string): number => routes.get(id)!.points[0]![0];
    expect(leaves('line-left-near')).toBe(46 - 2 * TAP_SPACING);
    expect(leaves('line-left-far')).toBe(46 - TAP_SPACING);
    expect(leaves('line-straight')).toBe(46);
    expect(leaves('line-right-far')).toBe(46 + TAP_SPACING);
    expect(leaves('line-right-near')).toBe(46 + 2 * TAP_SPACING);
    expect(bars.get('1')!.taps.map((tap) => tap.x)).toEqual([18, 32, 46, 60, 74]);
    // Each first bend went with its tap, and the far end stayed.
    expect(routes.get('line-left-near')!.points).toEqual([
      [18, 3],
      [18, 80],
      [-104, 80],
      [-104, 203],
    ]);
  });

  it('parts the ends that share a port to the side that keeps their runs off a bar beside them', () => {
    // Two lines come down a corridor 11 left of the bars of buses 2 and 3
    // and land on the north port of bus 4, at -11. Parted to the right, the
    // run of line B (up to its turn under bus 2) would stand at 3, in the
    // tip of the bar of bus 3. They are parted to the left.
    const nodes = [bus('1', 0, 0), bus('2', 0, 120), bus('3', 0, 240), bus('4', -57, 360)];
    const fourth = { x: -57, y: 360 };
    const lineA = routedLine(
      'line-A',
      '1',
      '4',
      [
        [46, 40],
        [46, 50],
        [-11, 50],
        [-11, 360],
      ],
      first,
      fourth,
    );
    const lineB = routedLine(
      'line-B',
      '2',
      '4',
      [
        [46, 160],
        [46, 170],
        [-11, 170],
        [-11, 360],
      ],
      second,
      fourth,
    );
    const { routes, bars } = layoutConnections(nodes, [lineA, lineB]);
    expect(routes.get('line-A')!.points).toEqual([
      [46, 3],
      [46, 50],
      [-11 - TAP_SPACING, 50],
      [-11 - TAP_SPACING, 363],
    ]);
    expect(routes.get('line-B')!.points).toEqual([
      [46, 123],
      [46, 170],
      [-11, 170],
      [-11, 363],
    ]);
    // As offsets from the origin of bus 4, at -57.
    expect(bars.get('4')!.taps.map((tap) => tap.x)).toEqual([46 - TAP_SPACING, 46]);
    // Neither run is nearer than the clearance to the bar of bus 2 or 3, which start at 0.
    for (const id of ['line-A', 'line-B']) {
      expect(0 - routes.get(id)!.points[3]![0]).toBeGreaterThanOrEqual(SLIDE_CLEARANCE);
    }

    // With bus 3 out of the way they are parted as ever: the one that turns
    // further up keeps the place, and the other stands on its right.
    const open = layoutConnections(
      nodes.filter((n) => n.id !== '3'),
      [lineA, lineB],
    );
    expect(open.routes.get('line-A')!.points[3]).toEqual([-11, 363]);
    expect(open.routes.get('line-B')!.points[3]).toEqual([-11 + TAP_SPACING, 363]);
  });

  it('keeps a run where the route has it and steps across to the tap, where the run cannot move clear of a bar', () => {
    // Two lines leave bus 1 downwards through one port, at 46, 11 left of
    // the bar of bus 2. Line S runs straight on to bus 4 and keeps the
    // place. Line B turns right under bus 2 and leaves a spacing to the
    // right, at 60, where its run down would pass through the tip of that
    // bar: the run stays at 46, and the line steps across to it under the
    // label of its own bus.
    const { routes, bars } = layoutConnections(
      [bus('1', 0, 0), bus('2', 57, 120), bus('3', 57, 240), bus('4', 0, 360)],
      [
        routedLine(
          'line-S',
          '1',
          '4',
          [
            [46, 40],
            [46, 360],
          ],
          first,
          { x: 0, y: 360 },
        ),
        routedLine(
          'line-B',
          '1',
          '3',
          [
            [46, 40],
            [46, 170],
            [103, 170],
            [103, 240],
          ],
          first,
          { x: 57, y: 240 },
        ),
      ],
    );
    expect(bars.get('1')!.taps.map((tap) => tap.x)).toEqual([46, 46 + TAP_SPACING]);
    expect(routes.get('line-S')!.points).toEqual([
      [46, 3],
      [46, 363],
    ]);
    expect(routes.get('line-B')!.points).toEqual([
      [60, 3],
      [60, 47],
      [46, 47],
      [46, 170],
      [103, 170],
      [103, 243],
    ]);
  });

  it('moves a run along with its tap where no bar is near, and leaves one that did not move where it is', () => {
    // The same two lines with bus 2 further right: the run of line B is
    // clear at 60, and goes there with its tap.
    const { routes } = layoutConnections(
      [bus('1', 0, 0), bus('2', 60 + SLIDE_CLEARANCE, 120), bus('3', 57, 240), bus('4', 0, 360)],
      [
        routedLine(
          'line-S',
          '1',
          '4',
          [
            [46, 40],
            [46, 360],
          ],
          first,
          { x: 0, y: 360 },
        ),
        routedLine(
          'line-B',
          '1',
          '3',
          [
            [46, 40],
            [46, 170],
            [103, 170],
            [103, 240],
          ],
          first,
          { x: 57, y: 240 },
        ),
      ],
    );
    expect(routes.get('line-B')!.points).toEqual([
      [60, 3],
      [60, 170],
      [103, 170],
      [103, 243],
    ]);
    // A route alone on its port keeps its run where the layout drew it,
    // also 5 from a bar: that is the layout's to decide.
    const alone = layoutConnections(
      [bus('1', 0, 0), bus('2', 51, 120), bus('3', 57, 240)],
      [
        routedLine(
          'line-B',
          '1',
          '3',
          [
            [46, 40],
            [46, 170],
            [103, 170],
            [103, 240],
          ],
          first,
          { x: 57, y: 240 },
        ),
      ],
    );
    expect(alone.routes.get('line-B')!.points).toEqual([
      [46, 3],
      [46, 170],
      [103, 170],
      [103, 243],
    ]);
  });

  it('slides a run that has no room for the step, as before', () => {
    // Line B, as a saved layout holds it, turns 30 under its bar, nearer
    // than a step across needs, and a bus stands close under the right half
    // of bus 1: the run moves with its tap.
    const { routes } = layoutConnections(
      [bus('1', 0, 0), bus('2', 50, 20), bus('3', 200, 120), bus('4', 0, 360)],
      [
        routedLine(
          'line-S',
          '1',
          '4',
          [
            [46, 40],
            [46, 360],
          ],
          first,
          { x: 0, y: 360 },
        ),
        routedLine(
          'line-B',
          '1',
          '3',
          [
            [46, 3],
            [46, 33],
            [246, 33],
            [246, 123],
          ],
          first,
          { x: 200, y: 120 },
        ),
      ],
    );
    expect(routes.get('line-B')!.points).toEqual([
      [60, 3],
      [60, 33],
      [246, 33],
      [246, 123],
    ]);
  });

  it('steps a route the layout drew straight across where its two taps cannot be brought in line', () => {
    // Line A comes straight down onto bar 2 at 46, and line B leaves under
    // it at 53, straight down to bar 3. The two would stand 7 apart on bar
    // 2, so B leaves in line with A. Its tap on bar 3 cannot follow: a load
    // stands a spacing from it there, and in line would be 7 from that.
    const third = { x: 7, y: 240 };
    const { routes, bars } = layoutConnections(
      [bus('1', 0, 0), bus('2', 0, 120), bus('3', 7, 240), device('load-A', 39, 205)],
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
          '2',
          '3',
          [
            [53, 160],
            [53, 240],
          ],
          second,
          third,
        ),
        stub('load-A', '3'),
      ],
    );
    expect(bars.get('2')!.taps).toEqual([
      { x: 46, side: 'north' },
      { x: 46, side: 'south' },
    ]);
    expect(routes.get('line-A')!.points).toEqual([
      [46, 3],
      [46, 123],
    ]);
    expect(routes.get('line-B')!.points).toEqual([
      [46, 123],
      [46, 183],
      [53, 183],
      [53, 243],
    ]);
    // On bar 3, as offsets from its origin at 7: the load at 32, the line at 46.
    expect(bars.get('3')!.taps.map((tap) => tap.x)).toEqual([32, 46]);
  });

  it('grows the bar to a route that leaves it beyond its tip', () => {
    // Routed for a longer bar: the route leaves bar 1 at 110, 18 past its tip.
    const { routes, bars } = layoutConnections(
      [bus('1', 0, 0), bus('2', 60, 120)],
      [
        routedLine(
          'line-L',
          '1',
          '2',
          [
            [110, 40],
            [110, 120],
          ],
          first,
          { x: 60, y: 120 },
        ),
      ],
    );
    expect(routes.get('line-L')!.points).toEqual([
      [110, 3],
      [110, 123],
    ]);
    expect(bars.get('1')).toEqual({ start: 0, end: 113, taps: [{ x: 110, side: 'south' }] });
  });

  it('leaves the first bend where it is when the run after it does not let it slide', () => {
    // After its first run down, line A goes on at an angle: its bend cannot
    // follow the tap, which the straight line B moved a spacing aside.
    const { routes } = layoutConnections(
      [bus('1', 0, 0), bus('2', 200, 200), bus('3', 0, 200)],
      [
        routedLine(
          'line-A',
          '1',
          '2',
          [
            [46, 40],
            [46, 80],
            [120, 140],
            [246, 140],
            [246, 200],
          ],
          first,
          { x: 200, y: 200 },
        ),
        routedLine(
          'line-B',
          '1',
          '3',
          [
            [46, 40],
            [46, 200],
          ],
          first,
          { x: 0, y: 200 },
        ),
      ],
    );
    expect(routes.get('line-A')!.points.slice(0, 3)).toEqual([
      [46 - TAP_SPACING, 3],
      [46, 80],
      [120, 140],
    ]);
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

describe('layoutConnections: the two faces of a bar', () => {
  it('shares a dot between what lands above the bar and what leaves under it at the same place', () => {
    // As the automatic layout routes them: one line comes down onto the
    // middle of the north side of bus 2, two leave the middle of its south
    // side. One of the two keeps the middle and the other stands a spacing
    // beside it, so the line above lands in line with one of them.
    const top = { x: -200, y: 0 };
    const middle = { x: 0, y: 120 };
    const { bars } = layoutConnections(
      [bus('1', -200, 0), bus('2', 0, 120), bus('3', -200, 240), bus('4', 200, 240)],
      [
        routedLine(
          'line-in',
          '1',
          '2',
          [
            [-154, 40],
            [-154, 80],
            [46, 80],
            [46, 120],
          ],
          top,
          middle,
        ),
        routedLine(
          'line-right',
          '2',
          '4',
          [
            [46, 160],
            [46, 200],
            [246, 200],
            [246, 240],
          ],
          middle,
          { x: 200, y: 240 },
        ),
        routedLine(
          'line-left',
          '2',
          '3',
          [
            [46, 160],
            [46, 200],
            [-154, 200],
            [-154, 240],
          ],
          middle,
          { x: -200, y: 240 },
        ),
      ],
    );
    expect(bars.get('2')!.taps).toEqual([
      { x: 46, side: 'north' },
      { x: 46, side: 'south' },
      { x: 60, side: 'south' },
    ]);
  });

  it('brings the end of a route that stands within a spacing of a tap on the other face in line with it', () => {
    // The route comes down onto bar 2 at 46 and a load hangs under 52. The
    // end of the route moves over the load's tap, and its last bend with it.
    const { routes, bars } = layoutConnections(
      [bus('1', -200, 0), bus('2', 0, 120), device('load-A', 52, 200)],
      [
        routedLine(
          'line-in',
          '1',
          '2',
          [
            [-154, 40],
            [-154, 80],
            [46, 80],
            [46, 120],
          ],
          { x: -200, y: 0 },
          { x: 0, y: 120 },
        ),
        stub('load-A', '2'),
      ],
    );
    expect(bars.get('2')!.taps).toEqual([
      { x: 52, side: 'north' },
      { x: 52, side: 'south' },
    ]);
    expect(routes.get('line-in')!.points).toEqual([
      [-154, 3],
      [-154, 80],
      [52, 80],
      [52, 123],
    ]);
    expect(routes.get('stub-load-A')!.points).toEqual([
      [52, 180],
      [52, 123],
    ]);
  });

  it('moves the end of a branch, and leaves a device that drops square where it is', () => {
    // The generator stands over 40, the line under the bar would leave at
    // 46: it leaves at 40 instead, and its other end follows.
    const { routes, bars } = layoutConnections(
      [bus('1', 0, 100), bus('2', 0, 300), device('generator-G', 40, 50, 'generator')],
      [line('line-L', '1', '2'), stub('generator-G', '1')],
    );
    expect(bars.get('1')!.taps).toEqual([
      { x: 40, side: 'south' },
      { x: 40, side: 'north' },
    ]);
    expect(routes.get('stub-generator-G')!.points).toEqual([
      [40, 70],
      [40, 103],
    ]);
    expect(routes.get('line-L')!.points).toEqual([
      [40, 103],
      [40, 303],
    ]);
  });

  it('puts a tap a spacing clear of the other face where it cannot be in line', () => {
    // Two lines under the bar, at 46 and 60, and a generator over 53, half a
    // spacing from each. One comes in line with the generator; the other,
    // which cannot be in the same place, stands a whole spacing from it.
    const { routes, bars } = layoutConnections(
      [bus('1', 0, 100), bus('2', 0, 300), device('generator-G', 53, 50, 'generator')],
      [line('line-A', '1', '2'), line('line-B', '1', '2'), stub('generator-G', '1')],
    );
    expect(bars.get('1')!.taps).toEqual([
      { x: 39, side: 'south' },
      { x: 53, side: 'south' },
      { x: 53, side: 'north' },
    ]);
    expect(routes.get('stub-generator-G')!.points[1]).toEqual([53, 103]);
    // Both still run straight down: their ends on bar 2 followed.
    expect(routes.get('line-A')!.points).toEqual([
      [39, 103],
      [39, 303],
    ]);
    expect(routes.get('line-B')!.points).toEqual([
      [53, 103],
      [53, 303],
    ]);
  });

  it('moves the device where the other face holds a route that runs straight on', () => {
    // A straight route leaves under the bar at 46 and a load stands over 52.
    // The route would have to step across if it moved: the load's tap moves.
    const { routes, bars } = layoutConnections(
      [bus('1', 0, 0), bus('2', 0, 120), device('generator-G', 52, -50, 'generator')],
      [
        routedLine(
          'line-L',
          '1',
          '2',
          [
            [46, 40],
            [46, 120],
          ],
          { x: 0, y: 0 },
          { x: 0, y: 120 },
        ),
        stub('generator-G', '1'),
      ],
    );
    expect(routes.get('line-L')!.points).toEqual([
      [46, 3],
      [46, 123],
    ]);
    expect(bars.get('1')!.taps).toEqual([
      { x: 46, side: 'south' },
      { x: 46, side: 'north' },
    ]);
    expect(routes.get('stub-generator-G')!.points).toEqual([
      [52, -30],
      [46, 3],
    ]);
  });

  it('keeps the taps of every bar apart, on a face and across the two, in drawings of every kind', () => {
    // Drawings made from a seed: a few buses on a grid, devices above and
    // below each, and lines between them, half with a stored route through
    // the middle of the facing faces as the automatic layout leaves them.
    const drawing = (seed: number): { nodes: ConnectionNode[]; edges: ConnectionEdge[] } => {
      let state = seed >>> 0;
      const random = (): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
      };
      const nodes: ConnectionNode[] = [];
      const edges: ConnectionEdge[] = [];
      const at: { x: number; y: number }[] = [];
      const buses = 2 + Math.floor(random() * 5);
      for (let b = 0; b < buses; b += 1) {
        const origin = { x: Math.round(random() * 4) * 76, y: Math.round(random() * 4) * 120 };
        if (at.some((other) => other.x === origin.x && other.y === origin.y)) {
          origin.y += 600 + b * 120;
        }
        at.push(origin);
        nodes.push(bus(`b${b}`, origin.x, origin.y));
        const devices = Math.floor(random() * 5);
        for (let d = 0; d < devices; d += 1) {
          const id = `load-${b}-${d}`;
          nodes.push({
            id,
            type: 'load',
            position: {
              x: origin.x + Math.round((random() - 0.3) * 160),
              y: origin.y + (random() < 0.5 ? -70 : 70) + Math.round((random() - 0.5) * 30),
            },
            initialWidth: 30 + Math.round(random() * 30),
            initialHeight: 41,
          });
          edges.push(stub(id, `b${b}`));
        }
      }
      const lines = 1 + Math.floor(random() * 8);
      for (let l = 0; l < lines; l += 1) {
        const a = Math.floor(random() * buses);
        const pick = Math.floor(random() * buses);
        const b = pick === a ? (a + 1) % buses : pick;
        const [from, to] = [at[a]!, at[b]!];
        if (random() < 0.5 && from.y !== to.y) {
          const down = to.y > from.y;
          const start: Point = [from.x + 46, down ? from.y + 40 : from.y];
          const end: Point = [to.x + 46, down ? to.y : to.y + 40];
          const turn = (start[1] + end[1]) / 2 + Math.round((random() - 0.5) * 20);
          const bends: Point[] =
            from.x === to.x ? [start, end] : [start, [start[0], turn], [end[0], turn], end];
          edges.push(routedLine(`line-${l}`, `b${a}`, `b${b}`, bends, from, to));
        } else {
          edges.push(line(`line-${l}`, `b${a}`, `b${b}`));
        }
      }
      return { nodes, edges };
    };
    for (let seed = 1; seed <= 400; seed += 1) {
      const { nodes, edges } = drawing(seed);
      for (const connectorStyle of ['straight', 'elbow'] as const) {
        const { bars } = layoutConnections(nodes, edges, { connectorStyle });
        expect(crowdedTaps(bars), `seed ${seed}, ${connectorStyle}`).toEqual([]);
        for (const [id, bar] of bars) {
          for (const tap of bar.taps) {
            // On the bar, between the middles of its two tips (half a pixel either way).
            expect(tap.x, `seed ${seed}, bus ${id}`).toBeGreaterThanOrEqual(bar.start + 2.5);
            expect(tap.x, `seed ${seed}, bus ${id}`).toBeLessThanOrEqual(bar.end - 2.5);
          }
        }
      }
    }
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

  it('takes the place to the left of two that are as near the middle', () => {
    // A label 22 wide keeps 15 from a connector. Right of the last one (75)
    // and in the gap between the first two (17) are both 29 from the middle.
    const bar = {
      start: 0,
      end: 92,
      taps: [
        { x: 2, side: 'south' as const },
        { x: 32, side: 'south' as const },
        { x: 60, side: 'south' as const },
      ],
    };
    expect(busLabelOffset(bar, 22)).toBe(17);
  });
});
