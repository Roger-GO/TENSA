/**
 * sidecar: schema validation and migration, drift detection, capture of
 * the diagram as drawn, and debounced PUT helpers. The debounced-PUT tests
 * use vitest fake timers for deterministic flushing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseSidecar,
  mergeWithDrift,
  sidecarCoversBuses,
  hasSavedPositions,
  buildSidecarLayout,
  buildNonBusCoordinates,
  resolveDeviceCoords,
  layoutForRenumberedCopy,
  captureLayout,
  branchPolylines,
  controllerCoordsAsMap,
  dragOverridesFromLayout,
  samePlacement,
  debouncedPutSidecar,
  cancelPendingSidecarPut,
  flushPendingSidecarPut,
  __clearAllPendingForTests,
  MAX_BEND_POINTS,
  MAX_FIGURE_SETTINGS,
  MAX_FIGURE_TEXT,
  SIDECAR_SCHEMA_VERSION,
  type DiagramEdge,
  type DiagramNode,
  type FullSidecarLayout,
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

/** The sections version 2 added, all empty: what a version 1 document reads as. */
const EMPTY_SECTIONS = {
  controller_coordinates: {},
  units: {},
  busbars: {},
  branches: {},
  label_offsets: {},
  connections: {},
  figure: {},
};

/** A version 2 document with something in every section. */
function fullLayout(): FullSidecarLayout {
  return {
    schema_version: '2',
    andes_version: '2.0.0',
    last_modified: '2026-10-06T08:00:00Z',
    coordinates: { '1': { x: 0, y: 0 }, '2': { x: 200, y: 0 } },
    non_bus_coordinates: {
      GENROU: { G1: { x: 0, y: -70, bus: '1' } },
      generator: { G1: { x: 0, y: -70, bus: '1' } },
    },
    controller_coordinates: { EXST1: { E1: { x: 90, y: -120 } } },
    units: { G1: { expanded: true } },
    busbars: { '2': { length: 180, orientation: 'vertical' } },
    branches: {
      line: {
        L1: {
          routing: 'polyline',
          bend_points: [
            { x: 30, y: 6 },
            { x: 30, y: 60 },
            { x: 230, y: 6 },
          ],
          bus1: '1',
          bus2: '2',
          source_face: 'south',
          target_face: null,
        },
      },
    },
    label_offsets: { bus: { '1': { dx: 4, dy: -12 } } },
    connections: { generator: { G1: { device_face: 'south', bus_face: 'north' } } },
    figure: { monochrome: true, line_width: 1.5, font: 'serif' },
  };
}

describe('parseSidecar', () => {
  it('accepts a version 1 payload (no non_bus_coordinates) and reads it as version 2', () => {
    const valid = {
      schema_version: '1',
      andes_version: '2.0.x',
      last_modified: '2026-05-07T00:00:00Z',
      coordinates: { '1': { x: 100, y: 200 } },
    };
    // Old sidecars without the later sections MUST still load: each is
    // additive and reads as an empty object.
    expect(parseSidecar(valid)).toEqual({
      ...valid,
      schema_version: SIDECAR_SCHEMA_VERSION,
      non_bus_coordinates: {},
      ...EMPTY_SECTIONS,
    });
  });

  it('accepts a version 2 payload with every section and gives it back unchanged', () => {
    expect(parseSidecar(fullLayout())).toEqual(fullLayout());
    // Through JSON, as it arrives from a file.
    expect(parseSidecar(JSON.parse(JSON.stringify(fullLayout())))).toEqual(fullLayout());
  });

  it('fills the defaults of a record that leaves them out', () => {
    const parsed = parseSidecar({
      ...fullLayout(),
      units: { G1: {} },
      busbars: { '2': {} },
      branches: { line: { L1: {} } },
      connections: { load: { PQ_1: {} } },
    });
    expect(parsed.units).toEqual({ G1: { expanded: false } });
    expect(parsed.busbars).toEqual({ '2': { length: null, orientation: 'horizontal' } });
    expect(parsed.branches).toEqual({
      line: {
        L1: {
          routing: 'auto',
          bend_points: [],
          bus1: null,
          bus2: null,
          source_face: null,
          target_face: null,
        },
      },
    });
    expect(parsed.connections).toEqual({ load: { PQ_1: { device_face: null, bus_face: null } } });
  });

  it('leaves out a top-level field the schema does not have', () => {
    // The curated layouts carry a note of the case they were drawn for.
    const parsed = parseSidecar({ ...fullLayout(), source_case: 'ieee14.raw' });
    expect(parsed).toEqual(fullLayout());
  });

  it.each(['1', '1.0', '0.9', 'one'])('upgrades schema version %s to the current one', (v) => {
    const parsed = parseSidecar({
      schema_version: v,
      andes_version: '2.0.x',
      last_modified: '2026-05-07T00:00:00Z',
      coordinates: { '1': { x: 100, y: 200 } },
      non_bus_coordinates: { load: { PQ_1: { x: 5, y: 70 } } },
    });
    expect(parsed.schema_version).toBe(SIDECAR_SCHEMA_VERSION);
    expect(parsed.coordinates).toEqual({ '1': { x: 100, y: 200 } });
    expect(parsed.non_bus_coordinates).toEqual({ load: { PQ_1: { x: 5, y: 70 } } });
  });

  it('drops the controller badges a version 1 save filed among the buses', () => {
    // Save, after any drag, wrote every node of the diagram as if it were a
    // bus. The badges are no buses, and the entries made the next open say
    // the topology had changed.
    const v1 = {
      schema_version: '1',
      andes_version: 'unknown',
      last_modified: '2026-05-07T00:00:00Z',
      coordinates: {
        '1': { x: 100, y: 200 },
        'controller-EXST1-E1': { x: 136, y: 12 },
        'controller-TGOV1-1': { x: 136, y: 34 },
      },
    };
    const parsed = parseSidecar(v1);
    expect(Object.keys(parsed.coordinates)).toEqual(['1']);
    expect(mergeWithDrift(parsed, makeTopology([bus(1)]), {}).hasDrift).toBe(false);
  });

  it('keeps a bus whose name starts like a badge in a version 2 document', () => {
    const parsed = parseSidecar({
      ...fullLayout(),
      coordinates: { 'controller-room': { x: 1, y: 2 } },
    });
    expect(parsed.coordinates).toEqual({ 'controller-room': { x: 1, y: 2 } });
  });

  it('keeps the version of a document newer than this client writes', () => {
    expect(parseSidecar({ ...fullLayout(), schema_version: '3' }).schema_version).toBe('3');
  });

  it.each<[string, Record<string, unknown>]>([
    [
      'a controller coordinate that is not finite',
      { controller_coordinates: { EXST1: { E1: { x: 0, y: Number.NaN } } } },
    ],
    ['a unit whose state is not a boolean', { units: { G1: { expanded: 'yes' } } }],
    ['a busbar with no length to speak of', { busbars: { '1': { length: 0 } } }],
    ['a busbar that stands at an angle', { busbars: { '1': { orientation: 'diagonal' } } }],
    ['a route of an unknown kind', { branches: { line: { L1: { routing: 'wavy' } } } }],
    ['bend points that are not a list', { branches: { line: { L1: { bend_points: {} } } } }],
    ['a bend point with no y', { branches: { line: { L1: { bend_points: [{ x: 1 }] } } } }],
    ['a face that is not a side', { branches: { line: { L1: { source_face: 'up' } } } }],
    ['a label offset with no dy', { label_offsets: { bus: { '1': { dx: 1 } } } }],
    ['a connection face that is not a side', { connections: { load: { P: { bus_face: 'in' } } } }],
    ['a figure setting that is a list', { figure: { palette: ['black'] } }],
    ['a figure number that is not finite', { figure: { line_width: Number.POSITIVE_INFINITY } }],
    ['a section that is a list', { units: [] }],
    [
      'a device anchored to something that is no idx',
      { non_bus_coordinates: { load: { P: { x: 0, y: 0, bus: 7 } } } },
    ],
    ['a route anchored to something that is no idx', { branches: { line: { L1: { bus1: 1 } } } }],
  ])('rejects %s', (_label, section) => {
    expect(() => parseSidecar({ ...fullLayout(), ...section })).toThrow(TypeError);
  });

  it('rejects a route with more bend points than the server takes', () => {
    const points = Array.from({ length: MAX_BEND_POINTS + 1 }, (_, i) => ({ x: i, y: 0 }));
    const withRoute = (bend_points: unknown) => ({
      ...fullLayout(),
      branches: { line: { L1: { routing: 'polyline', bend_points } } },
    });
    expect(() => parseSidecar(withRoute(points))).toThrow(/at most 256 points/);
    expect(() => parseSidecar(withRoute(points.slice(1)))).not.toThrow();
  });

  it('rejects more figure settings, or a longer one, than the server takes', () => {
    const settings = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`setting_${i}`, i]));
    const withFigure = (figure: unknown) => ({ ...fullLayout(), figure });
    expect(() => parseSidecar(withFigure(settings(MAX_FIGURE_SETTINGS + 1)))).toThrow(
      'sidecar.figure: at most 64 settings',
    );
    expect(() => parseSidecar(withFigure(settings(MAX_FIGURE_SETTINGS)))).not.toThrow();
    expect(() => parseSidecar(withFigure({ title: 'x'.repeat(MAX_FIGURE_TEXT + 1) }))).toThrow(
      'sidecar.figure[title]: at most 256 characters',
    );
    expect(() => parseSidecar(withFigure({ title: 'x'.repeat(MAX_FIGURE_TEXT) }))).not.toThrow();
    // Characters, as the server counts them: each of these is two UTF-16 units.
    expect(() => parseSidecar(withFigure({ title: '\u{1D11E}'.repeat(200) }))).not.toThrow();
  });

  it('says where in the document the problem is', () => {
    expect(() =>
      parseSidecar({ ...fullLayout(), branches: { line: { L1: { bend_points: [{ x: 1 }] } } } }),
    ).toThrow('sidecar.branches[line][L1].bend_points[0].y: expected finite number');
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

describe('resolveDeviceCoords', () => {
  const device = (idx: string, kind: string, busIdx: number | string): TopologyEntry => ({
    idx,
    name: idx,
    kind,
    params: { bus: busIdx },
  });
  const withDevices = (devices: Partial<TopologySummary>): TopologySummary => ({
    ...makeTopology([bus(1), bus(2), bus(3)]),
    ...devices,
  });

  it('returns an empty map when there is nothing saved', () => {
    const topology = withDevices({ generators: [device('1', 'PV', 1)] });
    expect(resolveDeviceCoords(undefined, topology).size).toBe(0);
    expect(resolveDeviceCoords({}, topology).size).toBe(0);
  });

  it('finds a device under its model class, and under its UI category when only that is there', () => {
    const topology = withDevices({
      generators: [device('1', 'PV', 1), device('2', 'GENROU', 2)],
      loads: [device('PQ_1', 'PQ', 3)],
    });
    const map = resolveDeviceCoords(
      {
        PV: { '1': { x: 10, y: 20 } },
        generator: { '1': { x: 11, y: 21 }, '2': { x: 50, y: 60 } },
        PQ: { PQ_1: { x: 5, y: 5 } },
      },
      topology,
    );
    // The model-class layer wins where both are present.
    expect(map.get('generator|1')).toEqual({ x: 10, y: 20 });
    // The kind-edit fallback: saved as another model, found by its category.
    expect(map.get('generator|2')).toEqual({ x: 50, y: 60 });
    expect(map.get('load|PQ_1')).toEqual({ x: 5, y: 5 });
  });

  it('leaves a device the layout does not place without an entry', () => {
    const topology = withDevices({ loads: [device('PQ_1', 'PQ', 3), device('PQ_2', 'PQ', 3)] });
    const map = resolveDeviceCoords({ load: { PQ_1: { x: 5, y: 5, bus: '3' } } }, topology);
    expect([...map.keys()]).toEqual(['load|PQ_1']);
  });

  it('does not put a device where another device of that idx used to be', () => {
    // The layout placed load PQ_1 against bus 3. The idx now names a load on
    // bus 1 (the system was saved as .raw and numbered afresh, or the load
    // was deleted and another added).
    const topology = withDevices({ loads: [device('PQ_1', 'PQ', 1)] });
    const map = resolveDeviceCoords(
      { PQ: { PQ_1: { x: 5, y: 5, bus: '3' } }, load: { PQ_1: { x: 5, y: 5, bus: '3' } } },
      topology,
    );
    expect(map.size).toBe(0);
  });

  it('brings the devices of a system that was numbered afresh back to where they were', () => {
    // Saved from the xlsx: generators 1..3 on buses 1..3, loads PQ_0 and PQ_1.
    const saved = buildNonBusCoordinates([
      { uiCategory: 'generator', idx: '1', modelClass: 'GENROU', coord: { x: 1, y: 1 }, bus: '1' },
      { uiCategory: 'generator', idx: '2', modelClass: 'GENROU', coord: { x: 2, y: 2 }, bus: '2' },
      { uiCategory: 'generator', idx: '3', modelClass: 'GENROU', coord: { x: 3, y: 3 }, bus: '3' },
      { uiCategory: 'load', idx: 'PQ_0', modelClass: 'PQ', coord: { x: 20, y: 20 }, bus: '2' },
      { uiCategory: 'load', idx: 'PQ_1', modelClass: 'PQ', coord: { x: 30, y: 30 }, bus: '3' },
    ]);
    // Read back from the .raw: the slack comes last and takes idx 3, the
    // machines are gone, and the loads are PQ_1 and PQ_2.
    const renumbered = withDevices({
      generators: [device('1', 'PV', 2), device('2', 'PV', 3), device('3', 'Slack', 1)],
      loads: [device('PQ_1', 'PQ', 2), device('PQ_2', 'PQ', 3)],
    });
    const map = resolveDeviceCoords(saved, renumbered);
    expect(Object.fromEntries(map)).toEqual({
      'generator|1': { x: 2, y: 2 }, // the generator on bus 2
      'generator|2': { x: 3, y: 3 }, // the generator on bus 3
      'generator|3': { x: 1, y: 1 }, // the generator on bus 1
      'load|PQ_1': { x: 20, y: 20 }, // the load on bus 2, not the old PQ_1
      'load|PQ_2': { x: 30, y: 30 },
    });
  });

  it('gives two devices of a kind on one bus the two positions saved there, each once', () => {
    const saved = buildNonBusCoordinates([
      { uiCategory: 'load', idx: 'A', modelClass: 'PQ', coord: { x: 1, y: 1 }, bus: '2' },
      { uiCategory: 'load', idx: 'B', modelClass: 'PQ', coord: { x: 2, y: 2 }, bus: '2' },
    ]);
    const renamed = withDevices({ loads: [device('X', 'PQ', 2), device('Y', 'PQ', 2)] });
    const map = resolveDeviceCoords(saved, renamed);
    expect(map.get('load|X')).toEqual({ x: 1, y: 1 });
    expect(map.get('load|Y')).toEqual({ x: 2, y: 2 });
    // A device that kept its idx keeps its own position; only the other is matched by bus.
    const oneKept = withDevices({ loads: [device('Y', 'PQ', 2), device('B', 'PQ', 2)] });
    const kept = resolveDeviceCoords(saved, oneKept);
    expect(kept.get('load|B')).toEqual({ x: 2, y: 2 });
    expect(kept.get('load|Y')).toEqual({ x: 1, y: 1 });
  });

  it('trusts the idx of a position saved without its bus, and never matches it by bus', () => {
    // A version 1 layout.
    const saved = { load: { PQ_1: { x: 5, y: 5 } } };
    expect(
      resolveDeviceCoords(saved, withDevices({ loads: [device('PQ_1', 'PQ', 1)] })).get(
        'load|PQ_1',
      ),
    ).toEqual({ x: 5, y: 5 });
    expect(resolveDeviceCoords(saved, withDevices({ loads: [device('PQ_9', 'PQ', 1)] })).size).toBe(
      0,
    );
  });

  it('resolves a generator and its machine that share an idx once, as the one node they are', () => {
    const topology = withDevices({
      generators: [device('1', 'PV', 1), device('1', 'GENROU', 1)],
    });
    const map = resolveDeviceCoords(
      { GENROU: { '1': { x: 7, y: 7, bus: '1' } }, generator: { '1': { x: 7, y: 7, bus: '1' } } },
      topology,
    );
    expect([...map.entries()]).toEqual([['generator|1', { x: 7, y: 7 }]]);
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

describe('sidecarCoversBuses', () => {
  const stored = (idxs: Array<number | string>): SidecarLayout => ({
    schema_version: '1',
    andes_version: '2.0.x',
    last_modified: '2026-05-07T00:00:00Z',
    coordinates: Object.fromEntries(idxs.map((i) => [String(i), { x: 1, y: 1 }])),
  });

  it('is true when every bus has a stored coordinate, extras included', () => {
    expect(sidecarCoversBuses(stored([1, 2]), makeTopology([bus(1), bus(2)]))).toBe(true);
    expect(sidecarCoversBuses(stored([1, 2, 99]), makeTopology([bus(1), bus(2)]))).toBe(true);
  });

  it('is false when a bus has none', () => {
    expect(sidecarCoversBuses(stored([1, 2]), makeTopology([bus(1), bus(2), bus(3)]))).toBe(false);
  });

  it('matches a numeric bus idx with its string key', () => {
    expect(sidecarCoversBuses(stored(['1', '2']), makeTopology([bus(1), bus(2)]))).toBe(true);
    expect(sidecarCoversBuses(stored([1, 2]), makeTopology([bus('1'), bus('2')]))).toBe(true);
  });

  it('is false without a stored layout, even for an empty topology', () => {
    expect(sidecarCoversBuses(null, makeTopology([bus(1)]))).toBe(false);
    expect(sidecarCoversBuses(null, makeTopology([]))).toBe(false);
  });
});

describe('hasSavedPositions', () => {
  const layout = (
    coordinates: SidecarLayout['coordinates'],
    nonBus?: SidecarLayout['non_bus_coordinates'],
  ): SidecarLayout => ({
    schema_version: '1',
    andes_version: 'unknown',
    last_modified: '2026-10-01T00:00:00Z',
    coordinates,
    ...(nonBus === undefined ? {} : { non_bus_coordinates: nonBus }),
  });

  it('is false for no layout, and for the empty one Reset to auto-layout leaves behind', () => {
    expect(hasSavedPositions(null)).toBe(false);
    expect(hasSavedPositions(layout({}))).toBe(false);
    expect(hasSavedPositions(layout({}, {}))).toBe(false);
    // An outer key with nothing under it places nothing either.
    expect(hasSavedPositions(layout({}, { PV: {}, generator: {} }))).toBe(false);
  });

  it('is true when a bus or a device has a position', () => {
    expect(hasSavedPositions(layout({ '1': { x: 0, y: 0 } }))).toBe(true);
    expect(hasSavedPositions(layout({}, { generator: { '1': { x: 5, y: 6 } } }))).toBe(true);
  });

  it('is true when only a controller is placed, and false when only settings are kept', () => {
    expect(
      hasSavedPositions({
        ...layout({}),
        controller_coordinates: { EXST1: { '1': { x: 5, y: 6 } } },
      }),
    ).toBe(true);
    // What Reset to auto-layout leaves when the figure settings are kept.
    expect(hasSavedPositions({ ...layout({}), figure: { monochrome: true } })).toBe(false);
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
    // Likewise every section version 2 added.
    expect(layout).toMatchObject(EMPTY_SECTIONS);
  });

  it('writes the sections it is given and leaves the others empty', () => {
    const { figure, units } = fullLayout();
    const layout = buildSidecarLayout({}, { sections: { figure, units } });
    expect(layout.figure).toEqual(figure);
    expect(layout.units).toEqual(units);
    expect(layout.branches).toEqual({});
    expect(layout.schema_version).toBe(SIDECAR_SCHEMA_VERSION);
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

describe('captureLayout', () => {
  const topology: TopologySummary = {
    state: 'pre-setup',
    buses: [bus(1), bus(2)],
    lines: [
      { idx: 'L1', name: 'L1', kind: 'Line', params: { bus1: 1, bus2: 2 } },
      { idx: 'L2', name: 'L2', kind: 'Line', params: { bus1: 1, bus2: 2 } },
    ],
    transformers: [{ idx: 'T1', name: 'T1', kind: 'Line', params: { bus1: 1, bus2: 2 } }],
    generators: [{ idx: 'G1', name: 'G1', kind: 'GENROU', params: { bus: 1 } }],
    loads: [{ idx: 'PQ_1', name: 'L1', kind: 'PQ', params: { bus: 2 } }],
    shunts: [{ idx: 'Shunt_1', name: 'S1', kind: 'Shunt', params: { bus: 2 } }],
    controllers: [
      { idx: 'E1', name: 'E1', kind: 'EXST1', params: { syn: 'G1' } },
      { idx: 'T1', name: 'T1', kind: 'TGOV1', params: { syn: 'G1' } },
    ],
  };

  const node = (
    id: string,
    type: string,
    x: number,
    y: number,
    data: Record<string, unknown> = {},
  ): DiagramNode => ({ id, type, position: { x, y }, data });

  const nodes: DiagramNode[] = [
    node('1', 'bus', 0, 0, { idx: '1' }),
    node('2', 'bus', 200, 0, { idx: '2' }),
    node('generator-G1', 'generator', 0, -70, { idx: 'G1', kind: 'GENROU', parentBus: '1' }),
    node('load-PQ_1', 'load', 200, 70, { idx: 'PQ_1', kind: 'PQ', parentBus: '2' }),
    node('shunt-Shunt_1', 'shunt', 125, 55, { idx: 'Shunt_1', kind: 'Shunt', parentBus: '2' }),
    // One badge docked beside its machine, one the layout placed.
    node('controller-EXST1-E1', 'controller', 64, -88, { idx: 'E1', kind: 'EXST1' }),
    node('controller-TGOV1-T1', 'controller', 300, -200, {
      idx: 'T1',
      kind: 'TGOV1',
      placed: true,
    }),
  ];

  const routed: [number, number][] = [
    [30, 40],
    [30, 80],
    [230, 80],
    [230, 40],
  ];
  const ends = { source: '1', target: '2' };
  const edges: DiagramEdge[] = [
    { id: 'line-L1', ...ends, data: { bucket: 'line', idx: 'L1', bendPoints: routed } },
    { id: 'line-L2', ...ends, data: { bucket: 'line', idx: 'L2' } },
    {
      id: 'transformer-T1',
      ...ends,
      data: { bucket: 'transformer', idx: 'T1', bendPoints: routed },
    },
    {
      id: 'stub-generator-G1',
      source: 'generator-G1',
      target: '1',
      data: { bucket: 'generator', kind: 'GENROU' },
    },
  ];

  it('records where every bus and every device is drawn, not only what was dragged', () => {
    const layout = captureLayout({ nodes, edges }, topology, null);
    expect(layout.schema_version).toBe(SIDECAR_SCHEMA_VERSION);
    expect(layout.coordinates).toEqual({ '1': { x: 0, y: 0 }, '2': { x: 200, y: 0 } });
    // Each device with the bus it hangs off, which is what its position is
    // good for: a reader uses it only for a device on that bus.
    expect(layout.non_bus_coordinates).toEqual({
      GENROU: { G1: { x: 0, y: -70, bus: '1' } },
      generator: { G1: { x: 0, y: -70, bus: '1' } },
      PQ: { PQ_1: { x: 200, y: 70, bus: '2' } },
      load: { PQ_1: { x: 200, y: 70, bus: '2' } },
      Shunt: { Shunt_1: { x: 125, y: 55, bus: '2' } },
      shunt: { Shunt_1: { x: 125, y: 55, bus: '2' } },
    });
  });

  it('never files a controller badge among the buses', () => {
    const layout = captureLayout({ nodes, edges }, topology, null);
    expect(Object.keys(layout.coordinates)).toEqual(['1', '2']);
    expect(mergeWithDrift(layout, topology, {}).hasDrift).toBe(false);
  });

  it('records a controller the layout placed, and none for one docked beside its device', () => {
    const layout = captureLayout({ nodes, edges }, topology, null);
    expect(layout.controller_coordinates).toEqual({ TGOV1: { T1: { x: 300, y: -200 } } });
  });

  it('records the route of each branch drawn through fixed points', () => {
    const layout = captureLayout({ nodes, edges }, topology, null);
    const route = {
      routing: 'polyline',
      bend_points: [
        { x: 30, y: 40 },
        { x: 30, y: 80 },
        { x: 230, y: 80 },
        { x: 230, y: 40 },
      ],
      // The two buses it runs between, which is what it is good for.
      bus1: '1',
      bus2: '2',
      source_face: null,
      target_face: null,
    };
    // L2 is drawn from where its buses are; it needs no entry.
    expect(layout.branches).toEqual({ line: { L1: route }, transformer: { T1: route } });
  });

  it('gives back the routes it read: a saved diagram reopens with the same lines', () => {
    const layout = captureLayout({ nodes, edges }, topology, null);
    const polylines = branchPolylines(layout, topology);
    expect([...polylines.keys()]).toEqual(['line-L1', 'transformer-T1']);
    expect(polylines.get('line-L1')).toEqual(routed);
  });

  it('keeps a face chosen for a branch, with or without a fixed route', () => {
    const base: SidecarLayout = {
      ...fullLayout(),
      branches: {
        line: {
          L1: { routing: 'auto', bend_points: [], source_face: 'south', target_face: 'west' },
          L2: { routing: 'auto', bend_points: [], source_face: null, target_face: 'north' },
        },
      },
    };
    const layout = captureLayout({ nodes, edges }, topology, base);
    expect(layout.branches.line?.L1).toMatchObject({
      routing: 'polyline',
      source_face: 'south',
      target_face: 'west',
    });
    expect(layout.branches.line?.L2).toEqual({
      routing: 'auto',
      bend_points: [],
      bus1: '1',
      bus2: '2',
      source_face: null,
      target_face: 'north',
    });
  });

  it('drops a route once its branch is drawn from the live positions again', () => {
    const base = captureLayout({ nodes, edges }, topology, null);
    // A bus was moved: the canvas no longer draws L1 through its old points.
    const afterMove = edges.map((e) =>
      e.id === 'line-L1' ? { id: e.id, data: { bucket: 'line', idx: 'L1' } } : e,
    );
    const layout = captureLayout({ nodes, edges: afterMove }, topology, base);
    expect(layout.branches).toEqual({ transformer: { T1: base.branches.transformer?.T1 } });
  });

  it('does not store a route longer than the server takes', () => {
    const long = Array.from({ length: MAX_BEND_POINTS + 1 }, (_, i): [number, number] => [i, 0]);
    const layout = captureLayout(
      { nodes, edges: [{ id: 'line-L1', data: { bucket: 'line', idx: 'L1', bendPoints: long } }] },
      topology,
      null,
    );
    expect(layout.branches).toEqual({});
  });

  it('carries over the sections the canvas does not draw from', () => {
    const base: SidecarLayout = {
      ...fullLayout(),
      label_offsets: {
        bus: { '1': { dx: 4, dy: -12 } },
        GENROU: { G1: { dx: 0, dy: 9 } },
        line: { L1: { dx: 1, dy: 1 } },
        controller: { E1: { dx: 2, dy: 2 } },
      },
      connections: {
        generator: { G1: { device_face: 'south', bus_face: 'north' } },
        PQ: { PQ_1: { device_face: 'north', bus_face: null } },
      },
    };
    const layout = captureLayout({ nodes, edges }, topology, base);
    expect(layout.units).toEqual(base.units);
    expect(layout.busbars).toEqual(base.busbars);
    expect(layout.label_offsets).toEqual(base.label_offsets);
    expect(layout.connections).toEqual(base.connections);
    expect(layout.figure).toEqual(base.figure);
    expect(layout.andes_version).toBe('2.0.0');
  });

  it('leaves behind what described an element the case no longer has', () => {
    const base: SidecarLayout = {
      ...fullLayout(),
      units: { G1: { expanded: true }, G9: { expanded: true } },
      busbars: {
        '2': { length: 180, orientation: 'vertical' },
        '99': { length: 50, orientation: 'horizontal' },
      },
      label_offsets: { bus: { '1': { dx: 4, dy: -12 }, '99': { dx: 1, dy: 1 } } },
      connections: {
        generator: { G1: { device_face: 'south', bus_face: 'north' } },
        load: { PQ_9: { device_face: 'north', bus_face: null } },
      },
      branches: {
        line: {
          L9: { routing: 'auto', bend_points: [], source_face: 'south', target_face: null },
        },
      },
    };
    const layout = captureLayout({ nodes, edges: [] }, topology, base);
    expect(layout.units).toEqual({ G1: { expanded: true } });
    expect(layout.busbars).toEqual({ '2': { length: 180, orientation: 'vertical' } });
    expect(layout.label_offsets).toEqual({ bus: { '1': { dx: 4, dy: -12 } } });
    expect(layout.connections).toEqual({
      generator: { G1: { device_face: 'south', bus_face: 'north' } },
    });
    expect(layout.branches).toEqual({});
    // The figure's settings describe no element and always stay.
    expect(layout.figure).toEqual(base.figure);
  });

  it('survives its own validator, and the server schema it mirrors', () => {
    const layout = captureLayout({ nodes, edges }, topology, fullLayout());
    expect(parseSidecar(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
  });
});

describe('branchPolylines', () => {
  const line = (idx: string, bus1: number, bus2: number): TopologyEntry => ({
    idx,
    name: idx,
    kind: 'Line',
    params: { bus1, bus2 },
  });
  const grid = (lines: TopologyEntry[], transformers: TopologyEntry[] = []): TopologySummary => ({
    ...makeTopology([bus(1), bus(2), bus(3)]),
    lines,
    transformers,
  });
  const route = (
    routing: 'auto' | 'polyline',
    points: number,
    anchor: { bus1?: string; bus2?: string } = {},
    x = 1,
  ) => ({
    routing,
    bend_points: Array.from({ length: points }, (_, i) => ({ x, y: i })),
    bus1: anchor.bus1 ?? null,
    bus2: anchor.bus2 ?? null,
    source_face: null,
    target_face: null,
  });
  const withRoutes = (branches: FullSidecarLayout['branches']): SidecarLayout => ({
    ...fullLayout(),
    branches,
  });

  it('reads nothing from no layout, or from a version 1 one', () => {
    const topology = grid([line('L1', 1, 2)]);
    expect(branchPolylines(null, topology).size).toBe(0);
    const v1: SidecarLayout = {
      schema_version: '1',
      andes_version: 'unknown',
      last_modified: 'x',
      coordinates: {},
    };
    expect(branchPolylines(v1, topology).size).toBe(0);
  });

  it('skips a route that is automatic, has too few points, or is filed under no branch kind', () => {
    const topology = grid([line('ok', 1, 2), line('auto', 1, 2), line('short', 1, 2)]);
    const polylines = branchPolylines(
      withRoutes({
        line: { ok: route('polyline', 2), auto: route('auto', 3), short: route('polyline', 1) },
        cable: { odd: route('polyline', 2) },
      }),
      topology,
    );
    expect([...polylines.keys()]).toEqual(['line-ok']);
  });

  it('draws nothing for a route whose branch the case no longer has', () => {
    const polylines = branchPolylines(
      withRoutes({ line: { gone: route('polyline', 2, { bus1: '1', bus2: '2' }) } }),
      grid([line('L1', 2, 3)]),
    );
    expect(polylines.size).toBe(0);
  });

  it('does not draw a route on a branch that only has its idx', () => {
    // Saved for a line between buses 1 and 2; the idx now names one from 2 to 3.
    const polylines = branchPolylines(
      withRoutes({ line: { L1: route('polyline', 2, { bus1: '1', bus2: '2' }) } }),
      grid([line('L1', 2, 3)]),
    );
    expect(polylines.size).toBe(0);
  });

  it('keeps the routes of a system whose lines were numbered afresh', () => {
    // Saved as Line_0, Line_1 and a transformer; read back from a .raw as
    // Line_1, Line_2 (so Line_1 means another line now) and the same transformer.
    const saved = withRoutes({
      line: {
        Line_0: route('polyline', 2, { bus1: '1', bus2: '2' }, 10),
        Line_1: route('polyline', 3, { bus1: '2', bus2: '3' }, 20),
      },
      transformer: { T: route('polyline', 2, { bus1: '1', bus2: '3' }, 30) },
    });
    const renumbered = grid([line('Line_1', 1, 2), line('Line_2', 2, 3)], [line('T9', 1, 3)]);
    const polylines = branchPolylines(saved, renumbered);
    expect(Object.fromEntries([...polylines].map(([id, points]) => [id, points[0]![0]]))).toEqual({
      'line-Line_1': 10, // the line from 1 to 2, which was Line_0
      'line-Line_2': 20, // the line from 2 to 3, which was Line_1
      'transformer-T9': 30,
    });
  });

  it('gives two lines between the same buses the two routes saved for that pair, each once', () => {
    const saved = withRoutes({
      line: {
        A: route('polyline', 2, { bus1: '1', bus2: '2' }, 10),
        B: route('polyline', 2, { bus1: '1', bus2: '2' }, 20),
      },
    });
    const polylines = branchPolylines(
      saved,
      grid([line('X', 1, 2), line('Y', 1, 2), line('Z', 1, 2)]),
    );
    expect(polylines.get('line-X')?.[0]?.[0]).toBe(10);
    expect(polylines.get('line-Y')?.[0]?.[0]).toBe(20);
    expect(polylines.has('line-Z')).toBe(false);
  });

  it('trusts the idx of a route saved without its buses', () => {
    const saved = withRoutes({ line: { L1: route('polyline', 2) } });
    expect(branchPolylines(saved, grid([line('L1', 2, 3)])).has('line-L1')).toBe(true);
    expect(branchPolylines(saved, grid([line('L9', 2, 3)])).size).toBe(0);
  });
});

describe('controllerCoordsAsMap', () => {
  it('reads nothing from no layout, or from a version 1 one', () => {
    expect(controllerCoordsAsMap(null).size).toBe(0);
    expect(
      controllerCoordsAsMap({
        schema_version: '1',
        andes_version: 'unknown',
        last_modified: 'x',
        coordinates: {},
      }).size,
    ).toBe(0);
  });

  it('keys a placed controller by its model class and idx', () => {
    const map = controllerCoordsAsMap(fullLayout());
    expect([...map.entries()]).toEqual([['EXST1|E1', { x: 90, y: -120 }]]);
  });
});

describe('layoutForRenumberedCopy', () => {
  it('keeps what is keyed by bus, and the entries that say which buses they belong to', () => {
    const anchored = { x: 10, y: 70, bus: '2' };
    const routed = fullLayout().branches.line!.L1!;
    const copy = layoutForRenumberedCopy({
      ...fullLayout(),
      non_bus_coordinates: {
        PQ: { PQ_0: anchored, PQ_9: { x: 99, y: 99 } },
        load: { PQ_0: anchored, PQ_9: { x: 99, y: 99 } },
        shunt: { S1: { x: 1, y: 1 } },
      },
      branches: {
        line: { L1: routed, L2: { ...routed, bus1: null, bus2: null } },
        transformer: { T1: { ...routed, bus2: null } },
      },
      label_offsets: { bus: { '1': { dx: 4, dy: -12 } }, load: { PQ_0: { dx: 1, dy: 1 } } },
    });
    expect(copy.coordinates).toEqual(fullLayout().coordinates);
    expect(copy.busbars).toEqual(fullLayout().busbars);
    expect(copy.figure).toEqual(fullLayout().figure);
    expect(copy.label_offsets).toEqual({ bus: { '1': { dx: 4, dy: -12 } } });
    expect(copy.non_bus_coordinates).toEqual({ PQ: { PQ_0: anchored }, load: { PQ_0: anchored } });
    expect(copy.branches).toEqual({ line: { L1: routed } });
    // Nothing ties these to an element once the idx values have moved on.
    expect(copy.controller_coordinates).toEqual({});
    expect(copy.units).toEqual({});
    expect(copy.connections).toEqual({});
    expect(copy.last_modified).toBe(fullLayout().last_modified);
    expect(copy.schema_version).toBe(SIDECAR_SCHEMA_VERSION);
  });

  it('leaves what a capture of the diagram writes whole, since it anchors every entry', () => {
    const bare = {
      ...fullLayout(),
      controller_coordinates: {},
      units: {},
      connections: {},
    };
    expect(samePlacement(layoutForRenumberedCopy(bare), bare)).toBe(true);
  });
});

describe('samePlacement', () => {
  it('is true for one diagram saved at two times, by two versions', () => {
    const later = {
      ...fullLayout(),
      last_modified: '2027-01-01T00:00:00Z',
      andes_version: '2.1.0',
      schema_version: '3',
    };
    expect(samePlacement(fullLayout(), later)).toBe(true);
  });

  it('is true whatever order the entries were written in, and for a section left out', () => {
    const base = fullLayout();
    const reordered: SidecarLayout = {
      ...base,
      coordinates: { '2': base.coordinates['2']!, '1': base.coordinates['1']! },
      figure: { font: 'serif', line_width: 1.5, monochrome: true },
    };
    expect(samePlacement(base, reordered)).toBe(true);
    // A version 1 document and the same positions with empty sections.
    const v1: SidecarLayout = {
      schema_version: '1',
      andes_version: 'x',
      last_modified: 'x',
      coordinates: base.coordinates,
    };
    expect(samePlacement(v1, buildSidecarLayout(base.coordinates))).toBe(true);
  });

  it('takes a field the server wrote out as null for one that was left off', () => {
    const fromServer: SidecarLayout = {
      ...fullLayout(),
      non_bus_coordinates: { load: { PQ_1: { x: 1, y: 2, bus: null } } },
    };
    const captured: SidecarLayout = {
      ...fullLayout(),
      non_bus_coordinates: { load: { PQ_1: { x: 1, y: 2 } } },
    };
    expect(samePlacement(fromServer, captured)).toBe(true);
  });

  it.each<[string, (layout: FullSidecarLayout) => void]>([
    ['a bus moved', (l) => (l.coordinates['1'] = { x: 1, y: 0 })],
    ['a device moved', (l) => (l.non_bus_coordinates.generator!.G1 = { x: 0, y: -71, bus: '1' })],
    ['a device on another bus', (l) => (l.non_bus_coordinates.generator!.G1!.bus = '2')],
    ['a route between other buses', (l) => (l.branches.line!.L1!.bus2 = '3')],
    ['a controller placed elsewhere', (l) => (l.controller_coordinates.EXST1!.E1!.x = 91)],
    ['a route bent elsewhere', (l) => (l.branches.line!.L1!.bend_points![1] = { x: 31, y: 60 })],
    ['a route no longer fixed', (l) => (l.branches = {})],
    ['a unit collapsed', (l) => (l.units.G1 = { expanded: false })],
    ['a busbar turned', (l) => (l.busbars['2']!.orientation = 'horizontal')],
    ['a label moved', (l) => (l.label_offsets.bus!['1']!.dx = 5)],
    ['a connection face chosen', (l) => (l.connections.generator!.G1!.bus_face = 'south')],
    ['a figure setting changed', (l) => (l.figure.monochrome = false)],
  ])('is false with %s', (_label, change) => {
    const changed = fullLayout();
    change(changed);
    expect(samePlacement(fullLayout(), changed)).toBe(false);
  });
});

describe('dragOverridesFromLayout', () => {
  it('names each position by the node the canvas draws it as', () => {
    expect(
      dragOverridesFromLayout({
        ...fullLayout(),
        non_bus_coordinates: {
          GENROU: { G1: { x: 0, y: -70 } },
          generator: { G1: { x: 0, y: -70 } },
          load: { 'PQ-1': { x: 9, y: 9 } },
        },
      }),
    ).toEqual({
      '1': { x: 0, y: 0 },
      '2': { x: 200, y: 0 },
      // The model-class layer names no node; the category layer does.
      'generator-G1': { x: 0, y: -70 },
      'load-PQ-1': { x: 9, y: 9 },
    });
  });
});

describe('the fixture the server tests read too', () => {
  // One file, held to by both copies of the schema: here `parseSidecar` and
  // `layoutForRenumberedCopy`, in `server/tests/unit/test_layout_web_schema.py`
  // the server's models and `for_renumbered_copy`. A change to one side that
  // the other does not follow fails one of the two.
  const shared = JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'tests/fixtures/layout-v2.json'), 'utf8'),
  ) as { document: SidecarLayout; renumbered_copy: SidecarLayout };

  /**
   * `value` with the fields that are `null` left out: the server writes every
   * optional field, and this side leaves some of them off when they are unset.
   */
  const set = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(set);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, inner]) => inner !== null)
        .map(([key, inner]) => [key, set(inner)]),
    );
  };

  it('is read whole: every section, every entry, every field that is set', () => {
    const parsed = parseSidecar(shared.document);
    expect(set(parsed)).toEqual(set(shared.document));
    // Read again from what was read, it is the same: nothing is lost on a write.
    expect(parseSidecar(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it('is cut down for a renumbered copy to what the server cuts it down to', () => {
    const copy = layoutForRenumberedCopy(parseSidecar(shared.document));
    expect(set(copy)).toEqual(set(shared.renumbered_copy));
    expect(samePlacement(copy, shared.renumbered_copy)).toBe(true);
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

  it('flushPendingSidecarPut sends the waiting write at once, and only once', () => {
    const put = vi.fn();
    const layout = buildSidecarLayout({ '1': { x: 5, y: 5 } });
    debouncedPutSidecar('case.raw', layout, put, 500);
    vi.advanceTimersByTime(100);
    flushPendingSidecarPut('case.raw');
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(layout);
    // The timer it was waiting on does not send it again, nor does a second flush.
    vi.advanceTimersByTime(1_000);
    flushPendingSidecarPut('case.raw');
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('flushPendingSidecarPut sends nothing when no write is waiting, or one that was cancelled', () => {
    const put = vi.fn();
    flushPendingSidecarPut('case.raw');
    debouncedPutSidecar('case.raw', buildSidecarLayout({}), put, 500);
    cancelPendingSidecarPut('case.raw');
    flushPendingSidecarPut('case.raw');
    expect(put).not.toHaveBeenCalled();
  });

  it('flushPendingSidecarPut leaves the write of another case waiting', () => {
    const putA = vi.fn();
    const putB = vi.fn();
    debouncedPutSidecar('a.raw', buildSidecarLayout({ '1': { x: 1, y: 1 } }), putA, 500);
    debouncedPutSidecar('b.raw', buildSidecarLayout({ '2': { x: 2, y: 2 } }), putB, 500);
    flushPendingSidecarPut('a.raw');
    expect(putA).toHaveBeenCalledTimes(1);
    expect(putB).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(putB).toHaveBeenCalledTimes(1);
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
