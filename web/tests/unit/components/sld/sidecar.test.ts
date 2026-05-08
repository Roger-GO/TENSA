/**
 * sidecar — schema validation, drift detection, and debounced PUT
 * helpers. The debounced-PUT tests use vitest fake timers for
 * deterministic flushing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseSidecar,
  mergeWithDrift,
  buildSidecarLayout,
  debouncedPutSidecar,
  cancelPendingSidecarPut,
  __clearAllPendingForTests,
  SIDECAR_SCHEMA_VERSION,
} from '@/components/sld/sidecar';
import type { SidecarLayout, TopologySummary, TopologyEntry } from '@/api/types';

function bus(idx: number | string, name = `b${idx}`): TopologyEntry {
  return { idx, name, kind: 'Bus', params: {} };
}

function makeTopology(buses: TopologyEntry[]): TopologySummary {
  return {
    state: 'pre-setup',
    buses,
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
  };
}

describe('parseSidecar', () => {
  it('accepts a valid sidecar payload', () => {
    const valid: SidecarLayout = {
      schema_version: '1',
      andes_version: '2.0.x',
      last_modified: '2026-05-07T00:00:00Z',
      coordinates: { '1': { x: 100, y: 200 } },
    };
    expect(parseSidecar(valid)).toEqual(valid);
  });

  it.each([
    ['null top-level', null],
    ['array top-level', []],
    ['missing schema_version', { andes_version: 'x', last_modified: 'x', coordinates: {} }],
    [
      'non-finite coord',
      {
        schema_version: '1',
        andes_version: 'x',
        last_modified: 'x',
        coordinates: { '1': { x: Number.POSITIVE_INFINITY, y: 0 } },
      },
    ],
    [
      'string coord',
      {
        schema_version: '1',
        andes_version: 'x',
        last_modified: 'x',
        coordinates: { '1': { x: '0', y: 0 } },
      },
    ],
  ])('rejects malformed sidecar: %s', (_label, payload) => {
    expect(() => parseSidecar(payload)).toThrow(TypeError);
  });
});

describe('mergeWithDrift', () => {
  it('uses stored coords for matched buses; auto-layout for missing; discards extras', () => {
    const stored: SidecarLayout = {
      schema_version: '1',
      andes_version: '2.0.x',
      last_modified: '2026-05-07T00:00:00Z',
      coordinates: {
        '1': { x: 10, y: 10 },
        '2': { x: 20, y: 20 },
        '3': { x: 30, y: 30 },
        '99': { x: 990, y: 990 }, // extra — should be silently discarded
      },
    };
    const topology = makeTopology([bus(1), bus(2), bus(3), bus(4)]);
    const auto = {
      '1': { x: 1, y: 1 },
      '2': { x: 2, y: 2 },
      '3': { x: 3, y: 3 },
      '4': { x: 444, y: 444 },
    };
    const result = mergeWithDrift(stored, topology, auto);
    expect(result.coords).toEqual({
      '1': { x: 10, y: 10 },
      '2': { x: 20, y: 20 },
      '3': { x: 30, y: 30 },
      '4': { x: 444, y: 444 }, // auto-layouted because not in sidecar
    });
    // 4 is missing from sidecar AND 99 is extra → drift.
    expect(result.hasDrift).toBe(true);
    expect(result.coords['99']).toBeUndefined();
  });

  it('returns hasDrift=false when stored coords cover the topology exactly', () => {
    const stored: SidecarLayout = {
      schema_version: '1',
      andes_version: '2.0.x',
      last_modified: '2026-05-07T00:00:00Z',
      coordinates: {
        '1': { x: 10, y: 10 },
        '2': { x: 20, y: 20 },
      },
    };
    const topology = makeTopology([bus(1), bus(2)]);
    const result = mergeWithDrift(stored, topology, {
      '1': { x: 1, y: 1 },
      '2': { x: 2, y: 2 },
    });
    expect(result.hasDrift).toBe(false);
  });

  it('returns hasDrift=false when there is no stored sidecar at all', () => {
    const topology = makeTopology([bus(1), bus(2)]);
    const result = mergeWithDrift(null, topology, {
      '1': { x: 1, y: 1 },
      '2': { x: 2, y: 2 },
    });
    expect(result.coords).toEqual({
      '1': { x: 1, y: 1 },
      '2': { x: 2, y: 2 },
    });
    expect(result.hasDrift).toBe(false);
  });

  it('falls back to (0, 0) when both sidecar and auto-layout miss a bus', () => {
    const topology = makeTopology([bus(1)]);
    const result = mergeWithDrift(null, topology, {});
    expect(result.coords['1']).toEqual({ x: 0, y: 0 });
  });
});

describe('buildSidecarLayout', () => {
  it('emits the canonical schema_version and the supplied coords', () => {
    const layout = buildSidecarLayout({ '1': { x: 5, y: 5 } }, { andesVersion: '2.0.0' });
    expect(layout.schema_version).toBe(SIDECAR_SCHEMA_VERSION);
    expect(layout.andes_version).toBe('2.0.0');
    expect(layout.coordinates).toEqual({ '1': { x: 5, y: 5 } });
    expect(typeof layout.last_modified).toBe('string');
  });
});

describe('debouncedPutSidecar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __clearAllPendingForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    __clearAllPendingForTests();
  });

  it('flushes once after the debounce delay', () => {
    const put = vi.fn();
    const layout = buildSidecarLayout({ '1': { x: 5, y: 5 } });
    debouncedPutSidecar('case.raw', layout, put, 500);
    expect(put).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(layout);
  });

  it('coalesces rapid calls into a single PUT with the latest payload', () => {
    const put = vi.fn();
    const a = buildSidecarLayout({ '1': { x: 1, y: 1 } });
    const b = buildSidecarLayout({ '1': { x: 2, y: 2 } });
    const c = buildSidecarLayout({ '1': { x: 3, y: 3 } });
    debouncedPutSidecar('case.raw', a, put, 500);
    vi.advanceTimersByTime(200);
    debouncedPutSidecar('case.raw', b, put, 500);
    vi.advanceTimersByTime(200);
    debouncedPutSidecar('case.raw', c, put, 500);
    expect(put).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(c);
  });

  it('cancelPendingSidecarPut prevents the flush', () => {
    const put = vi.fn();
    debouncedPutSidecar('case.raw', buildSidecarLayout({}), put, 500);
    cancelPendingSidecarPut('case.raw');
    vi.advanceTimersByTime(1_000);
    expect(put).not.toHaveBeenCalled();
  });

  it('keeps PUTs for different case paths independent', () => {
    const putA = vi.fn();
    const putB = vi.fn();
    debouncedPutSidecar('a.raw', buildSidecarLayout({ '1': { x: 1, y: 1 } }), putA, 500);
    debouncedPutSidecar('b.raw', buildSidecarLayout({ '2': { x: 2, y: 2 } }), putB, 500);
    vi.advanceTimersByTime(500);
    expect(putA).toHaveBeenCalledTimes(1);
    expect(putB).toHaveBeenCalledTimes(1);
  });
});
