/**
 * autoLayout — verifies ELK auto-layout produces non-overlapping coords
 * for an IEEE 14-shaped synthetic topology, falls back to a grid when
 * ELK throws, and preserves bus idx as the key.
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread (`elk.bundled`): the layout maths under test is
 * the real one. `elkClient.test.ts` covers the worker client itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import { autoLayout, gridLayout, layoutSignature } from '@/components/sld/layout';
import { elkLayout } from '@/components/sld/elkClient';
import type { TopologySummary, TopologyEntry } from '@/api/types';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

beforeEach(() => {
  vi.mocked(elkLayout).mockClear();
});

/** Pass 2 is the call whose graph declares ports on its buses. */
function isPass2(graph: ElkNode): boolean {
  return (graph.children ?? []).some((c) => (c.ports ?? []).length > 0);
}

function bus(idx: number | string, name: string): TopologyEntry {
  return { idx, name, kind: 'Bus', params: {} };
}

function line(idx: number | string, bus1: number | string, bus2: number | string): TopologyEntry {
  return { idx, name: `line-${idx}`, kind: 'Line', params: { bus1, bus2 } };
}

function makeTopology(buses: TopologyEntry[], lines: TopologyEntry[]): TopologySummary {
  return {
    state: 'pre-setup',
    buses,
    lines,
    transformers: [],
    generators: [],
    loads: [],
  };
}

describe('autoLayout', () => {
  it('returns a coord per bus for a 5-bus synthetic topology', async () => {
    const topology = makeTopology(
      [bus(1, 'b1'), bus(2, 'b2'), bus(3, 'b3'), bus(4, 'b4'), bus(5, 'b5')],
      [line(1, 1, 2), line(2, 2, 3), line(3, 3, 4), line(4, 4, 5)],
    );
    const { coords, bendPoints } = await autoLayout(topology);
    expect(Object.keys(coords).sort()).toEqual(['1', '2', '3', '4', '5']);
    for (const v of Object.values(coords)) {
      expect(Number.isFinite(v.x)).toBe(true);
      expect(Number.isFinite(v.y)).toBe(true);
    }
    // Pass 2 should produce per-edge polylines for every line.
    expect(bendPoints.size).toBe(4);
    for (const polyline of bendPoints.values()) {
      // start + (>=0 bends) + end = at least 2 points.
      expect(polyline.length).toBeGreaterThanOrEqual(2);
      for (const [x, y] of polyline) {
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(y)).toBe(true);
      }
    }
  });

  it('produces non-overlapping coords (no two buses share the same point)', async () => {
    const topology = makeTopology(
      Array.from({ length: 14 }, (_, i) => bus(i + 1, `b${i + 1}`)),
      [
        // Reasonable spanning structure for IEEE 14-ish shape.
        line(1, 1, 2),
        line(2, 2, 3),
        line(3, 2, 4),
        line(4, 4, 5),
        line(5, 5, 6),
        line(6, 6, 11),
        line(7, 6, 12),
        line(8, 6, 13),
        line(9, 7, 8),
        line(10, 9, 10),
        line(11, 9, 14),
        line(12, 10, 11),
        line(13, 12, 13),
        line(14, 13, 14),
      ],
    );
    const { coords } = await autoLayout(topology);
    const seen = new Map<string, string>();
    for (const [id, c] of Object.entries(coords)) {
      const key = `${c.x},${c.y}`;
      const prior = seen.get(key);
      expect(prior, `bus ${id} overlaps with ${prior ?? '?'}`).toBeUndefined();
      seen.set(key, id);
    }
  });

  it('returns an empty layout for an empty topology', async () => {
    const topology = makeTopology([], []);
    const { coords, bendPoints } = await autoLayout(topology);
    expect(coords).toEqual({});
    expect(bendPoints.size).toBe(0);
  });

  it('falls back to a grid layout when ELK throws on pass 1', async () => {
    const topology = makeTopology(
      [bus(1, 'b1'), bus(2, 'b2'), bus(3, 'b3')],
      [line(1, 1, 2), line(2, 2, 3)],
    );
    // Reject pass 1. autoLayout falls back to the grid and skips pass 2.
    vi.mocked(elkLayout).mockRejectedValueOnce(new Error('boom'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { coords, bendPoints } = await autoLayout(topology);
      expect(Object.keys(coords).sort()).toEqual(['1', '2', '3']);
      expect(bendPoints.size).toBe(0);
      expect(elkLayout).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns pass-1 coords without bend points when ELK throws on pass 2', async () => {
    const topology = makeTopology(
      [bus(1, 'b1'), bus(2, 'b2'), bus(3, 'b3')],
      [line(1, 1, 2), line(2, 2, 3)],
    );
    // Let pass 1 run for real, then reject pass 2.
    const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
    const real = new ELK();
    vi.mocked(elkLayout)
      .mockImplementationOnce((graph) => real.layout(graph))
      .mockRejectedValueOnce(new Error('pass-2 boom'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { coords, bendPoints } = await autoLayout(topology);
      expect(Object.keys(coords).sort()).toEqual(['1', '2', '3']);
      expect(bendPoints.size).toBe(0);
      expect(elkLayout).toHaveBeenCalledTimes(2);
      expect(isPass2(vi.mocked(elkLayout).mock.calls[1]?.[0] as ElkNode)).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('skips edges with bus references that are not in the topology', async () => {
    const topology = makeTopology(
      [bus(1, 'b1'), bus(2, 'b2')],
      // Reference to bus 99 should not crash auto-layout.
      [line(1, 1, 2), line(99, 1, 99)],
    );
    const { coords, bendPoints } = await autoLayout(topology);
    expect(Object.keys(coords).sort()).toEqual(['1', '2']);
    // Only the valid line gets a polyline.
    expect(bendPoints.size).toBe(1);
    expect(bendPoints.has('line-1')).toBe(true);
  });
});

describe('gridLayout', () => {
  it('places buses on a sqrt(n)-wide grid with finite spacing', () => {
    const coords = gridLayout(['1', '2', '3', '4']);
    expect(Object.keys(coords).sort()).toEqual(['1', '2', '3', '4']);
    // Two buses on the same row should differ in x; two on the same
    // column should differ in y.
    expect(coords['1']?.x).not.toBe(coords['2']?.x);
    expect(coords['1']?.y).not.toBe(coords['3']?.y);
  });

  it('returns an empty map for no buses', () => {
    expect(gridLayout([])).toEqual({});
  });
});

describe('layoutSignature', () => {
  const base = () =>
    makeTopology([bus(1, 'b1'), bus(2, 'b2'), bus(3, 'b3')], [line(1, 1, 2), line(2, 2, 3)]);

  it('is unchanged by anything autoLayout does not read', () => {
    const before = base();
    const after: TopologySummary = {
      ...base(),
      state: 'committed',
      buses: [bus(1, 'renamed'), bus(2, 'b2'), bus(3, 'b3')].map((b) => ({
        ...b,
        params: { Vn: 230 },
      })),
      lines: [
        { idx: 1, name: 'x', kind: 'Line', params: { bus1: 1, bus2: 2, r: 0.5, u: 0 } },
        { idx: 2, name: 'y', kind: 'Line', params: { bus1: 2, bus2: 3, r: 0.7 } },
      ],
      generators: [{ idx: 'G1', name: 'g', kind: 'PV', params: { bus: 1 } }],
    };
    expect(layoutSignature(after)).toBe(layoutSignature(before));
  });

  it('treats a numeric idx and its string form as the same bus', () => {
    const numeric = makeTopology([bus(1, 'a'), bus(2, 'b')], [line(1, 1, 2)]);
    const text = makeTopology([bus('1', 'a'), bus('2', 'b')], [line('1', '1', '2')]);
    expect(layoutSignature(text)).toBe(layoutSignature(numeric));
  });

  it('changes when a bus is added or removed', () => {
    const more = base();
    more.buses.push(bus(4, 'b4'));
    const fewer = base();
    fewer.buses.pop();
    expect(layoutSignature(more)).not.toBe(layoutSignature(base()));
    expect(layoutSignature(fewer)).not.toBe(layoutSignature(base()));
  });

  it('changes when a branch is added, removed or rewired', () => {
    const added = base();
    added.lines.push(line(3, 1, 3));
    const removed = base();
    removed.lines.pop();
    const rewired = base();
    rewired.lines[1] = line(2, 1, 3);
    const reordered = base();
    reordered.lines.reverse();
    const sig = layoutSignature(base());
    expect(layoutSignature(added)).not.toBe(sig);
    expect(layoutSignature(removed)).not.toBe(sig);
    expect(layoutSignature(rewired)).not.toBe(sig);
    expect(layoutSignature(reordered)).not.toBe(sig);
  });

  it('counts transformers as branches and tells them from lines', () => {
    const withLine = makeTopology([bus(1, 'a'), bus(2, 'b')], [line(1, 1, 2)]);
    const withTrafo = makeTopology([bus(1, 'a'), bus(2, 'b')], []);
    withTrafo.transformers = [{ idx: 1, name: 't', kind: 'Line', params: { bus1: 1, bus2: 2 } }];
    expect(layoutSignature(withTrafo)).not.toBe(layoutSignature(withLine));
  });

  it('ignores a branch with no terminals, as autoLayout does', () => {
    const plain = makeTopology([bus(1, 'a'), bus(2, 'b')], [line(1, 1, 2)]);
    const withStray = makeTopology(
      [bus(1, 'a'), bus(2, 'b')],
      [line(1, 1, 2), { idx: 9, name: 'stray', kind: 'Line', params: {} }],
    );
    expect(layoutSignature(withStray)).toBe(layoutSignature(plain));
  });

  it('does not let ids that join into the same text collide', () => {
    const a = makeTopology([bus('1,2', 'a'), bus('3', 'b')], []);
    const b = makeTopology([bus('1', 'a'), bus('2,3', 'b')], []);
    expect(layoutSignature(a)).not.toBe(layoutSignature(b));
  });
});
