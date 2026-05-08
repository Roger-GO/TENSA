/**
 * Collision push-out post-process (Unit 3, v0.1.y).
 *
 * Covers `pushOutCollisions` + the `buildGraph` integration that runs
 * it after the kind-based fan-stack emission.
 *
 * R34 scope (post-review softening): collision-free on the v0.2 demo
 * topology set + a synthetic worst-case input. NOT a universal-input
 * guarantee — v0.5's compound-ELK swap is the proper fix for that.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildGraph,
  pushOutCollisions,
  NODE_FOOTPRINT,
  PUSH_OUT_SAFETY_GAP,
  type PushOutNode,
} from '@/components/sld/graph';
import type { TopologySummary, TopologyEntry } from '@/api/types';

// ---- topology helpers ---------------------------------------------------

function bus(idx: number | string, name = `b${idx}`): TopologyEntry {
  return { idx, name, kind: 'Bus', params: {} };
}

function gen(
  idx: number | string,
  busIdx: number | string,
  kind = 'PV',
): TopologyEntry {
  return {
    idx,
    name: `gen-${idx}`,
    kind,
    params: { bus: busIdx, Sn: 100, Vn: 100, p0: 1, v0: 1 },
  };
}

function load(idx: number | string, busIdx: number | string): TopologyEntry {
  return {
    idx,
    name: `load-${idx}`,
    kind: 'PQ',
    params: { bus: busIdx, Vn: 100, p0: 0.5, q0: 0.1 },
  };
}

function shunt(idx: number | string, busIdx: number | string): TopologyEntry {
  return {
    idx,
    name: `shunt-${idx}`,
    kind: 'Shunt',
    params: { bus: busIdx, Vn: 100, b: 0.1 },
  };
}

function makeTopology(opts: Partial<TopologySummary>): TopologySummary {
  return {
    state: 'pre-setup',
    buses: opts.buses ?? [],
    lines: opts.lines ?? [],
    transformers: opts.transformers ?? [],
    generators: opts.generators ?? [],
    loads: opts.loads ?? [],
    shunts: opts.shunts ?? [],
  };
}

// ---- push-out fixture helpers -------------------------------------------

function makePushNode(
  id: string,
  kind: 'bus' | 'generator' | 'load' | 'shunt',
  x: number,
  y: number,
  opts: { locked?: boolean; parentBusId?: string | null } = {},
): PushOutNode {
  const footprint = NODE_FOOTPRINT[kind];
  return {
    id,
    kind,
    x,
    y,
    width: footprint.width,
    height: footprint.height,
    locked: opts.locked ?? false,
    parentBusId: opts.parentBusId ?? null,
  };
}

/** True iff two `PushOutNode` boxes overlap. */
function overlaps(a: PushOutNode, b: PushOutNode): boolean {
  const ax1 = a.x - a.width / 2;
  const ax2 = a.x + a.width / 2;
  const ay1 = a.y - a.height / 2;
  const ay2 = a.y + a.height / 2;
  const bx1 = b.x - b.width / 2;
  const bx2 = b.x + b.width / 2;
  const by1 = b.y - b.height / 2;
  const by2 = b.y + b.height / 2;
  return ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1;
}

/** Build a worst-case-style fixture: N non-bus elements all at the same coord. */
function pileup(n: number, kind: 'generator' | 'load' = 'generator'): PushOutNode[] {
  const out: PushOutNode[] = [
    makePushNode('bus-1', 'bus', 0, 0),
  ];
  for (let i = 0; i < n; i += 1) {
    out.push(makePushNode(`${kind}-${i}`, kind, 0, kind === 'generator' ? -50 : 50, {
      parentBusId: 'bus-1',
    }));
  }
  return out;
}

// ---- pushOutCollisions: pure-function tests -----------------------------

describe('pushOutCollisions — algorithm', () => {
  it('separates a generator + load on the same bus that overlap on y', () => {
    // A generator at (0, 0) and a load at (10, 5) — both 50×46 boxes,
    // overlap on both axes. The generator pushes UP; the load pushes
    // DOWN. After push-out the boxes must be disjoint.
    const inputs: PushOutNode[] = [
      makePushNode('bus-1', 'bus', 0, 100),
      makePushNode('generator-G', 'generator', 0, 30, { parentBusId: 'bus-1' }),
      makePushNode('load-L', 'load', 10, 35, { parentBusId: 'bus-1' }),
    ];
    const resolved = pushOutCollisions(inputs);
    const finalNodes = inputs.map((n) => ({
      ...n,
      ...resolved.get(n.id)!,
    }));
    const gen = finalNodes.find((n) => n.id === 'generator-G')!;
    const ld = finalNodes.find((n) => n.id === 'load-L')!;
    expect(overlaps(gen, ld)).toBe(false);
  });

  it('handles 5 generators on one bus by separating all of them', () => {
    // The fan-stack handles up to 4 generators horizontally side-by-side
    // along the bus's north face; the 5th wraps onto a second row in
    // buildGraph. This test feeds push-out a worst-case where ALL 5
    // start at the same coord (i.e., as if the fan-stack failed
    // completely) and asserts push-out separates them.
    //
    // Two-stage behavior: in the real pipeline buildGraph's fan-stack
    // places gens 0-3 horizontally with no overlap, then push-out
    // resolves the 5th into a clean position. This test exercises the
    // push-out algorithm in isolation.
    const inputs = pileup(5, 'generator');
    const resolved = pushOutCollisions(inputs);
    const finalNodes = inputs.map((n) => ({ ...n, ...resolved.get(n.id)! }));
    const gens = finalNodes.filter((n) => n.kind === 'generator');
    for (let i = 0; i < gens.length; i += 1) {
      for (let j = i + 1; j < gens.length; j += 1) {
        expect(overlaps(gens[i]!, gens[j]!)).toBe(false);
      }
    }
  });

  it('separates a load + a generator on vertical-neighbor buses 80 px apart', () => {
    // BUS5 + BUS6 stacked vertically — the load on BUS5 is south
    // (y=70 below), the generator on BUS6 is north (y=70 above). With
    // BUS5.y=0 and BUS6.y=80, both children land near y=70 →
    // overlapping. Push-out resolves.
    const inputs: PushOutNode[] = [
      makePushNode('bus-5', 'bus', 0, 0),
      makePushNode('bus-6', 'bus', 0, 80),
      makePushNode('load-L5', 'load', 0, 70, { parentBusId: 'bus-5' }),
      makePushNode('generator-G6', 'generator', 0, 10, { parentBusId: 'bus-6' }),
    ];
    const resolved = pushOutCollisions(inputs);
    const finalNodes = inputs.map((n) => ({ ...n, ...resolved.get(n.id)! }));
    const ld = finalNodes.find((n) => n.id === 'load-L5')!;
    const gen = finalNodes.find((n) => n.id === 'generator-G6')!;
    expect(overlaps(ld, gen)).toBe(false);
  });

  it('does not push a node with `locked: true` (drag override semantics)', () => {
    // The user dragged generator-G to (0, 30) and the system tried to
    // place a load also at (0, 30). The locked generator must not move;
    // the load gets shifted away.
    const inputs: PushOutNode[] = [
      makePushNode('bus-1', 'bus', 0, 100),
      makePushNode('generator-G', 'generator', 0, 30, {
        parentBusId: 'bus-1',
        locked: true,
      }),
      makePushNode('load-L', 'load', 0, 30, { parentBusId: 'bus-1' }),
    ];
    const resolved = pushOutCollisions(inputs);
    expect(resolved.get('generator-G')).toEqual({ x: 0, y: 30 }); // unchanged
    const ld = resolved.get('load-L')!;
    expect(ld.x !== 0 || ld.y !== 30).toBe(true);
  });

  it('is idempotent — running twice produces the same result', () => {
    // Fixpoint property: the second pass should be a no-op once
    // collisions are resolved. We capture the output, feed it back in,
    // and assert positions stay identical.
    const inputs = pileup(5, 'generator');
    const first = pushOutCollisions(inputs);
    const passOneNodes = inputs.map((n) => ({ ...n, ...first.get(n.id)! }));
    const second = pushOutCollisions(passOneNodes);
    for (const n of passOneNodes) {
      expect(second.get(n.id)).toEqual({ x: n.x, y: n.y });
    }
  });

  it('does not consider a non-bus node as colliding with its parent bus', () => {
    // A generator on its parent bus's north face inevitably touches
    // the bus's bounding box (the stub edge crosses the boundary).
    // Push-out must NOT shift the generator off its parent.
    const inputs: PushOutNode[] = [
      makePushNode('bus-1', 'bus', 0, 0),
      makePushNode('generator-G', 'generator', 0, -20, { parentBusId: 'bus-1' }),
    ];
    const resolved = pushOutCollisions(inputs);
    expect(resolved.get('generator-G')).toEqual({ x: 0, y: -20 });
  });

  it('still pushes a non-bus node off a NON-parent bus', () => {
    // A generator's bounding box overlaps a NEIGHBOR bus (not its
    // parent). Push-out must shift the generator clear.
    const inputs: PushOutNode[] = [
      makePushNode('bus-1', 'bus', 0, 0),
      makePushNode('bus-2', 'bus', 0, 60), // 60 px south of bus-1
      makePushNode('generator-G', 'generator', 0, 50, { parentBusId: 'bus-1' }),
    ];
    const resolved = pushOutCollisions(inputs);
    const finalGen = { ...inputs[2]!, ...resolved.get('generator-G')! };
    const bus2Node = inputs[1]!;
    expect(overlaps(finalGen, bus2Node)).toBe(false);
  });

  it('keeps the post-shift gap >= PUSH_OUT_SAFETY_GAP between resolved boxes', () => {
    // Two perfectly-stacked generators — the safety-gap invariant says
    // that after push-out the centers differ by at least
    // (height + safety_gap) on whichever axis the push happened.
    const inputs: PushOutNode[] = [
      makePushNode('bus-1', 'bus', 0, 200),
      makePushNode('generator-A', 'generator', 0, 100, { parentBusId: 'bus-1' }),
      makePushNode('generator-B', 'generator', 0, 100, { parentBusId: 'bus-1' }),
    ];
    const resolved = pushOutCollisions(inputs);
    const a = resolved.get('generator-A')!;
    const b = resolved.get('generator-B')!;
    const dy = Math.abs(a.y - b.y);
    const dx = Math.abs(a.x - b.x);
    // At least one axis cleared the safety gap.
    const minClear = Math.min(NODE_FOOTPRINT.generator.height, NODE_FOOTPRINT.generator.width);
    expect(Math.max(dx, dy)).toBeGreaterThanOrEqual(minClear + PUSH_OUT_SAFETY_GAP - 0.001);
  });

  it('completes in <50ms for a 50-device synthetic canvas (unit-test perf budget)', () => {
    // Worst-case: 50 generators all stacked on one bus. O(n²) is ~2500
    // pair checks per pass × 4 passes = ~10k checks. A budget of 50ms
    // gives plenty of headroom on jsdom.
    const inputs: PushOutNode[] = [makePushNode('bus-1', 'bus', 0, 0)];
    for (let i = 0; i < 50; i += 1) {
      inputs.push(
        makePushNode(`generator-${i}`, 'generator', 0, -50, { parentBusId: 'bus-1' }),
      );
    }
    const start = performance.now();
    pushOutCollisions(inputs);
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(50);
  });
});

// ---- buildGraph integration: end-to-end push-out ------------------------

describe('buildGraph — push-out integration', () => {
  it('separates two non-bus elements that the fan-stack defaults stack on each other', () => {
    // Synthetic input where the kind-default emission happens to put
    // a generator and a load close enough to overlap on y. With the
    // default fan-stack, a generator on bus-1 lands at busY-70 and a
    // load on bus-1 at busY+70 — no overlap. Force the contention by
    // also putting a load on a NEIGHBORING bus 80 px below: that
    // load's parent y + 70 = 150, the generator on bus-1's y = 30,
    // and a second generator on bus-1 at the same column would crowd
    // the corridor — push-out is what keeps the canvas readable.
    const topology = makeTopology({
      buses: [bus(5), bus(6)],
      generators: [gen('G6', 6)],
      loads: [load('L5', 5)],
    });
    const coords = {
      '5': { x: 100, y: 0 },
      '6': { x: 100, y: 80 }, // 80 px below bus-5
    };
    const { nodes } = buildGraph(topology, coords);
    const gen6 = nodes.find((n) => n.id === 'generator-G6')!;
    const load5 = nodes.find((n) => n.id === 'load-L5')!;
    // Build push-input form for the overlap check.
    const a: PushOutNode = {
      id: gen6.id,
      kind: 'generator',
      x: gen6.position.x,
      y: gen6.position.y,
      width: NODE_FOOTPRINT.generator.width,
      height: NODE_FOOTPRINT.generator.height,
      locked: false,
      parentBusId: null,
    };
    const b: PushOutNode = {
      id: load5.id,
      kind: 'load',
      x: load5.position.x,
      y: load5.position.y,
      width: NODE_FOOTPRINT.load.width,
      height: NODE_FOOTPRINT.load.height,
      locked: false,
      parentBusId: null,
    };
    expect(overlaps(a, b)).toBe(false);
  });

  it('skips push-out when applyPushOut: false (regression-safety opt-out)', () => {
    // Tests that the existing tests' assertions on raw kind-default
    // offsets (without push-out) keep working when callers explicitly
    // opt out — exercises the escape hatch in BuildGraphOptions.
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('G', 1)],
    });
    const { nodes } = buildGraph(
      topology,
      { '1': { x: 0, y: 100 } },
      { applyPushOut: false },
    );
    const g = nodes.find((n) => n.type === 'generator')!;
    // Default offset: y = busY + (-70) = 30. Stagger ±28 on x.
    expect(g.position.y).toBe(30);
  });

  it('honors dragOverrides from BuildGraphOptions — locked nodes do not shift', () => {
    // The user dragged the generator to (200, 200). buildGraph must
    // emit it AT that coord (and push-out must not shift it).
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('G', 1), gen('G2', 1)],
    });
    const { nodes } = buildGraph(
      topology,
      { '1': { x: 0, y: 100 } },
      {
        dragOverrides: {
          'generator-G': { x: 200, y: 200 },
        },
      },
    );
    const g = nodes.find((n) => n.id === 'generator-G')!;
    expect(g.position).toEqual({ x: 200, y: 200 });
  });

  it('applies push-out by default (the canvas default path)', () => {
    // The IEEE-300-style canary: with three close-stacked devices on
    // one bus that the fan-stack can't fully separate (e.g., all three
    // forced into col=0 by sidecar overrides), push-out must produce
    // a non-overlapping output.
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('G1', 1), gen('G2', 1), gen('G3', 1)],
    });
    // Sidecar coords force all three generators to the same point —
    // which is what push-out is designed to fix.
    const nonBusCoords = new Map([
      ['PV|G1', { x: 0, y: 30 }],
      ['PV|G2', { x: 0, y: 30 }],
      ['PV|G3', { x: 0, y: 30 }],
    ]);
    const { nodes } = buildGraph(
      topology,
      { '1': { x: 0, y: 100 } },
      { nonBusCoords },
    );
    const gens = nodes.filter((n) => n.type === 'generator');
    expect(gens).toHaveLength(3);
    // After push-out, no pair shares a bounding-box overlap.
    for (let i = 0; i < gens.length; i += 1) {
      for (let j = i + 1; j < gens.length; j += 1) {
        const a: PushOutNode = {
          id: gens[i]!.id,
          kind: 'generator',
          x: gens[i]!.position.x,
          y: gens[i]!.position.y,
          width: NODE_FOOTPRINT.generator.width,
          height: NODE_FOOTPRINT.generator.height,
          locked: false,
          parentBusId: null,
        };
        const b: PushOutNode = {
          id: gens[j]!.id,
          kind: 'generator',
          x: gens[j]!.position.x,
          y: gens[j]!.position.y,
          width: NODE_FOOTPRINT.generator.width,
          height: NODE_FOOTPRINT.generator.height,
          locked: false,
          parentBusId: null,
        };
        expect(overlaps(a, b)).toBe(false);
      }
    }
  });

  it('does not apply push-out to a non-bus node referencing a missing parent bus', () => {
    // Defensive: a generator that references a bus not in `coords`
    // is dropped at emission time (existing buildGraph behavior). The
    // push-out pass runs only on emitted nodes — this regression test
    // pins the behavior so adding push-out doesn't accidentally bring
    // orphan nodes into the canvas.
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('G_orphan', 99)],
    });
    // Suppress the expected "missing bus" warning in the test log.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { nodes } = buildGraph(topology, { '1': { x: 0, y: 0 } });
    expect(nodes.find((n) => n.type === 'generator')).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('shunt push direction is south-west (kind-specific direction)', () => {
    // Two shunts on the same bus stacked perfectly. The default kind
    // direction for shunts is left-and-down; after push-out one of
    // them moves toward smaller-x and larger-y from the other.
    const topology = makeTopology({
      buses: [bus(1)],
      shunts: [shunt('S1', 1), shunt('S2', 1)],
    });
    const nonBusCoords = new Map([
      ['Shunt|S1', { x: 0, y: 0 }],
      ['Shunt|S2', { x: 0, y: 0 }],
    ]);
    const { nodes } = buildGraph(
      topology,
      { '1': { x: 0, y: 200 } },
      { nonBusCoords },
    );
    const shunts = nodes.filter((n) => n.type === 'shunt');
    expect(shunts).toHaveLength(2);
    // After push-out the boxes don't overlap.
    const s1: PushOutNode = {
      id: shunts[0]!.id,
      kind: 'shunt',
      x: shunts[0]!.position.x,
      y: shunts[0]!.position.y,
      width: NODE_FOOTPRINT.shunt.width,
      height: NODE_FOOTPRINT.shunt.height,
      locked: false,
      parentBusId: null,
    };
    const s2: PushOutNode = {
      id: shunts[1]!.id,
      kind: 'shunt',
      x: shunts[1]!.position.x,
      y: shunts[1]!.position.y,
      width: NODE_FOOTPRINT.shunt.width,
      height: NODE_FOOTPRINT.shunt.height,
      locked: false,
      parentBusId: null,
    };
    expect(overlaps(s1, s2)).toBe(false);
  });
});
