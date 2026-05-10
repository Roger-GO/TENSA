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
  it('returns a stride of 0 for each edge when no two share a handle', () => {
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
    const { branches: handles } = computeHandleAssignments(topology, coords);
    for (const h of handles.values()) {
      expect(h.sourceStride).toBe(0);
      expect(h.targetStride).toBe(0);
    }
    const sourceSides = Array.from(handles.values()).map((h) => h.sourceSide);
    expect(new Set(sourceSides).size).toBe(4);
  });

  it('reassigns to the alternate axis when the primary side already hosts an edge', () => {
    // Three edges all naturally want to leave BUS1 on the east side.
    // The first takes east; the next two get split across east and
    // south as the picker prefers the less-loaded axis.
    const topology = makeTopology(
      [bus(1), bus(2), bus(3), bus(4)],
      [line(10, 1, 2), line(11, 1, 3), line(12, 1, 4)],
    );
    const coords = {
      '1': { x: 0, y: 0 },
      '2': { x: 100, y: 0 },
      '3': { x: 200, y: 30 },
      '4': { x: 300, y: 60 },
    };
    const { branches: handles } = computeHandleAssignments(topology, coords);
    expect(handles.get('line-10')).toMatchObject({ sourceSide: 'east', sourceStride: 0 });
    // line-11 takes the alternate axis (south-north) because primary
    // east is already loaded by line-10.
    expect(handles.get('line-11')).toMatchObject({ sourceSide: 'south', sourceStride: 0 });
    // line-12: both BUS1.east and BUS1.south now carry one edge each
    // — equal load. The picker prefers the alternate axis on ties so
    // the third edge stays paired with the second on the south face,
    // separated by stride.
    expect(handles.get('line-12')).toMatchObject({ sourceSide: 'south', sourceStride: 1 });
  });

  it('reassigns hub-bus through-edges to the perpendicular axis', () => {
    // The IEEE 14 hub case: bus 2 receives an edge on its west face
    // (1 → 2) AND naturally wants to emit an edge from its west face
    // toward the south-west neighbour (2 → 5). Conflict avoidance
    // routes the second edge through south/north instead — clean
    // visual separation, no shared corridor at the bus 2 west handle.
    const topology = makeTopology([bus(1), bus(2), bus(5)], [line(10, 1, 2), line(11, 2, 5)]);
    const coords = {
      '1': { x: 200, y: 100 },
      '2': { x: 400, y: 100 },
      '5': { x: 200, y: 250 },
    };
    const { branches: handles } = computeHandleAssignments(topology, coords);
    // line-10: enters bus 2 on its west face — primary, no conflict.
    expect(handles.get('line-10')).toMatchObject({
      sourceSide: 'east',
      targetSide: 'west',
      targetStride: 0,
    });
    // line-11: would naturally leave bus 2 on west, but bus 2.west is
    // already taken by line-10 — reassign to the perpendicular axis
    // (south of bus 2 → north of bus 5).
    expect(handles.get('line-11')).toMatchObject({
      sourceSide: 'south',
      targetSide: 'north',
      sourceStride: 0,
    });
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
    const { branches: handles } = computeHandleAssignments(topology, coords);
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
      const { branches: handles } = computeHandleAssignments(topology, coords);
      expect(handles.size).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1); // single warning, not per-edge
    } finally {
      warn.mockRestore();
    }
  });

  it('produces unique (busId, side, stride) triples for every endpoint', () => {
    // Smoke test: regardless of which axis each edge ends up on, no
    // two edges should produce overlapping (bus, side, stride) on
    // either endpoint. That's the visual property the user demanded —
    // every line traceable end-to-end without being mistaken for a
    // continuation of another line.
    const topology = makeTopology(
      [bus(1), bus(2), bus(3), bus(4)],
      [line(10, 1, 2), line(11, 1, 3), line(12, 4, 2)],
    );
    const coords = {
      '1': { x: 0, y: 0 },
      '2': { x: 100, y: 0 },
      '3': { x: 100, y: 30 },
      '4': { x: 50, y: 50 },
    };
    const { branches: handles } = computeHandleAssignments(topology, coords);
    const triples = new Set<string>();
    for (const [edgeId, h] of handles.entries()) {
      const entry = topology.lines.find((l) => `line-${String(l.idx)}` === edgeId);
      const sourceBus = String(entry?.params?.bus1 ?? '?');
      const targetBus = String(entry?.params?.bus2 ?? '?');
      const sourceTriple = `${sourceBus}|${h.sourceSide}|${h.sourceStride}`;
      const targetTriple = `${targetBus}|${h.targetSide}|${h.targetStride}`;
      expect(triples.has(sourceTriple), `duplicate source corridor at ${sourceTriple}`).toBe(false);
      expect(triples.has(targetTriple), `duplicate target corridor at ${targetTriple}`).toBe(false);
      triples.add(sourceTriple);
      triples.add(targetTriple);
    }
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
    const { branches: handles } = computeHandleAssignments(topology, coords);
    const triples = new Set<string>();
    for (const [edgeId, h] of handles.entries()) {
      const fromBusId = edgeId.replace('line-', '').slice(0); // edgeId already encodes idx; we reconstruct via topology entry
      // Need source bus id — derive from topology lookup.
      const entry = topology.lines.find((l) => `line-${String(l.idx)}` === edgeId);
      const fromBus = String(entry?.params?.bus1 ?? fromBusId);
      const triple = `${fromBus}|${h.sourceSide}|${h.sourceStride}`;
      expect(triples.has(triple), `duplicate corridor at ${triple}`).toBe(false);
      triples.add(triple);
    }
    expect(triples.size).toBe(handles.size);
  });
});
