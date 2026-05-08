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
  buildNonBusCoordinates,
  nonBusCoordsAsMap,
  debouncedPutSidecar,
  cancelPendingSidecarPut,
  __clearAllPendingForTests,
  SIDECAR_SCHEMA_VERSION,
  type NonBusOverride,
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
  it('accepts a valid sidecar payload (no non_bus_coordinates)', () => {
    const valid = {
      schema_version: '1',
      andes_version: '2.0.x',
      last_modified: '2026-05-07T00:00:00Z',
      coordinates: { '1': { x: 100, y: 200 } },
    };
    // Old sidecars without `non_bus_coordinates` MUST round-trip — the
    // field is additive and reads as an empty object.
    expect(parseSidecar(valid)).toEqual({
      ...valid,
      non_bus_coordinates: {},
    });
  });

  it('accepts a sidecar with the dual-key non_bus_coordinates shape', () => {
    const valid = {
      schema_version: '1',
      andes_version: '2.0.x',
      last_modified: '2026-05-07T00:00:00Z',
      coordinates: { '1': { x: 100, y: 200 } },
      non_bus_coordinates: {
        PV: { '1': { x: 50, y: 60 } },
        generator: { '1': { x: 50, y: 60 } },
      },
    };
    const parsed = parseSidecar(valid);
    expect(parsed.non_bus_coordinates).toEqual({
      PV: { '1': { x: 50, y: 60 } },
      generator: { '1': { x: 50, y: 60 } },
    });
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
    [
      'non-finite non-bus coord',
      {
        schema_version: '1',
        andes_version: 'x',
        last_modified: 'x',
        coordinates: {},
        non_bus_coordinates: {
          PV: { '1': { x: 0, y: Number.POSITIVE_INFINITY } },
        },
      },
    ],
    [
      'NaN non-bus coord',
      {
        schema_version: '1',
        andes_version: 'x',
        last_modified: 'x',
        coordinates: {},
        non_bus_coordinates: {
          generator: { '1': { x: Number.NaN, y: 0 } },
        },
      },
    ],
    [
      'non-bus inner not-an-object',
      {
        schema_version: '1',
        andes_version: 'x',
        last_modified: 'x',
        coordinates: {},
        non_bus_coordinates: { PV: 'oops' },
      },
    ],
    [
      'non-bus outer not-an-object',
      {
        schema_version: '1',
        andes_version: 'x',
        last_modified: 'x',
        coordinates: {},
        non_bus_coordinates: ['array'],
      },
    ],
  ])('rejects malformed sidecar: %s', (_label, payload) => {
    expect(() => parseSidecar(payload)).toThrow(TypeError);
  });
});

describe('buildNonBusCoordinates', () => {
  it('emits both model-class and UI-category layers for a known model', () => {
    const overrides: NonBusOverride[] = [
      {
        uiCategory: 'generator',
        idx: '1',
        modelClass: 'PV',
        coord: { x: 100, y: 200 },
      },
    ];
    expect(buildNonBusCoordinates(overrides)).toEqual({
      PV: { '1': { x: 100, y: 200 } },
      generator: { '1': { x: 100, y: 200 } },
    });
  });

  it('emits only the UI-category layer when modelClass is null', () => {
    const overrides: NonBusOverride[] = [
      {
        uiCategory: 'load',
        idx: '7',
        modelClass: null,
        coord: { x: 1, y: 2 },
      },
    ];
    expect(buildNonBusCoordinates(overrides)).toEqual({
      load: { '7': { x: 1, y: 2 } },
    });
  });

  it('groups multiple overrides under the right outer keys', () => {
    const overrides: NonBusOverride[] = [
      { uiCategory: 'generator', idx: '1', modelClass: 'PV', coord: { x: 1, y: 1 } },
      { uiCategory: 'generator', idx: '2', modelClass: 'GENROU', coord: { x: 2, y: 2 } },
      { uiCategory: 'load', idx: '1', modelClass: 'PQ', coord: { x: 3, y: 3 } },
      { uiCategory: 'shunt', idx: '1', modelClass: 'Shunt', coord: { x: 4, y: 4 } },
    ];
    expect(buildNonBusCoordinates(overrides)).toEqual({
      PV: { '1': { x: 1, y: 1 } },
      GENROU: { '2': { x: 2, y: 2 } },
      PQ: { '1': { x: 3, y: 3 } },
      Shunt: { '1': { x: 4, y: 4 } },
      generator: {
        '1': { x: 1, y: 1 },
        '2': { x: 2, y: 2 },
      },
      load: { '1': { x: 3, y: 3 } },
      shunt: { '1': { x: 4, y: 4 } },
    });
  });

  it('returns an empty object for an empty input list', () => {
    expect(buildNonBusCoordinates([])).toEqual({});
  });
});

describe('nonBusCoordsAsMap', () => {
  it('returns an empty map when input is undefined or empty', () => {
    expect(nonBusCoordsAsMap(undefined).size).toBe(0);
    expect(nonBusCoordsAsMap({}).size).toBe(0);
  });

  it('emits both model-class and UI-category keys when present', () => {
    const map = nonBusCoordsAsMap({
      PV: { '1': { x: 10, y: 20 } },
      generator: { '1': { x: 10, y: 20 } },
    });
    expect(map.get('PV|1')).toEqual({ x: 10, y: 20 });
    expect(map.get('generator|1')).toEqual({ x: 10, y: 20 });
  });

  it('still resolves the UI-category key when only that layer is present', () => {
    // This is the kind-edit fallback path: an old sidecar saved under a
    // model that no longer matches the topology should still resolve.
    const map = nonBusCoordsAsMap({
      generator: { '1': { x: 50, y: 60 } },
    });
    expect(map.get('generator|1')).toEqual({ x: 50, y: 60 });
    // No model-class layer — model-class lookup misses by design.
    expect(map.get('PV|1')).toBeUndefined();
    expect(map.get('GENROU|1')).toBeUndefined();
  });

  it('resolves the model-class key when only that layer is present', () => {
    const map = nonBusCoordsAsMap({
      PV: { '1': { x: 5, y: 5 } },
    });
    expect(map.get('PV|1')).toEqual({ x: 5, y: 5 });
    expect(map.get('generator|1')).toBeUndefined();
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
    // Default non_bus_coordinates is an empty dict (additive, no
    // surprise data on the wire when no non-bus drags happened).
    expect(layout.non_bus_coordinates).toEqual({});
  });

  it('forwards the supplied non_bus_coordinates dict verbatim', () => {
    const layout = buildSidecarLayout(
      { '1': { x: 5, y: 5 } },
      {
        nonBusCoords: {
          PV: { '1': { x: 100, y: 200 } },
          generator: { '1': { x: 100, y: 200 } },
        },
      },
    );
    expect(layout.non_bus_coordinates).toEqual({
      PV: { '1': { x: 100, y: 200 } },
      generator: { '1': { x: 100, y: 200 } },
    });
  });

  it('round-trips through parseSidecar with both layers populated', () => {
    const layout = buildSidecarLayout(
      { '1': { x: 5, y: 5 } },
      {
        andesVersion: '2.0.0',
        nonBusCoords: buildNonBusCoordinates([
          { uiCategory: 'generator', idx: '1', modelClass: 'PV', coord: { x: 9, y: 9 } },
          { uiCategory: 'load', idx: '2', modelClass: 'PQ', coord: { x: 7, y: 7 } },
        ]),
      },
    );
    const reparsed = parseSidecar(layout);
    expect(reparsed.coordinates).toEqual({ '1': { x: 5, y: 5 } });
    expect(reparsed.non_bus_coordinates).toEqual({
      PV: { '1': { x: 9, y: 9 } },
      generator: { '1': { x: 9, y: 9 } },
      PQ: { '2': { x: 7, y: 7 } },
      load: { '2': { x: 7, y: 7 } },
    });
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
