/**
 * Handle-assignment + stride coverage for the Unit 1 edge-routing
 * upgrade. The pure helpers in `graph.ts` decide which cardinal
 * Handle each edge enters / exits, and how to lateral-offset edges
 * that share a single bus's handle. These tests exercise both the
 * eight-octant matrix (no shared handles) and a multi-edge cluster
 * (stride increments).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { assignHandles, computeHandleAssignments } from '@/components/sld/graph';
import type { TopologySummary, TopologyEntry } from '@/api/types';

function bus(idx: number | string, name = `b${idx}`): TopologyEntry {
  return { idx, name, kind: 'Bus', params: {} };
}
function line(idx: number | string, bus1: number | string, bus2: number | string): TopologyEntry {
  return { idx, name: `l${idx}`, kind: 'Line', params: { bus1, bus2 } };
}
function makeTopology(buses: TopologyEntry[], lines: TopologyEntry[] = []): TopologySummary {
  return {
    state: 'pre-setup',
    buses,
    lines,
    transformers: [],
    generators: [],
    loads: [],
  };
}

describe('assignHandles', () => {
  it('picks east → west when target is due east of source', () => {
    expect(assignHandles({ x: 0, y: 0 }, { x: 100, y: 0 })).toEqual({
      sourceSide: 'east',
      targetSide: 'west',
    });
  });

  it('picks west → east when target is due west of source', () => {
    expect(assignHandles({ x: 100, y: 0 }, { x: 0, y: 0 })).toEqual({
      sourceSide: 'west',
      targetSide: 'east',
    });
  });

  it('picks south → north when target is due south of source', () => {
    expect(assignHandles({ x: 0, y: 0 }, { x: 0, y: 100 })).toEqual({
      sourceSide: 'south',
      targetSide: 'north',
    });
  });

  it('picks north → south when target is due north of source', () => {
    expect(assignHandles({ x: 0, y: 100 }, { x: 0, y: 0 })).toEqual({
      sourceSide: 'north',
      targetSide: 'south',
    });
  });

  it('picks the dominant axis on diagonals (NE quadrant)', () => {
    // dx=80, dy=-30 — horizontal-dominant.
    expect(assignHandles({ x: 0, y: 30 }, { x: 80, y: 0 })).toEqual({
      sourceSide: 'east',
      targetSide: 'west',
    });
  });

  it('picks the dominant axis on diagonals (NW quadrant, vertical-dominant)', () => {
    // dx=-30, dy=-80 — vertical-dominant.
    expect(assignHandles({ x: 30, y: 80 }, { x: 0, y: 0 })).toEqual({
      sourceSide: 'north',
      targetSide: 'south',
    });
  });

  it('falls back to east/east when source and target share the same coord', () => {
    expect(assignHandles({ x: 50, y: 50 }, { x: 50, y: 50 })).toEqual({
      sourceSide: 'east',
      targetSide: 'east',
    });
  });

  it('handles each of the four cardinal-aligned and four diagonal cases unambiguously', () => {
    const cases: Array<{
      from: { x: number; y: number };
      to: { x: number; y: number };
      sourceSide: 'north' | 'east' | 'south' | 'west';
      targetSide: 'north' | 'east' | 'south' | 'west';
    }> = [
      // 4 cardinals
      { from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, sourceSide: 'east', targetSide: 'west' },
      { from: { x: 0, y: 0 }, to: { x: -100, y: 0 }, sourceSide: 'west', targetSide: 'east' },
      { from: { x: 0, y: 0 }, to: { x: 0, y: 100 }, sourceSide: 'south', targetSide: 'north' },
      { from: { x: 0, y: 0 }, to: { x: 0, y: -100 }, sourceSide: 'north', targetSide: 'south' },
      // 4 diagonals — pick whichever component has greater magnitude.
      { from: { x: 0, y: 0 }, to: { x: 100, y: 50 }, sourceSide: 'east', targetSide: 'west' },
      { from: { x: 0, y: 0 }, to: { x: -100, y: 50 }, sourceSide: 'west', targetSide: 'east' },
      { from: { x: 0, y: 0 }, to: { x: 50, y: 100 }, sourceSide: 'south', targetSide: 'north' },
      { from: { x: 0, y: 0 }, to: { x: -50, y: -100 }, sourceSide: 'north', targetSide: 'south' },
    ];
    for (const c of cases) {
      expect(assignHandles(c.from, c.to)).toEqual({
        sourceSide: c.sourceSide,
        targetSide: c.targetSide,
      });
    }
  });
});

describe('computeHandleAssignments', () => {
  it('returns a stride of 0 for each edge when no two share a source handle', () => {
    const topology = makeTopology(
      [bus(1), bus(2), bus(3), bus(4), bus(5)],
      [line(10, 1, 2), line(11, 1, 3), line(12, 1, 4), line(13, 1, 5)],
    );
    const coords = {
      '1': { x: 0, y: 0 },
      '2': { x: 100, y: 0 }, // east of 1
      '3': { x: -100, y: 0 }, // west of 1
      '4': { x: 0, y: 100 }, // south of 1
      '5': { x: 0, y: -100 }, // north of 1
    };
    const handles = computeHandleAssignments(topology, coords);
    const eachStride = Array.from(handles.values()).map((h) => h.stride);
    expect(eachStride).toEqual([0, 0, 0, 0]);
    // Verify each edge picks a unique side on bus 1.
    const sourceSides = Array.from(handles.values()).map((h) => h.sourceSide);
    expect(new Set(sourceSides).size).toBe(4);
  });

  it('increments stride for edges sharing the same source handle', () => {
    const topology = makeTopology(
      [bus(1), bus(2), bus(3), bus(4)],
      [
        line(10, 1, 2), // bus 2 east of 1 → source 'east'
        line(11, 1, 3), // bus 3 east of 1 → source 'east' too
        line(12, 1, 4), // bus 4 east of 1 → source 'east' again
      ],
    );
    const coords = {
      '1': { x: 0, y: 0 },
      '2': { x: 100, y: 0 },
      '3': { x: 200, y: 30 },
      '4': { x: 300, y: 60 },
    };
    const handles = computeHandleAssignments(topology, coords);
    expect(handles.get('line-10')).toEqual({ sourceSide: 'east', targetSide: 'west', stride: 0 });
    expect(handles.get('line-11')).toEqual({ sourceSide: 'east', targetSide: 'west', stride: 1 });
    expect(handles.get('line-12')).toEqual({ sourceSide: 'east', targetSide: 'west', stride: 2 });
  });

  it('skips edges with missing terminals or missing coords', () => {
    const topology = makeTopology(
      [bus(1), bus(2)],
      [
        line(10, 1, 2), // valid
        { idx: 11, name: 'l11', kind: 'Line', params: {} }, // missing terminals
        line(12, 1, 99), // bus 99 not in coords map
      ],
    );
    const coords = { '1': { x: 0, y: 0 }, '2': { x: 100, y: 0 } };
    const handles = computeHandleAssignments(topology, coords);
    expect(handles.size).toBe(1);
    expect(handles.has('line-10')).toBe(true);
    expect(handles.has('line-11')).toBe(false);
    expect(handles.has('line-12')).toBe(false);
  });

  it('emits a single console.warn for degenerate (overlapping) bus pairs', () => {
    const topology = makeTopology(
      [bus(1), bus(2), bus(3)],
      [
        line(10, 1, 2), // overlapping
        line(11, 1, 3), // overlapping
      ],
    );
    const coords = {
      '1': { x: 50, y: 50 },
      '2': { x: 50, y: 50 },
      '3': { x: 50, y: 50 },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const handles = computeHandleAssignments(topology, coords);
      expect(handles.size).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1); // single warning, not per-edge
    } finally {
      warn.mockRestore();
    }
  });

  it('counts strides per source bus + side independently', () => {
    const topology = makeTopology(
      [bus(1), bus(2), bus(3), bus(4)],
      [
        line(10, 1, 2), // 1.east stride 0
        line(11, 1, 3), // 1.east stride 1
        line(12, 4, 2), // 4.east stride 0 (different source bus)
      ],
    );
    const coords = {
      '1': { x: 0, y: 0 },
      '2': { x: 100, y: 0 },
      '3': { x: 100, y: 30 },
      '4': { x: 50, y: 50 },
    };
    const handles = computeHandleAssignments(topology, coords);
    expect(handles.get('line-10')?.stride).toBe(0);
    expect(handles.get('line-11')?.stride).toBe(1);
    expect(handles.get('line-12')?.stride).toBe(0);
  });
});

describe('computeHandleAssignments — unique corridor coverage on synthetic IEEE 14 spine', () => {
  // Smoke test: with reasonable coords for the IEEE 14 spine,
  // every edge ends up with either a unique source handle or an
  // incrementing stride — the visual property the polish loop
  // demanded.
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('every edge ends up with a unique (sourceBus, sourceSide, stride) triple', () => {
    const topology = makeTopology(
      [bus(1), bus(2), bus(3), bus(4), bus(5), bus(6), bus(7)],
      [
        line(1, 1, 2),
        line(2, 2, 3),
        line(3, 2, 4),
        line(4, 2, 5),
        line(5, 5, 6),
        line(6, 5, 7),
        line(7, 4, 7),
      ],
    );
    // Roughly the IEEE 14 spine top half.
    const coords = {
      '1': { x: 0, y: 0 },
      '2': { x: 0, y: 100 },
      '3': { x: -120, y: 200 },
      '4': { x: 0, y: 200 },
      '5': { x: 120, y: 200 },
      '6': { x: 60, y: 320 },
      '7': { x: 180, y: 320 },
    };
    const handles = computeHandleAssignments(topology, coords);
    const triples = new Set<string>();
    for (const [edgeId, h] of handles.entries()) {
      const fromBusId = edgeId.replace('line-', '').slice(0); // edgeId already encodes idx; we reconstruct via topology entry
      // Need source bus id — derive from topology lookup.
      const entry = topology.lines.find((l) => `line-${String(l.idx)}` === edgeId);
      const fromBus = String(entry?.params?.bus1 ?? fromBusId);
      const triple = `${fromBus}|${h.sourceSide}|${h.stride}`;
      expect(triples.has(triple), `duplicate corridor at ${triple}`).toBe(false);
      triples.add(triple);
    }
    expect(triples.size).toBe(handles.size);
  });
});
