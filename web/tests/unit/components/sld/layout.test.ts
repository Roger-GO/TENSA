/**
 * autoLayout — verifies ELK auto-layout produces non-overlapping coords
 * for an IEEE 14-shaped synthetic topology, falls back to a grid when
 * ELK throws, and preserves bus idx as the key.
 */
import { describe, it, expect, vi } from 'vitest';
import { autoLayout, gridLayout } from '@/components/sld/layout';
import type { TopologySummary, TopologyEntry } from '@/api/types';

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
    // Spy on the underlying ELK layout. We do this by monkey-patching
    // the `elkjs` instance used by autoLayout — the module caches a
    // singleton, so we can grab it via a first call then stub.
    // Run once to instantiate, then break it for the second call.
    await autoLayout(topology);
    const elkBundle = await import('elkjs/lib/elk.bundled.js');
    const proto = elkBundle.default.prototype as unknown as {
      layout: (g: unknown) => Promise<unknown>;
    };
    // Reject pass 1 on the next call. autoLayout will fall back to
    // grid layout and skip pass 2 entirely.
    const spy = vi.spyOn(proto, 'layout').mockRejectedValueOnce(new Error('boom'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { coords, bendPoints } = await autoLayout(topology);
      expect(Object.keys(coords).sort()).toEqual(['1', '2', '3']);
      expect(bendPoints.size).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('returns pass-1 coords without bend points when ELK throws on pass 2', async () => {
    const topology = makeTopology(
      [bus(1, 'b1'), bus(2, 'b2'), bus(3, 'b3')],
      [line(1, 1, 2), line(2, 2, 3)],
    );
    await autoLayout(topology);
    const elkBundle = await import('elkjs/lib/elk.bundled.js');
    const proto = elkBundle.default.prototype as unknown as {
      layout: (g: unknown) => Promise<unknown>;
    };
    // Let pass 1 succeed (real call), then reject pass 2. The spy
    // distinguishes by checking whether the graph has port constraints
    // declared; pass 2 always passes a `layoutOptions.elk.portConstraints`
    // on at least one child.
    const realLayout = proto.layout;
    const spy = vi.spyOn(proto, 'layout').mockImplementation(async function (
      this: unknown,
      graph: unknown,
    ) {
      const g = graph as { children?: Array<{ ports?: unknown[] }> };
      const isPass2 = (g.children ?? []).some((c) => Array.isArray(c.ports) && c.ports.length > 0);
      if (isPass2) throw new Error('pass-2 boom');
      return realLayout.call(this, graph);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { coords, bendPoints } = await autoLayout(topology);
      expect(Object.keys(coords).sort()).toEqual(['1', '2', '3']);
      expect(bendPoints.size).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
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
