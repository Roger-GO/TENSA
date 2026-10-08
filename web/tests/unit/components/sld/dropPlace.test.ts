/**
 * Where a bus or device that was dropped comes to stand (`dropPlace.ts`):
 * where it was dropped while that is on nothing, and in the nearest free
 * place otherwise.
 *
 * A bus node at `(x, y)` is drawn as a bar from `x` to `x + 92`, 6 thick.
 * Each test is a small diagram built by hand, with the connectors as the
 * connection pass draws them; the example cases are held to the same rule,
 * whole, in `noOverlap.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  layoutConnections,
  type ConnectionEdge,
  type ConnectionNode,
} from '@/components/sld/connections';
import {
  DROP_CLEARANCE,
  DROP_OWN_TIP_ROOM,
  DROP_PICTURES,
  DROP_PICTURE_APART,
  DROP_REACH,
  DROP_ROW,
  DROP_ROW_GAP,
  DROP_TIP_ROOM,
  clearDrop,
  inTheWay,
} from '@/components/sld/dropPlace';

function bus(id: string, x: number, y: number): ConnectionNode {
  return { id, type: 'bus', position: { x, y } };
}

/** A 40 x 40 device whose top-left corner is at `(x, y)`. */
function device(id: string, x: number, y: number): ConnectionNode {
  return { id, type: 'load', position: { x, y }, initialWidth: 40, initialHeight: 40 };
}

function stub(deviceId: string, busId: string): ConnectionEdge {
  return { id: `stub-${deviceId}`, type: 'stub', source: deviceId, target: busId };
}

/** `nodes` with the node `id`, and for a bus the devices `edges` hang on it, moved by `dx`, `dy`. */
function drop(
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
  id: string,
  dx: number,
  dy: number,
  options: { step?: number } = {},
) {
  const ids = new Set([id, ...edges.filter((e) => e.target === id).map((e) => e.source)]);
  const there = nodes.map((n) =>
    ids.has(n.id) ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n,
  );
  const shift = clearDrop(there, edges, ids, layoutConnections(there, edges), {
    ...options,
    atRest: layoutConnections(nodes, edges),
  });
  const at = (node: string) => {
    const n = there.find((m) => m.id === node)!;
    const moved = ids.has(node) && shift !== null;
    return { x: n.position.x + (moved ? shift.dx : 0), y: n.position.y + (moved ? shift.dy : 0) };
  };
  return { shift, at };
}

describe('clearDrop', () => {
  const nodes = [
    bus('1', 0, 100),
    device('load-A', 26, 30),
    bus('2', 300, 100),
    device('load-B', 326, 30),
  ];
  const edges = [stub('load-A', '1'), stub('load-B', '2')];

  it('leaves what was dropped on free ground where it is', () => {
    expect(drop(nodes, edges, 'load-A', -60, -20).shift).toBeNull();
    expect(drop(nodes, edges, '1', 40, 200).shift).toBeNull();
    // Moved by nothing: the diagram as it stands is clear.
    expect(drop(nodes, edges, '1', 0, 0).shift).toBeNull();
  });

  it('puts a symbol that was dropped on another beside it, a clearance from it', () => {
    // Load A on load B, 10 right of it and 5 below.
    const { shift, at } = drop(nodes, edges, 'load-A', 310, 5);
    expect(shift).toMatchObject({ onto: 'symbol-symbol' });
    const [a, b] = [at('load-A'), { x: 326, y: 30 }];
    const gapX = Math.max(b.x - (a.x + 40), a.x - (b.x + 40));
    const gapY = Math.max(b.y - (a.y + 40), a.y - (b.y + 40));
    expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(DROP_CLEARANCE);
    // The nearest such place: no further than the two boxes are large.
    expect(Math.hypot(shift!.dx, shift!.dy)).toBeLessThanOrEqual(40 + DROP_CLEARANCE + 10);
  });

  it('takes a symbol off a bar, and out of the room past the tip of a bar that is not its own', () => {
    // Load A on the bar of bus 2.
    const on = drop(nodes, edges, 'load-A', 300, 60);
    expect(on.shift).toMatchObject({ onto: 'symbol-bar' });
    const top = on.at('load-A').y;
    expect(top + 40 <= 100 - DROP_CLEARANCE || top >= 106 + DROP_CLEARANCE).toBe(true);

    // Level with the bar of bus 2 and 20 past its east tip: the bar may be
    // drawn out as far as that for a line.
    const beside = drop(nodes, edges, 'load-A', 386, 53);
    expect(beside.shift).toMatchObject({ onto: 'symbol-bar' });
    const now = beside.at('load-A');
    const level = now.y < 106 + DROP_CLEARANCE && now.y + 40 > 100 - DROP_CLEARANCE;
    expect(!level || now.x >= 392 + DROP_TIP_ROOM).toBe(true);
  });

  it('gives a symbol beside the tip of its own bar the room the bar is drawn out by', () => {
    // Level with its own bar, 10 past the east tip.
    const near = drop(nodes, edges, 'load-A', 76, 53);
    expect(near.shift).toMatchObject({ onto: 'symbol-bar' });
    const now = near.at('load-A');
    const level = now.y < 106 + DROP_CLEARANCE && now.y + 40 > 100 - DROP_CLEARANCE;
    expect(!level || now.x >= 92 + DROP_OWN_TIP_ROOM).toBe(true);
    // Further out it stays: a device beside its bar runs into the tip.
    expect(drop(nodes, edges, 'load-A', 74 + DROP_OWN_TIP_ROOM, 53).shift).toBeNull();
  });

  it('keeps two bars that stand one over the other a row apart, and two side by side a gap apart', () => {
    const two = [bus('1', 0, 100), bus('2', 300, 100)];
    // Bus 2 under bus 1, 20 below it.
    const under = drop(two, [], '2', -300, 20);
    expect(under.shift).toMatchObject({ onto: 'bar-bar' });
    const at = under.at('2');
    const sideBySide = at.x >= 92 + DROP_ROW_GAP || at.x + 92 <= -DROP_ROW_GAP;
    expect(sideBySide || Math.abs(at.y - 100) >= DROP_ROW).toBe(true);
    // A whole row below, it stays.
    expect(drop(two, [], '2', -300, DROP_ROW).shift).toBeNull();
    // Level, its tip 4 from the other's.
    const beside = drop(two, [], '2', -204, 0);
    expect(beside.shift).toMatchObject({ onto: 'bar-bar' });
    expect(drop(two, [], '2', -208 + DROP_ROW_GAP, 0).shift).toBeNull();
  });

  it('moves a bus and its devices by the same way', () => {
    // Bus 1 goes to where its load lands on load B.
    const { shift, at } = drop(nodes, edges, '1', 310, 5);
    expect(shift).not.toBeNull();
    // The load still hangs where it hung on its bus.
    expect(at('load-A').x - at('1').x).toBe(26);
    expect(at('load-A').y - at('1').y).toBe(-70);
  });

  it('lets nothing stand between a bus and a device that moved along with it', () => {
    // The load of bus 1 hangs high over its bar, and bus 2 has a load under
    // its own. Bus 1 is dropped so that this load stands between its bar
    // and its own load: clear of both, and in the way of their connector.
    const high = [bus('1', 0, 100), device('load-A', 26, -40), bus('2', 300, 100)];
    const hung = [...high, device('load-C', 326, 220)];
    const all = [stub('load-A', '1'), stub('load-C', '2')];
    expect(drop(high, [stub('load-A', '1')], '1', 300, 200).shift).toBeNull();
    const { shift } = drop(hung, all, '1', 300, 200);
    expect(shift).toMatchObject({ onto: 'connector' });
  });

  it('takes what was dropped on the connector of a device that was not moved off it', () => {
    // Load B hangs 30 over its bar: its connector runs from 70 to 103.
    // A narrow badge of a device is dropped across it.
    const narrow: ConnectionNode = {
      id: 'load-N',
      type: 'load',
      position: { x: 500, y: 300 },
      initialWidth: 12,
      initialHeight: 12,
    };
    const all = [...edges, stub('load-N', '2')];
    const { shift, at } = drop([...nodes, narrow], all, 'load-N', -160, -220);
    expect(shift).toMatchObject({ onto: 'connector' });
    // Clear of the connector at 346.
    const x = at('load-N').x;
    expect(x >= 346 || x + 12 <= 346).toBe(true);
  });

  it('does not leave the bar of another bus between a device and its own bus', () => {
    // Bus 3 stands over bus 1. Load A is dropped on the far side of it.
    const three = [...nodes, bus('3', 0, 20)];
    const { shift, at } = drop(three, edges, 'load-A', 0, -100);
    expect(shift).toMatchObject({ onto: 'bar-between' });
    // It ends up where the straight way down to its bar passes no other bar.
    const now = at('load-A');
    const pastTips = now.x + 20 < 0 - 16 || now.x + 20 > 92 + 16;
    const below = now.y > 26;
    expect(pastTips || below).toBe(true);
  });

  it('looks for the place on the grid the nodes snap to', () => {
    const { shift } = drop(nodes, edges, 'load-A', 310, 5, { step: 16 });
    expect(shift).not.toBeNull();
    expect(Math.abs(shift!.dx % 16)).toBe(0);
    expect(Math.abs(shift!.dy % 16)).toBe(0);
  });

  it('counts a bar as long as it was before the move as well', () => {
    // A line drew the bar of bus 2 out to 240 before the move; while the
    // load is dragged, the bar is drawn at its own length. The load is
    // dropped level with the bar, clear of its tip as it is drawn now.
    const there = nodes.map((n) => (n.id === 'load-A' ? { ...n, position: { x: 196, y: 83 } } : n));
    const connections = layoutConnections(there, edges);
    const moved = new Set(['load-A']);
    expect(clearDrop(there, edges, moved, connections)).toBeNull();
    const before = layoutConnections(nodes, edges);
    const longer = {
      ...before,
      bars: new Map([...before.bars, ['2', { ...before.bars.get('2')!, start: -60 }]]),
    };
    expect(clearDrop(there, edges, moved, connections, { atRest: longer })).toMatchObject({
      onto: 'symbol-bar',
    });
  });

  it('answers nothing where no free place is within reach', () => {
    // Boxed in by a floor of devices far wider than it looks.
    const wall = Array.from({ length: 40 }, (_, i) =>
      Array.from({ length: 40 }, (_, k) => device(`w-${i}-${k}`, -800 + 44 * i, -800 + 44 * k)),
    ).flat();
    const lone = device('load-X', 0, 0);
    const all = [...wall, lone];
    expect(44 * 20).toBeGreaterThan(DROP_REACH);
    expect(clearDrop(all, [], new Set(['load-X']), layoutConnections(all, []))).toBeNull();
  });
});

describe('clearDrop, with a place held to the picture of the diagram', () => {
  const nodes = [
    bus('1', 0, 100),
    device('load-A', 26, 30),
    bus('2', 300, 100),
    device('load-B', 326, 30),
  ];
  const edges = [stub('load-A', '1'), stub('load-B', '2')];
  const moved = new Set(['load-A']);
  /** Load A dropped `dx`, `dy` from where it stood, and what `clearDrop` is asked with. */
  function dropped(dx: number, dy: number) {
    const there = nodes.map((n) =>
      n.id === 'load-A' ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n,
    );
    const options = { atRest: layoutConnections(nodes, edges), back: { dx: -dx, dy: -dy } };
    return { there, connections: layoutConnections(there, edges), options };
  }
  const placeOf = (asked: readonly ConnectionNode[]) =>
    asked.find((n) => n.id === 'load-A')!.position;

  it('asks the picture about the place the nodes were dropped in, and leaves them there where it passes', () => {
    const { there, connections, options } = dropped(-60, -20);
    const asked: { x: number; y: number }[] = [];
    const shift = clearDrop(there, edges, moved, connections, {
      ...options,
      clear: (now) => {
        asked.push(placeOf(now));
        return true;
      },
    });
    expect(shift).toBeNull();
    expect(asked).toEqual([{ x: -34, y: 10 }]);
  });

  it('takes the nearest place that the rules and the picture both pass, and says the picture had no way', () => {
    // Free ground by the rules; the picture passes nothing east of x = -58.
    const { there, connections, options } = dropped(-60, -20);
    const asked: { x: number; y: number }[] = [];
    const shift = clearDrop(there, edges, moved, connections, {
      ...options,
      clear: (now) => {
        asked.push(placeOf(now));
        return placeOf(now).x <= -58;
      },
    });
    expect(shift).toEqual({ dx: -DROP_PICTURE_APART, dy: 0, onto: 'no-way' });
    // No place right next to one the picture refused was asked about.
    for (const [i, a] of asked.entries()) {
      for (const b of asked.slice(0, i)) {
        const refused = b.x > -58;
        const apart = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
        if (refused) expect(apart).toBeGreaterThanOrEqual(DROP_PICTURE_APART);
      }
    }
    expect(asked.length).toBeLessThanOrEqual(DROP_PICTURES);
  });

  it('asks the picture only about a place the rules pass', () => {
    // On load B: the places beside it are asked about, the one on it is not.
    const { there, connections, options } = dropped(310, 5);
    const asked: { x: number; y: number }[] = [];
    const shift = clearDrop(there, edges, moved, connections, {
      ...options,
      clear: (now) => {
        asked.push(placeOf(now));
        return true;
      },
    });
    expect(shift).toMatchObject({ onto: 'symbol-symbol' });
    expect(asked).toEqual([{ x: 336 + shift!.dx, y: 35 + shift!.dy }]);
  });

  it('puts the nodes back where they stood when the picture passes no place it is asked about', () => {
    const { there, connections, options } = dropped(-60, -20);
    let asked = 0;
    const shift = clearDrop(there, edges, moved, connections, {
      ...options,
      clear: () => {
        asked += 1;
        return false;
      },
    });
    expect(shift).toEqual({ dx: 60, dy: 20, onto: 'no-way', back: true });
    expect(asked).toBe(DROP_PICTURES);
    // With fewer pictures to ask, sooner.
    asked = 0;
    const sooner = clearDrop(there, edges, moved, connections, {
      ...options,
      pictures: 3,
      clear: () => {
        asked += 1;
        return false;
      },
    });
    expect(sooner).toMatchObject({ back: true });
    expect(asked).toBe(3);
  });

  it('falls back on the rules where there is nowhere to go back to', () => {
    // On load B, and the picture passes nothing: beside load B, as the
    // rules alone would have it.
    const { there, connections, options } = dropped(310, 5);
    const byRules = clearDrop(there, edges, moved, connections, { atRest: options.atRest });
    const shift = clearDrop(there, edges, moved, connections, {
      atRest: options.atRest,
      clear: () => false,
    });
    expect(shift).toEqual(byRules);
  });
});

describe('a node that was not dragged, held to its box alone', () => {
  const nodes = [
    bus('1', 0, 100),
    device('load-A', 26, 30),
    bus('2', 300, 100),
    device('load-B', 326, 30),
  ];
  const edges = [stub('load-A', '1'), stub('load-B', '2')];
  const moved = new Set(['load-A']);

  it('is not moved for a bar that stands between it and its own bus', () => {
    // Bus 3 stands over bus 1, and load A beyond it: a drop there is
    // refused, but a device that came to stand so is left where it is.
    const there = [...nodes, bus('3', 0, 20)].map((n) =>
      n.id === 'load-A' ? { ...n, position: { x: 26, y: -70 } } : n,
    );
    const connections = layoutConnections(there, edges);
    expect(clearDrop(there, edges, moved, connections)).toMatchObject({ onto: 'bar-between' });
    expect(clearDrop(there, edges, moved, connections, { boxesOnly: true })).toBeNull();
  });

  it('still knows its own bar from another: it may stand as near to it as a drop may', () => {
    // Just clear of its own bar, where it would be too near a bar that is not its own.
    const y = 100 - 40 - DROP_CLEARANCE - 2;
    const there = nodes.map((n) => (n.id === 'load-A' ? { ...n, position: { x: 26, y } } : n));
    const connections = layoutConnections(there, edges);
    expect(clearDrop(there, edges, moved, connections, { boxesOnly: true })).toBeNull();
    // The same box with no connector to that bus is too near it.
    expect(clearDrop(there, [edges[1]!], moved, connections, { boxesOnly: true })).toMatchObject({
      onto: 'symbol-bar',
    });
  });

  it('is still taken off a symbol it stands on', () => {
    const there = nodes.map((n) => (n.id === 'load-A' ? { ...n, position: { x: 330, y: 34 } } : n));
    const connections = layoutConnections(there, edges);
    expect(clearDrop(there, edges, moved, connections, { boxesOnly: true })).toMatchObject({
      onto: 'symbol-symbol',
    });
  });
});

describe('inTheWay', () => {
  const nodes = [bus('1', 0, 100), device('load-A', 26, 30), device('load-B', 326, 30)];
  const edges = [stub('load-A', '1')];

  it('says what a node stands on where it is, by the rules about the boxes, and nothing where it is clear', () => {
    const at = (x: number, y: number) => {
      const there = nodes.map((n) => (n.id === 'load-A' ? { ...n, position: { x, y } } : n));
      return inTheWay(there, edges, new Set(['load-A']), layoutConnections(there, edges));
    };
    expect(at(26, 30)).toBeNull();
    expect(at(330, 34)).toBe('symbol-symbol');
    expect(at(26, 90)).toBe('symbol-bar');
  });

  it('has nothing to say of no node at all', () => {
    expect(inTheWay(nodes, edges, new Set(), layoutConnections(nodes, edges))).toBeNull();
  });
});
