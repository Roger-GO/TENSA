/**
 * Which side of its two buses a branch leaves from (`sides.ts`, re-exported
 * by `graph.ts`). These tests exercise the eight-octant matrix of
 * `assignHandles`, and the rule for the branches of a diagram: two buses in
 * a row are joined end to end, an end takes one branch, and every other
 * branch goes by the faces, which take as many as come.
 */
import { describe, it, expect, vi } from 'vitest';
import { assignBranchSides, assignHandles, computeHandleAssignments } from '@/components/sld/graph';
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
  it('gives each branch of a bus the side that points at its other bus', () => {
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
    expect(handles.get('line-10')).toEqual({ sourceSide: 'east', targetSide: 'west' });
    expect(handles.get('line-11')).toEqual({ sourceSide: 'west', targetSide: 'east' });
    expect(handles.get('line-12')).toEqual({ sourceSide: 'south', targetSide: 'north' });
    expect(handles.get('line-13')).toEqual({ sourceSide: 'north', targetSide: 'south' });
  });

  it('moves a branch to the faces when the end it wants is taken', () => {
    // Three edges all naturally want to leave BUS1 by its east end. The
    // first takes it; an end holds one branch, so the next two leave by
    // the south face, which has room for both.
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
    expect(handles.get('line-10')).toEqual({ sourceSide: 'east', targetSide: 'west' });
    expect(handles.get('line-11')).toEqual({ sourceSide: 'south', targetSide: 'north' });
    expect(handles.get('line-12')).toEqual({ sourceSide: 'south', targetSide: 'north' });
  });

  it('moves a hub bus through-edge to the faces', () => {
    // The IEEE 14 hub case: bus 2 receives an edge on its west end
    // (1 → 2) AND naturally wants to emit an edge from its west end
    // toward the south-west neighbour (2 → 5). The second goes by the
    // faces instead: no shared corridor at the west end of bus 2.
    const topology = makeTopology([bus(1), bus(2), bus(5)], [line(10, 1, 2), line(11, 2, 5)]);
    const coords = {
      '1': { x: 200, y: 100 },
      '2': { x: 400, y: 100 },
      '5': { x: 200, y: 250 },
    };
    const { branches: handles } = computeHandleAssignments(topology, coords);
    expect(handles.get('line-10')).toEqual({ sourceSide: 'east', targetSide: 'west' });
    expect(handles.get('line-11')).toEqual({ sourceSide: 'south', targetSide: 'north' });
  });

  it('keeps every branch that points up or down on the faces, however many there are', () => {
    // A face has a tap for each; none is sent round by an end.
    const topology = makeTopology(
      [bus(1), bus(2), bus(3), bus(4)],
      [line(10, 1, 2), line(11, 1, 3), line(12, 1, 4)],
    );
    const coords = {
      '1': { x: 0, y: 0 },
      '2': { x: -60, y: 200 },
      '3': { x: 0, y: 200 },
      '4': { x: 60, y: 200 },
    };
    const { branches: handles } = computeHandleAssignments(topology, coords);
    for (const id of ['line-10', 'line-11', 'line-12']) {
      expect(handles.get(id)).toEqual({ sourceSide: 'south', targetSide: 'north' });
    }
  });

  it('sends a branch between two rows by the faces though they are further apart across than down', () => {
    // What the auto-layout makes of a bus and a neighbour in the next layer,
    // one column over: 152 across, 120 down. Not a row, so not end to end.
    const topology = makeTopology([bus(1), bus(2)], [line(10, 1, 2), line(11, 2, 1)]);
    const coords = { '1': { x: 12, y: 12 }, '2': { x: 164, y: 132 } };
    const { branches: handles } = computeHandleAssignments(topology, coords);
    expect(handles.get('line-10')).toEqual({ sourceSide: 'south', targetSide: 'north' });
    expect(handles.get('line-11')).toEqual({ sourceSide: 'north', targetSide: 'south' });
  });

  it('joins two buses that are nearly level end to end, and steps down to the faces when the end is taken', () => {
    // 30 down over 200 across is a row.
    const topology = makeTopology([bus(1), bus(2)], [line(10, 1, 2), line(11, 1, 2)]);
    const coords = { '1': { x: 0, y: 0 }, '2': { x: 200, y: 30 } };
    const { branches: handles } = computeHandleAssignments(topology, coords);
    expect(handles.get('line-10')).toEqual({ sourceSide: 'east', targetSide: 'west' });
    expect(handles.get('line-11')).toEqual({ sourceSide: 'south', targetSide: 'north' });
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

  it('never gives one end of a bar to two branches', () => {
    // Roughly the IEEE 14 spine top half, and a second cluster beside it.
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
        line(8, 3, 4),
        line(9, 4, 5),
        line(10, 3, 5),
      ],
    );
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
    expect(handles.size).toBe(topology.lines.length);
    const ends = new Set<string>();
    for (const entry of topology.lines) {
      const sides = handles.get(`line-${String(entry.idx)}`)!;
      for (const [busIdx, side] of [
        [String(entry.params!.bus1), sides.sourceSide],
        [String(entry.params!.bus2), sides.targetSide],
      ] as const) {
        if (side !== 'east' && side !== 'west') continue;
        const key = `${busIdx}|${side}`;
        expect(ends.has(key), `two branches at ${key}`).toBe(false);
        ends.add(key);
      }
    }
    // Three buses in a row: 3-4 and 4-5 join end to end, and 3-5, which
    // would run over both, bridges across. The branches down from bus 2 are
    // not in a row with what they reach, and go by the faces.
    expect(handles.get('line-8')).toEqual({ sourceSide: 'east', targetSide: 'west' });
    expect(handles.get('line-9')).toEqual({ sourceSide: 'east', targetSide: 'west' });
    expect(handles.get('line-10')).toEqual({ sourceSide: 'north', targetSide: 'north' });
    expect(handles.get('line-2')).toEqual({ sourceSide: 'south', targetSide: 'north' });
    expect(handles.get('line-4')).toEqual({ sourceSide: 'south', targetSide: 'north' });
  });
});

describe('assignBranchSides', () => {
  const level = { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } };

  it('bridges further branches between two level buses over them, then under them', () => {
    const sides = assignBranchSides(
      [
        { id: 'one', source: 'a', target: 'b' },
        { id: 'two', source: 'a', target: 'b' },
        { id: 'three', source: 'b', target: 'a' },
      ],
      level,
    );
    expect(sides.get('one')).toEqual({ sourceSide: 'east', targetSide: 'west' });
    expect(sides.get('two')).toEqual({ sourceSide: 'north', targetSide: 'north' });
    expect(sides.get('three')).toEqual({ sourceSide: 'south', targetSide: 'south' });
  });

  it('keeps clear of an end that is already claimed', () => {
    // Something else (a branch with a stored route) runs into the east end of `a`.
    const sides = assignBranchSides([{ id: 'one', source: 'a', target: 'b' }], level, ['a|east']);
    expect(sides.get('one')).toEqual({ sourceSide: 'north', targetSide: 'north' });
    // The claim is on one end only: a branch the other way is free to use the west end of `a`.
    const other = assignBranchSides(
      [{ id: 'one', source: 'a', target: 'c' }],
      { ...level, c: { x: -300, y: 0 } },
      ['a|east'],
    );
    expect(other.get('one')).toEqual({ sourceSide: 'west', targetSide: 'east' });
  });

  it('is the same for the same input', () => {
    const branches = [
      { id: 'one', source: 'a', target: 'b' },
      { id: 'two', source: 'a', target: 'b' },
    ];
    expect([...assignBranchSides(branches, level)]).toEqual([
      ...assignBranchSides(branches, level),
    ]);
  });
});
