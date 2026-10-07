/**
 * SLD layout sidecar: schema validation, drift detection, capture of the
 * diagram as it is drawn, and debounced persistence helpers.
 *
 * The sidecar is a JSON document that stores where everything on the
 * diagram of one case was put. Lifecycle:
 *
 * - On case load: `GET /workspace/layout?case_path=<rel>` (`useGetSidecar`).
 *   With none, the curated layout of the case or auto-layout places the
 *   buses. With one, `mergeWithDrift` against the topology gives the
 *   coords the canvas renders.
 * - On user drag (debounced ~500 ms): `PUT /workspace/layout?case_path=
 *   <rel>` with the whole diagram as it now stands (`captureLayout`).
 *   `debouncedPutSidecar` below coalesces rapid drags into a single PUT,
 *   and `flushPendingSidecarPut` sends one that is still waiting when the
 *   canvas goes away.
 * - On every save (Save, Save system as, a snapshot, a bundle): the same
 *   capture goes with the saved system, so it reopens as it was placed.
 *
 * Schema version 2 holds, beside the bus and device positions of version
 * 1: controllers placed on their own, the expanded state of generating
 * units, busbar length and orientation, branch routes, label offsets,
 * chosen connection faces and figure settings. The canvas draws from the
 * sections it knows (the units whose control chain is drawn out, a bar's
 * length, the routes of the branches, the connectors of devices that were
 * drawn by hand, and the connector style among the figure settings) and
 * carries the rest through unchanged, so a section another part of the
 * diagram writes is never lost by a drag.
 *
 * A route that was drawn by hand is told from one the diagram made: a
 * branch by `routing: 'manual'`, and the connector of a device by having
 * points at all (`connections.<category>.<idx>.bend_points`). The diagram
 * keeps the first kind as it is where it makes the second afresh.
 *
 * Entries are keyed by ANDES idx, and an idx does not always keep its
 * meaning: a PSS/E `.raw` file holds none, so a system saved as one comes
 * back with its devices and branches numbered afresh, and a deleted
 * element can give its idx to the next one added. A device position, the
 * state of a generating unit and a branch route therefore say what they
 * are anchored to (the bus of the device or the unit, the branch's two
 * buses). `resolveDeviceCoords` and `branchPolylines` use an entry only for
 * an element on those buses, and match an entry whose idx no longer fits to
 * the element that is there now; the state of a unit (`unitStatesOf`) is
 * used only for a unit on its bus. The connector of a device that was drawn
 * by hand names its bus too, and goes with the position of its device
 * (`storedConnectorRoutes`).
 *
 * No external dep on Zod; the validator is a hand-written shape check,
 * which keeps the bundle smaller and the failure paths easier to read.
 */
import type {
  SidecarLayout,
  BusCoord,
  LayoutBranchRoute,
  LayoutDeviceCoord,
  LayoutSide,
  TopologyEntry,
  TopologySummary,
} from '@/api/types';
import type { ConnectorStyle } from './connections';

/** Current sidecar schema version. Bumped on incompatible shape changes. */
export const SIDECAR_SCHEMA_VERSION = '2';

/**
 * A layout with every section present, which is what `parseSidecar` and
 * `captureLayout` return. (`SidecarLayout`, the wire type, leaves the
 * sections a version 1 document lacks optional.)
 */
export type FullSidecarLayout = Required<SidecarLayout>;

/** The sections version 2 added, as `buildSidecarLayout` takes them. */
export type LayoutSections = Partial<
  Pick<
    FullSidecarLayout,
    | 'controller_coordinates'
    | 'units'
    | 'busbars'
    | 'branches'
    | 'label_offsets'
    | 'connections'
    | 'figure'
  >
>;

/** Per-bus coordinate map keyed by stringified bus idx. */
export type CoordsByIdx = Record<string, BusCoord>;

/**
 * Two-level non-bus coordinate map mirroring the on-disk
 * `non_bus_coordinates` shape: outer key is the ANDES model class
 * (e.g. `PV`, `GENROU`, `PQ`, `Shunt`) OR the UI category (`generator`,
 * `load`, `shunt`); inner key is the element idx as a string.
 *
 * The dual-key strategy (the writer emits both layers; the reader prefers
 * model-class with UI-category fallback) makes kind-edits resilient: when
 * a `PV` is edited to a `GENROU`, the `PV|<idx>` entry becomes orphaned
 * but the `generator|<idx>` entry still resolves at the saved coord.
 */
export type NonBusCoordsByModel = Record<string, Record<string, LayoutDeviceCoord>>;

/** UI categories the canvas tags non-bus React Flow nodes with. */
const UI_CATEGORIES: ReadonlySet<string> = new Set(['generator', 'load', 'shunt']);

/** The branch buckets a route is filed under, which are also the edge-id prefixes. */
const BRANCH_BUCKETS: ReadonlySet<string> = new Set(['line', 'transformer']);

/** The most points one branch route holds; the server refuses a longer one. */
export const MAX_BEND_POINTS = 256;

/** The most settings `figure` holds, and the longest text one can be; the server's limits. */
export const MAX_FIGURE_SETTINGS = 64;
export const MAX_FIGURE_TEXT = 256;

const SIDES: ReadonlySet<string> = new Set(['north', 'east', 'south', 'west']);

/**
 * Outcome of merging stored sidecar coords with the current topology.
 *
 * - `coords`: the merged coordinate map (matched buses use stored coords;
 *   unmatched buses use the auto-layout fallback coords).
 * - `hasDrift`: true if the stored sidecar contained bus idx values that
 *   the topology no longer has, OR the topology contains bus idx values
 *   the sidecar does not. Drives the dismissible drift banner on the
 *   canvas.
 */
export interface MergeResult {
  coords: CoordsByIdx;
  hasDrift: boolean;
}

// ---- validation helpers ---------------------------------------------------

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path}: expected object`);
  }
  return value as Record<string, unknown>;
}

function finiteAt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${path}: expected finite number`);
  }
  return value;
}

function coordAt(value: unknown, path: string): BusCoord {
  const c = objectAt(value, path);
  return { x: finiteAt(c.x, `${path}.x`), y: finiteAt(c.y, `${path}.y`) };
}

/** An optional idx an entry is anchored to; absent and `null` both read as none. */
function anchorAt(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`${path}: expected string`);
  return value;
}

function deviceCoordAt(value: unknown, path: string): LayoutDeviceCoord {
  const coord = coordAt(value, path);
  const bus = anchorAt((value as Record<string, unknown>).bus, `${path}.bus`);
  return bus === null ? coord : { ...coord, bus };
}

function sideAt(value: unknown, path: string): LayoutSide | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !SIDES.has(value)) {
    throw new TypeError(`${path}: expected north, east, south or west`);
  }
  return value as LayoutSide;
}

/** An optional `{key: leaf}` section; absent reads as empty. */
function mapAt<T>(
  value: unknown,
  path: string,
  leaf: (value: unknown, path: string) => T,
): Record<string, T> {
  if (value === undefined) return {};
  const out: Record<string, T> = {};
  for (const [key, raw] of Object.entries(objectAt(value, path))) {
    out[key] = leaf(raw, `${path}[${key}]`);
  }
  return out;
}

/** An optional `{outer: {idx: leaf}}` section; absent reads as empty. */
function nestedMapAt<T>(
  value: unknown,
  path: string,
  leaf: (value: unknown, path: string) => T,
): Record<string, Record<string, T>> {
  return mapAt(value, path, (inner, innerPath) => mapAt(inner, innerPath, leaf));
}

/** The optional points of a route; absent reads as none. */
function bendPointsAt(value: unknown, path: string): BusCoord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${path}: expected array`);
  if (value.length > MAX_BEND_POINTS) {
    throw new TypeError(`${path}: at most ${MAX_BEND_POINTS} points`);
  }
  return value.map((point, i) => coordAt(point, `${path}[${i}]`));
}

function routeAt(value: unknown, path: string): LayoutBranchRoute {
  const r = objectAt(value, path);
  const routing = r.routing ?? 'auto';
  if (routing !== 'auto' && routing !== 'polyline' && routing !== 'manual') {
    throw new TypeError(`${path}.routing: expected auto, polyline or manual`);
  }
  return {
    routing,
    bend_points: bendPointsAt(r.bend_points, `${path}.bend_points`),
    bus1: anchorAt(r.bus1, `${path}.bus1`),
    bus2: anchorAt(r.bus2, `${path}.bus2`),
    source_face: sideAt(r.source_face, `${path}.source_face`),
    target_face: sideAt(r.target_face, `${path}.target_face`),
  };
}

function figureAt(value: unknown, path: string): FullSidecarLayout['figure'] {
  const figure = mapAt(value, path, (setting, settingPath) => {
    if (typeof setting === 'boolean') return setting;
    if (typeof setting === 'string') {
      // Counted in characters, as the server counts them, not in UTF-16 units.
      if ([...setting].length > MAX_FIGURE_TEXT) {
        throw new TypeError(`${settingPath}: at most ${MAX_FIGURE_TEXT} characters`);
      }
      return setting;
    }
    return finiteAt(setting, settingPath);
  });
  if (Object.keys(figure).length > MAX_FIGURE_SETTINGS) {
    throw new TypeError(`${path}: at most ${MAX_FIGURE_SETTINGS} settings`);
  }
  return figure;
}

/** The leading number of a schema version; 1 for anything unreadable. */
function majorOf(version: string): number {
  const match = /^\s*(\d+)/.exec(version);
  return match ? Number(match[1]) : 1;
}

/**
 * Validate that a JSON-parsed object is a layout, and bring it to the
 * current schema version.
 *
 * Returns the layout with every section present. Throws a `TypeError`
 * with a precise path on failure: sidecar files are user-editable, so a
 * clear error message earns its keep. A top-level field the schema does
 * not have is left out (the curated layouts carry a `source_case` note).
 *
 * Migration from version 1 (bus and device positions only): the sections
 * version 2 added read as empty, and one repair is made. A version 1
 * save after a drag filed the controller badges among the buses, under
 * their node id (`controller-<class>-<idx>`). No bus is named that, and
 * the entries made the canvas report a topology change on every open, so
 * they are dropped.
 */
export function parseSidecar(input: unknown): FullSidecarLayout {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('sidecar: top-level value must be an object');
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.schema_version !== 'string') {
    throw new TypeError('sidecar.schema_version: expected string');
  }
  if (typeof obj.andes_version !== 'string') {
    throw new TypeError('sidecar.andes_version: expected string');
  }
  if (typeof obj.last_modified !== 'string') {
    throw new TypeError('sidecar.last_modified: expected string');
  }
  if (obj.coordinates === undefined) {
    throw new TypeError('sidecar.coordinates: expected object');
  }
  const isCurrent = majorOf(obj.schema_version) >= Number(SIDECAR_SCHEMA_VERSION);
  let coordinates = mapAt(obj.coordinates, 'sidecar.coordinates', coordAt);
  if (!isCurrent) {
    coordinates = Object.fromEntries(
      Object.entries(coordinates).filter(([key]) => !key.startsWith('controller-')),
    );
  }
  return {
    schema_version: isCurrent ? obj.schema_version : SIDECAR_SCHEMA_VERSION,
    andes_version: obj.andes_version,
    last_modified: obj.last_modified,
    coordinates,
    // `non_bus_coordinates` is optional: old sidecars without the field
    // (incl. every curated layout shipped before v0.1.y) read as `{}`.
    non_bus_coordinates: nestedMapAt(
      obj.non_bus_coordinates,
      'sidecar.non_bus_coordinates',
      deviceCoordAt,
    ),
    controller_coordinates: nestedMapAt(
      obj.controller_coordinates,
      'sidecar.controller_coordinates',
      coordAt,
    ),
    units: mapAt(obj.units, 'sidecar.units', (value, path) => {
      const unit = objectAt(value, path);
      const expanded = unit.expanded ?? false;
      if (typeof expanded !== 'boolean') {
        throw new TypeError(`${path}.expanded: expected boolean`);
      }
      return { expanded, bus: anchorAt(unit.bus, `${path}.bus`) };
    }),
    busbars: mapAt(obj.busbars, 'sidecar.busbars', (value, path) => {
      const bar = objectAt(value, path);
      const orientation = bar.orientation ?? 'horizontal';
      if (orientation !== 'horizontal' && orientation !== 'vertical') {
        throw new TypeError(`${path}.orientation: expected horizontal or vertical`);
      }
      const length =
        bar.length === undefined || bar.length === null
          ? null
          : finiteAt(bar.length, `${path}.length`);
      if (length !== null && length <= 0) {
        throw new TypeError(`${path}.length: expected a positive number`);
      }
      return { length, orientation };
    }),
    branches: nestedMapAt(obj.branches, 'sidecar.branches', routeAt),
    label_offsets: nestedMapAt(obj.label_offsets, 'sidecar.label_offsets', (value, path) => {
      const offset = objectAt(value, path);
      return { dx: finiteAt(offset.dx, `${path}.dx`), dy: finiteAt(offset.dy, `${path}.dy`) };
    }),
    connections: nestedMapAt(obj.connections, 'sidecar.connections', (value, path) => {
      const connection = objectAt(value, path);
      return {
        device_face: sideAt(connection.device_face, `${path}.device_face`),
        bus_face: sideAt(connection.bus_face, `${path}.bus_face`),
        bend_points: bendPointsAt(connection.bend_points, `${path}.bend_points`),
        bus: anchorAt(connection.bus, `${path}.bus`),
      };
    }),
    figure: figureAt(obj.figure, 'sidecar.figure'),
  };
}

/**
 * Merge stored sidecar coords with the topology + auto-layout fallback.
 *
 * Drift policy (per Unit 8 plan):
 *
 * - Buses present in BOTH topology and sidecar → use the stored coords.
 * - Buses present in topology but NOT in sidecar → use the auto-layout
 *   coord for that bus; mark `hasDrift = true` so the banner shows.
 * - Buses present in sidecar but NOT in topology → silently discarded.
 *   Mark `hasDrift = true`.
 *
 * The function is pure — no I/O, no `Date.now()`. Tests construct a
 * synthetic topology + stored sidecar + auto-coords and assert the
 * resulting `coords` keys.
 */
export function mergeWithDrift(
  stored: SidecarLayout | null,
  topology: TopologySummary,
  autoCoords: CoordsByIdx,
): MergeResult {
  const out: CoordsByIdx = {};
  let hasDrift = false;
  const storedCoords: CoordsByIdx = stored?.coordinates ?? {};

  const topologyIdxs = new Set<string>();
  for (const bus of topology.buses) {
    const key = String(bus.idx);
    topologyIdxs.add(key);
    const storedCoord = storedCoords[key];
    if (storedCoord) {
      out[key] = storedCoord;
    } else {
      const fallback = autoCoords[key];
      // If neither the sidecar nor the auto-layout has a coord for this
      // bus, default to (0, 0) — the canvas will still render the node,
      // just stacked at the origin until the user drags it.
      out[key] = fallback ?? { x: 0, y: 0 };
      // Mark drift only when there IS a stored sidecar but it lacks
      // this bus. A first-time auto-layout (stored === null) is not
      // drift — there's nothing to drift FROM.
      if (stored !== null) {
        hasDrift = true;
      }
    }
  }

  // Detect "stored has buses topology no longer has" → drift.
  for (const key of Object.keys(storedCoords)) {
    if (!topologyIdxs.has(key)) {
      hasDrift = true;
    }
  }

  return { coords: out, hasDrift };
}

/**
 * True when `layout` places anything: a bus, a device or a controller. A sidecar
 * with no position at all is what Reset to auto-layout leaves behind (the server
 * cannot delete one), and the canvas treats it as no saved layout, so the case
 * shows as it did before anything was moved: its curated layout, or auto-layout.
 */
export function hasSavedPositions(layout: SidecarLayout | null): layout is SidecarLayout {
  if (layout === null) return false;
  if (Object.keys(layout.coordinates).length > 0) return true;
  return [layout.non_bus_coordinates, layout.controller_coordinates].some((section) =>
    Object.values(section ?? {}).some((inner) => Object.keys(inner).length > 0),
  );
}

/**
 * True when `stored` places every bus of the topology, so `mergeWithDrift`
 * never reads an auto-layout coordinate and running ELK would be wasted
 * work. `null` (no stored or curated layout) never covers.
 */
export function sidecarCoversBuses(
  stored: SidecarLayout | null,
  topology: TopologySummary,
): boolean {
  if (stored === null) return false;
  return topology.buses.every((bus) => Boolean(stored.coordinates[String(bus.idx)]));
}

/**
 * One non-bus position the writer needs to persist. A React Flow node id
 * (`${uiCategory}-${idx}`) does NOT carry the ANDES model class on its
 * own; `captureLayout` reads it off the node's data, where `buildGraph`
 * put it. Entries with a `null` `modelClass` get written ONLY under the
 * UI-category layer (the model-class fallback is omitted).
 */
export interface NonBusOverride {
  /** UI category React Flow tagged the node with. */
  uiCategory: 'generator' | 'load' | 'shunt';
  /** Element idx (stringified). */
  idx: string;
  /** ANDES model class name (e.g., `PV`, `GENROU`, `PQ`). `null` if unknown. */
  modelClass: string | null;
  /** Where the element is drawn. */
  coord: BusCoord;
  /** idx of the bus the element hangs off, which the position is anchored to. */
  bus?: string | null;
}

/**
 * Walk a list of non-bus drag overrides and emit the dual-key
 * `non_bus_coordinates` map per the resolved policy:
 *
 * - One entry under `<modelClass>` (when known) so a future load with
 *   the same model class hits the precise coord.
 * - One entry under `<uiCategory>` so a kind-edit that swaps the model
 *   class out (e.g. `PV` → `GENROU`) still resolves on the fallback.
 *
 * Both layers are merged side-by-side in the same outer dict (the
 * server schema accepts arbitrary string keys at the top level). When
 * two drag overrides target the same `(layer, idx)` pair, the later
 * entry wins — the input order is the caller's responsibility.
 *
 * Pure function — no side effects, no cloning of inputs other than the
 * output dicts.
 */
export function buildNonBusCoordinates(
  overrides: ReadonlyArray<NonBusOverride>,
): NonBusCoordsByModel {
  const out: NonBusCoordsByModel = {};
  const ensureLayer = (key: string): Record<string, LayoutDeviceCoord> => {
    let layer = out[key];
    if (!layer) {
      layer = {};
      out[key] = layer;
    }
    return layer;
  };
  for (const o of overrides) {
    const entry = (): LayoutDeviceCoord =>
      o.bus === undefined || o.bus === null
        ? { x: o.coord.x, y: o.coord.y }
        : { x: o.coord.x, y: o.coord.y, bus: o.bus };
    if (o.modelClass) {
      ensureLayer(o.modelClass)[o.idx] = entry();
    }
    ensureLayer(o.uiCategory)[o.idx] = entry();
  }
  return out;
}

/** The idx of the bus an element names in `param`, or `null` when it names none. */
function busOf(entry: TopologyEntry, param: string): string | null {
  const value = entry.params?.[param];
  return value === undefined || value === null || typeof value === 'boolean' ? null : String(value);
}

/**
 * Where a saved layout puts each generator, load and shunt of `topology`, as
 * the graph builder looks positions up: `${uiCategory}|${idx}` to the coord.
 * A device the layout does not place has no entry and gets its default spot
 * beside its bus.
 *
 * Two passes. First by idx: the entry under the device's model class, else
 * the one under its UI category (the dual-key shape: a `PV` edited to a
 * `GENROU` keeps its place). An entry that names a bus is used only while the
 * device is still on that bus. Then, for the devices that found none, by bus:
 * an entry of the same category anchored to the device's bus that no device
 * claimed in the first pass is taken to be this one under an idx it used to
 * have. That is what brings the devices of a system saved as `.raw` back to
 * where they were, though the parser numbered them afresh. An entry with no
 * bus recorded (a version 1 layout) is trusted on its idx and never matched
 * by bus.
 */
export function resolveDeviceCoords(
  nonBus: NonBusCoordsByModel | undefined,
  topology: TopologySummary,
): Map<string, BusCoord> {
  const out = new Map<string, BusCoord>();
  for (const [key, { coord }] of resolveDevicePlaces(nonBus, topology)) out.set(key, coord);
  return out;
}

/**
 * `resolveDeviceCoords`, with the idx each position was found under
 * (`from`): the device's own, or the one it used to have when it was matched
 * by its bus. What else a layout holds for a device goes by that idx (the
 * connector that was drawn for it by hand: `storedConnectorRoutes`).
 */
function resolveDevicePlaces(
  nonBus: NonBusCoordsByModel | undefined,
  topology: TopologySummary,
): Map<string, { coord: BusCoord; from: string; bus: string | null }> {
  const out = new Map<string, { coord: BusCoord; from: string; bus: string | null }>();
  if (!nonBus) return out;
  const devices: { category: string; kind: string; idx: string; bus: string | null }[] = [];
  const collect = (entries: readonly TopologyEntry[] | null | undefined, category: string) => {
    for (const e of entries ?? []) {
      devices.push({ category, kind: e.kind, idx: String(e.idx), bus: busOf(e, 'bus') });
    }
  };
  collect(topology.generators, 'generator');
  collect(topology.loads, 'load');
  collect(topology.shunts, 'shunt');

  const fits = (entry: LayoutDeviceCoord | undefined, bus: string | null) =>
    entry !== undefined && (entry.bus === undefined || entry.bus === null || entry.bus === bus);
  // `${category}|${idx}` of each entry a device took in the first pass.
  const claimed = new Set<string>();
  const unplaced: typeof devices = [];
  for (const device of devices) {
    const key = `${device.category}|${device.idx}`;
    // A generator and its machine can share an idx; the diagram draws one node.
    if (out.has(key)) continue;
    const byModel = nonBus[device.kind]?.[device.idx];
    const byCategory = nonBus[device.category]?.[device.idx];
    const entry = fits(byModel, device.bus)
      ? byModel
      : fits(byCategory, device.bus)
        ? byCategory
        : undefined;
    if (entry === undefined) {
      unplaced.push(device);
      continue;
    }
    out.set(key, { coord: { x: entry.x, y: entry.y }, from: device.idx, bus: device.bus });
    claimed.add(key);
  }

  // The entries nobody claimed, by category and bus, in the order the layout lists them.
  const free = new Map<string, { idx: string; entry: LayoutDeviceCoord }[]>();
  for (const category of UI_CATEGORIES) {
    for (const [idx, entry] of Object.entries(nonBus[category] ?? {})) {
      if (entry.bus === undefined || entry.bus === null) continue;
      if (claimed.has(`${category}|${idx}`)) continue;
      const slot = `${category}|${entry.bus}`;
      const list = free.get(slot);
      if (list) list.push({ idx, entry });
      else free.set(slot, [{ idx, entry }]);
    }
  }
  for (const device of unplaced) {
    const key = `${device.category}|${device.idx}`;
    if (device.bus === null || out.has(key)) continue;
    const found = free.get(`${device.category}|${device.bus}`)?.shift();
    if (found !== undefined) {
      const { idx, entry } = found;
      out.set(key, { coord: { x: entry.x, y: entry.y }, from: idx, bus: device.bus });
    }
  }
  return out;
}

/**
 * Build a fresh sidecar payload from the current coordinate map. Used by
 * `captureLayout` and by curated-layout-export tooling.
 *
 * Pass `nonBusCoords` to persist generator/load/shunt positions alongside
 * the bus coords, and `sections` for anything version 2 added. Whatever is
 * omitted is written empty.
 */
export function buildSidecarLayout(
  coords: CoordsByIdx,
  options: {
    andesVersion?: string;
    nonBusCoords?: NonBusCoordsByModel;
    sections?: LayoutSections;
  } = {},
): FullSidecarLayout {
  const sections = options.sections ?? {};
  return {
    schema_version: SIDECAR_SCHEMA_VERSION,
    andes_version: options.andesVersion ?? 'unknown',
    last_modified: new Date().toISOString(),
    coordinates: coords,
    non_bus_coordinates: options.nonBusCoords ?? {},
    controller_coordinates: sections.controller_coordinates ?? {},
    units: sections.units ?? {},
    busbars: sections.busbars ?? {},
    branches: sections.branches ?? {},
    label_offsets: sections.label_offsets ?? {},
    connections: sections.connections ?? {},
    figure: sections.figure ?? {},
  };
}

// ---- the diagram as it is drawn -------------------------------------------

/** What `captureLayout` reads of a React Flow node. */
export interface DiagramNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

/** What `captureLayout` reads of a React Flow edge. */
export interface DiagramEdge {
  id: string;
  /** The node ids at its ends; for a branch, the idx of its two buses. */
  source?: string;
  target?: string;
  data?: Record<string, unknown>;
}

function isUiCategory(type: string | undefined): type is NonBusOverride['uiCategory'] {
  return type !== undefined && UI_CATEGORIES.has(type);
}

/**
 * Every `outer|idx` pair that names an element of `topology`, where `outer`
 * is a model class or the category the diagram files the element under. It is
 * what decides whether an entry of a layout section still has something to
 * describe.
 */
function elementKeys(topology: TopologySummary): Set<string> {
  const keys = new Set<string>();
  const fold = (
    entries: ReadonlyArray<{ idx: number | string; kind: string }> | null | undefined,
    category: string,
  ) => {
    for (const e of entries ?? []) {
      keys.add(`${category}|${String(e.idx)}`);
      keys.add(`${e.kind}|${String(e.idx)}`);
    }
  };
  fold(topology.buses, 'bus');
  fold(topology.generators, 'generator');
  fold(topology.loads, 'load');
  fold(topology.shunts, 'shunt');
  fold(topology.lines, 'line');
  fold(topology.transformers, 'transformer');
  fold(topology.controllers, 'controller');
  return keys;
}

/** `section` without the entries whose element is gone. */
function keepLiving<T>(
  section: Record<string, Record<string, T>> | undefined,
  living: ReadonlySet<string>,
): Record<string, Record<string, T>> {
  const out: Record<string, Record<string, T>> = {};
  for (const [outer, inner] of Object.entries(section ?? {})) {
    const kept = Object.entries(inner).filter(([idx]) => living.has(`${outer}|${idx}`));
    if (kept.length > 0) out[outer] = Object.fromEntries(kept);
  }
  return out;
}

/**
 * The name the connector style goes by among a layout's `figure` settings:
 * `straight`, or `elbow` for a connector with one right angle. It is a
 * setting of the whole diagram, so it sits with the display settings, which
 * every save path carries and a reset of the placement leaves alone.
 */
export const CONNECTOR_STYLE_SETTING = 'connector_style';

/** How `layout` draws the connector of a device to its bus, or `null` when it does not say. */
export function connectorStyleOf(layout: SidecarLayout | null): ConnectorStyle | null {
  const value = layout?.figure?.[CONNECTOR_STYLE_SETTING];
  return value === 'straight' || value === 'elbow' ? value : null;
}

/**
 * How `layout` draws each generating unit it says something of, by the idx
 * of the unit, as the graph builder takes it: whether the control chain is
 * drawn out, and the bus the unit was on when that was chosen. The builder
 * uses an entry that names a bus only for a unit on that bus.
 */
export function unitStatesOf(
  layout: SidecarLayout | null,
): Map<string, { expanded: boolean; bus: string | null }> {
  const out = new Map<string, { expanded: boolean; bus: string | null }>();
  for (const [idx, unit] of Object.entries(layout?.units ?? {})) {
    out.set(idx, { expanded: unit.expanded === true, bus: unit.bus ?? null });
  }
  return out;
}

/**
 * The length `layout` sets for the bar of each bus that has one set, by bus
 * idx. A bar with no length set is sized by the diagram to what connects to
 * it.
 */
export function barLengthsOf(layout: SidecarLayout | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const [idx, bar] of Object.entries(layout?.busbars ?? {})) {
    if (typeof bar.length === 'number') out.set(idx, bar.length);
  }
  return out;
}

/**
 * The layout of the diagram as it is drawn: the position of every bus and
 * device, the controllers that were placed on their own, the generating
 * units whose control chain is drawn out, the route of every branch
 * drawn through fixed points (`manual` for one that was drawn by hand), and
 * the points of every device connector that was. This is what goes with a
 * saved system, so a reload draws the same picture whatever placed the
 * nodes (a drag, the curated layout of the case, or auto-layout).
 *
 * A route that was drawn by hand is written with the places its two ends
 * stand at, which is what a reader takes it to have been drawn for
 * (`storedBranchRoutes`, `storedConnectorRoutes`). So one that is still
 * held for where an end stood before a move (`data.bendAnchors`; the
 * diagram brings it along, or gives it up, a moment after the move is
 * kept) is not written as it is held: read back, it would be drawn through
 * points that were made for a device somewhere else.
 *
 * `base` is the layout the diagram was drawn from. The sections the canvas
 * does not write (busbars, label offsets, figure settings) and the chosen
 * faces of a branch or a connector are carried over from it,
 * minus the entries of elements `topology` no longer has, so a drag never
 * loses what another editor of the layout wrote. `chosen` is what was
 * chosen for the diagram since: a connector style goes into the figure
 * settings (`CONNECTOR_STYLE_SETTING`), over the one `base` has.
 */
export function captureLayout(
  diagram: { nodes: ReadonlyArray<DiagramNode>; edges: ReadonlyArray<DiagramEdge> },
  topology: TopologySummary,
  base: SidecarLayout | null,
  chosen: { connectorStyle?: ConnectorStyle | null } = {},
): FullSidecarLayout {
  const coordinates: CoordsByIdx = {};
  const nonBus: NonBusOverride[] = [];
  const controllers: NonBusCoordsByModel = {};
  const units: FullSidecarLayout['units'] = {};
  for (const n of diagram.nodes) {
    const coord = { x: n.position.x, y: n.position.y };
    if (n.type === 'bus') {
      coordinates[n.id] = coord;
    } else if (isUiCategory(n.type)) {
      const idx = typeof n.data.idx === 'string' ? n.data.idx : n.id.slice(n.type.length + 1);
      const modelClass = typeof n.data.kind === 'string' ? n.data.kind : null;
      const bus = typeof n.data.parentBus === 'string' ? n.data.parentBus : null;
      nonBus.push({ uiCategory: n.type, idx, modelClass, coord, bus });
      // A unit is drawn collapsed unless the layout says otherwise, so only
      // one whose chain is drawn out needs an entry.
      const unit = n.data.unit as { expanded?: unknown } | undefined;
      if (n.type === 'generator' && unit?.expanded === true) units[idx] = { expanded: true, bus };
    } else if (n.type === 'controller' && n.data.placed === true) {
      // A controller that is not placed on its own needs no entry: it is
      // named on the symbol of its unit, or docked beside what it acts on.
      const { kind, idx } = n.data;
      if (typeof kind === 'string' && typeof idx === 'string') {
        (controllers[kind] ??= {})[idx] = coord;
      }
    }
  }

  // Whether a route that was drawn by hand is held for where its two ends
  // stand in this diagram.
  const stands = new Map(diagram.nodes.map((n) => [n.id, n.position]));
  const drawnForHere = (e: DiagramEdge): boolean => {
    const anchors = e.data?.bendAnchors as Partial<RouteAnchors> | undefined;
    const here = (anchor: BusCoord | undefined, id: string | undefined): boolean => {
      const at = id === undefined ? undefined : stands.get(id);
      return (
        anchor !== undefined &&
        at !== undefined &&
        Math.abs(anchor.x - at.x) < 0.01 &&
        Math.abs(anchor.y - at.y) < 0.01
      );
    };
    return here(anchors?.source, e.source) && here(anchors?.target, e.target);
  };

  const branches: FullSidecarLayout['branches'] = {};
  for (const e of diagram.edges) {
    const bucket = e.data?.bucket;
    const idx = e.data?.idx;
    if (typeof bucket !== 'string' || !BRANCH_BUCKETS.has(bucket) || typeof idx !== 'string') {
      continue;
    }
    const chosen = base?.branches?.[bucket]?.[idx];
    const sourceFace = chosen?.source_face ?? null;
    const targetFace = chosen?.target_face ?? null;
    const polyline = e.data?.bendPoints as [number, number][] | undefined;
    const drawnThroughPoints =
      Array.isArray(polyline) &&
      polyline.length >= 2 &&
      polyline.length <= MAX_BEND_POINTS &&
      (e.data?.bendManual !== true || drawnForHere(e));
    if (!drawnThroughPoints && sourceFace === null && targetFace === null) continue;
    (branches[bucket] ??= {})[idx] = {
      routing: !drawnThroughPoints ? 'auto' : e.data?.bendManual === true ? 'manual' : 'polyline',
      bend_points: drawnThroughPoints ? polyline.map(([x, y]) => ({ x, y })) : [],
      bus1: e.source ?? null,
      bus2: e.target ?? null,
      source_face: sourceFace,
      target_face: targetFace,
    };
  }

  const living = elementKeys(topology);
  // The connectors of the devices: the faces a layout chose are carried
  // over, and the points are the ones the diagram draws by hand now. What
  // the layout held for a connector that is worked out again goes.
  const connections: FullSidecarLayout['connections'] = {};
  for (const [outer, inner] of Object.entries(keepLiving(base?.connections, living))) {
    for (const [idx, held] of Object.entries(inner)) {
      const deviceFace = held.device_face ?? null;
      const busFace = held.bus_face ?? null;
      if (deviceFace === null && busFace === null) continue;
      (connections[outer] ??= {})[idx] = {
        device_face: deviceFace,
        bus_face: busFace,
        bend_points: [],
        bus: null,
      };
    }
  }
  const devices = new Map(diagram.nodes.map((n) => [n.id, n]));
  for (const e of diagram.edges) {
    const polyline = e.data?.bendPoints as [number, number][] | undefined;
    const device = e.source === undefined ? undefined : devices.get(e.source);
    if (e.data?.bendManual !== true || device === undefined || !isUiCategory(device.type)) continue;
    if (!Array.isArray(polyline) || polyline.length < 2 || polyline.length > MAX_BEND_POINTS) {
      continue;
    }
    if (!drawnForHere(e)) continue;
    const idx =
      typeof device.data.idx === 'string'
        ? device.data.idx
        : device.id.slice(device.type.length + 1);
    const held = connections[device.type]?.[idx];
    (connections[device.type] ??= {})[idx] = {
      device_face: held?.device_face ?? null,
      bus_face: held?.bus_face ?? null,
      bend_points: polyline.map(([x, y]) => ({ x, y })),
      bus: e.target ?? null,
    };
  }
  const drawnBuses = new Set(Object.keys(coordinates));
  return buildSidecarLayout(coordinates, {
    andesVersion: base?.andes_version,
    nonBusCoords: buildNonBusCoordinates(nonBus),
    sections: {
      controller_coordinates: controllers,
      units,
      busbars: Object.fromEntries(
        Object.entries(base?.busbars ?? {}).filter(([idx]) => drawnBuses.has(idx)),
      ),
      branches,
      label_offsets: keepLiving(base?.label_offsets, living),
      connections,
      figure: {
        ...(base?.figure ?? {}),
        ...(chosen.connectorStyle ? { [CONNECTOR_STYLE_SETTING]: chosen.connectorStyle } : {}),
      },
    },
  });
}

/** Where the two buses of a branch stood when its route was made. */
export interface RouteAnchors {
  source: BusCoord;
  target: BusCoord;
}

/**
 * The route each branch of `topology` is drawn through, for the ones `layout`
 * holds a route of stored points for, as the graph builder takes them: edge id
 * (`line-<idx>`, `transformer-<idx>`) to the polyline. A route with fewer than
 * two points draws nothing and is left out.
 *
 * Matched like the devices (`resolveDeviceCoords`): first by idx, where a
 * route that names its two buses is used only for a branch between them, then
 * by those buses for the branches left over, so the lines of a system that
 * was numbered afresh keep their routes. Two lines between the same buses
 * take the routes left for that pair in the order the layout lists them.
 *
 * `anchors` holds, for each route that names its two buses, where the layout
 * has those buses. Such a route was drawn for them at those places and
 * belongs on the branch for as long as they stand there, wherever on their
 * bars it lands: a tidied route may land past the tip of a bar that was drawn
 * out for it. A route that names no bus has no anchors, and the graph builder
 * judges it by where its two ends lie (`routeFitsBuses`).
 *
 * `manual` names the routes that were drawn by hand, which the diagram keeps
 * as they are and brings along with their buses. One that has no anchors is
 * not among them: there is nothing to bring it along from.
 */
export function storedBranchRoutes(
  layout: SidecarLayout | null,
  topology: TopologySummary,
): {
  polylines: Map<string, [number, number][]>;
  anchors: Map<string, RouteAnchors>;
  manual: Set<string>;
} {
  const out = new Map<string, [number, number][]>();
  const anchors = new Map<string, RouteAnchors>();
  const manual = new Set<string>();
  if (!layout?.branches) return { polylines: out, anchors, manual };
  const drawable = (route: LayoutBranchRoute | undefined): route is LayoutBranchRoute =>
    route !== undefined && route.routing !== 'auto' && (route.bend_points ?? []).length >= 2;
  const polyline = (route: LayoutBranchRoute): [number, number][] =>
    (route.bend_points ?? []).map((point): [number, number] => [point.x, point.y]);
  const anchored = (route: LayoutBranchRoute) =>
    route.bus1 !== undefined &&
    route.bus1 !== null &&
    route.bus2 !== undefined &&
    route.bus2 !== null;
  // A route that is used was stored between the buses its branch has now.
  const anchor = (id: string, route: LayoutBranchRoute, bus1: string, bus2: string): void => {
    const source = layout.coordinates[bus1];
    const target = layout.coordinates[bus2];
    if (!anchored(route) || source === undefined || target === undefined) return;
    anchors.set(id, { source: { x: source.x, y: source.y }, target: { x: target.x, y: target.y } });
    if (route.routing === 'manual') manual.add(id);
  };

  const claimed = new Set<string>();
  const unrouted: { id: string; slot: string; bus1: string; bus2: string }[] = [];
  const collect = (entries: readonly TopologyEntry[], bucket: string) => {
    const routes = layout.branches?.[bucket] ?? {};
    for (const e of entries) {
      const idx = String(e.idx);
      const id = `${bucket}-${idx}`;
      if (out.has(id)) continue;
      const bus1 = busOf(e, 'bus1');
      const bus2 = busOf(e, 'bus2');
      const route = routes[idx];
      if (drawable(route) && (!anchored(route) || (route.bus1 === bus1 && route.bus2 === bus2))) {
        out.set(id, polyline(route));
        claimed.add(`${bucket}|${idx}`);
        if (bus1 !== null && bus2 !== null) anchor(id, route, bus1, bus2);
      } else if (bus1 !== null && bus2 !== null) {
        unrouted.push({ id, slot: `${bucket}|${bus1}|${bus2}`, bus1, bus2 });
      }
    }
  };
  collect(topology.lines, 'line');
  collect(topology.transformers, 'transformer');

  // The routes nobody claimed, by the buses they run between.
  const free = new Map<string, LayoutBranchRoute[]>();
  for (const bucket of BRANCH_BUCKETS) {
    for (const [idx, route] of Object.entries(layout.branches[bucket] ?? {})) {
      if (!drawable(route) || !anchored(route) || claimed.has(`${bucket}|${idx}`)) continue;
      const slot = `${bucket}|${route.bus1}|${route.bus2}`;
      const list = free.get(slot);
      if (list) list.push(route);
      else free.set(slot, [route]);
    }
  }
  for (const { id, slot, bus1, bus2 } of unrouted) {
    const route = free.get(slot)?.shift();
    if (route === undefined) continue;
    out.set(id, polyline(route));
    anchor(id, route, bus1, bus2);
  }
  return { polylines: out, anchors, manual };
}

/**
 * The connectors of devices that `layout` holds as drawn by hand, for the
 * devices `topology` has, as the graph builder takes them: edge id
 * (`stub-<category>-<idx>`) to the points, and to where the layout has the
 * device and its bus, which is what the points were drawn for.
 *
 * A connector goes with the position of its device: it is looked up under
 * the idx that position was found under (`resolveDeviceCoords`: the
 * device's own, or the one it had before the system was numbered afresh),
 * in the layer of its category. One that names a bus is used only for a
 * device on that bus.
 */
export function storedConnectorRoutes(
  layout: SidecarLayout | null,
  topology: TopologySummary,
): { polylines: Map<string, [number, number][]>; anchors: Map<string, RouteAnchors> } {
  const polylines = new Map<string, [number, number][]>();
  const anchors = new Map<string, RouteAnchors>();
  if (!layout?.connections) return { polylines, anchors };
  for (const [key, place] of resolveDevicePlaces(layout.non_bus_coordinates, topology)) {
    const category = key.slice(0, key.indexOf('|'));
    const idx = key.slice(category.length + 1);
    const drawn = layout.connections[category]?.[place.from];
    const points = drawn?.bend_points ?? [];
    const bus = place.bus === null ? undefined : layout.coordinates[place.bus];
    if (drawn === undefined || points.length < 2 || bus === undefined) continue;
    if (drawn.bus !== undefined && drawn.bus !== null && drawn.bus !== place.bus) continue;
    const id = `stub-${category}-${idx}`;
    polylines.set(
      id,
      points.map((point): [number, number] => [point.x, point.y]),
    );
    anchors.set(id, { source: { ...place.coord }, target: { x: bus.x, y: bus.y } });
  }
  return { polylines, anchors };
}

/** The polylines of `storedBranchRoutes`: the route of each branch `layout` holds one for. */
export function branchPolylines(
  layout: SidecarLayout | null,
  topology: TopologySummary,
): Map<string, [number, number][]> {
  return storedBranchRoutes(layout, topology).polylines;
}

/**
 * The routes of `layout` as route overrides, by edge id (`<bucket>-<idx>`
 * for a branch, `stub-<category>-<idx>` for the connector of a device that
 * was drawn by hand): how the routes of a layout are applied to a system
 * that has no case file to keep one beside, as `dragOverridesFromLayout`
 * applies its positions. Only a route that names its two buses is taken,
 * with the places the layout has them at as its anchors, and only a
 * connector whose device and bus the layout places.
 */
export function routeOverridesFromLayout(
  layout: SidecarLayout,
): Record<string, { points: [number, number][]; anchors: RouteAnchors; manual?: true }> {
  const out: Record<string, { points: [number, number][]; anchors: RouteAnchors; manual?: true }> =
    {};
  for (const bucket of BRANCH_BUCKETS) {
    for (const [idx, route] of Object.entries(layout.branches?.[bucket] ?? {})) {
      const points = route.bend_points ?? [];
      if (route.routing === 'auto' || points.length < 2) continue;
      const source = typeof route.bus1 === 'string' ? layout.coordinates[route.bus1] : undefined;
      const target = typeof route.bus2 === 'string' ? layout.coordinates[route.bus2] : undefined;
      if (source === undefined || target === undefined) continue;
      out[`${bucket}-${idx}`] = {
        points: points.map((point): [number, number] => [point.x, point.y]),
        anchors: { source: { x: source.x, y: source.y }, target: { x: target.x, y: target.y } },
        ...(route.routing === 'manual' ? { manual: true as const } : {}),
      };
    }
  }
  for (const category of UI_CATEGORIES) {
    for (const [idx, drawn] of Object.entries(layout.connections?.[category] ?? {})) {
      const points = drawn.bend_points ?? [];
      const device = layout.non_bus_coordinates?.[category]?.[idx];
      const bus = typeof drawn.bus === 'string' ? layout.coordinates[drawn.bus] : undefined;
      if (points.length < 2 || device === undefined || bus === undefined) continue;
      out[`stub-${category}-${idx}`] = {
        points: points.map((point): [number, number] => [point.x, point.y]),
        anchors: { source: { x: device.x, y: device.y }, target: { x: bus.x, y: bus.y } },
        manual: true,
      };
    }
  }
  return out;
}

/**
 * The controllers `layout` places on their own, keyed `${modelClass}|${idx}`
 * as the graph builder looks them up.
 */
export function controllerCoordsAsMap(layout: SidecarLayout | null): Map<string, BusCoord> {
  const out = new Map<string, BusCoord>();
  for (const [modelClass, inner] of Object.entries(layout?.controller_coordinates ?? {})) {
    for (const [idx, coord] of Object.entries(inner)) {
      out.set(`${modelClass}|${idx}`, coord);
    }
  }
  return out;
}

/**
 * What of `layout` still means something once the idx values have changed:
 * the layout to write beside a copy saved in a format that keeps no idx (a
 * PSS/E `.raw`), which comes back with its devices and branches numbered
 * afresh. What is keyed by bus stays. A device position, a branch route and
 * the connector of a device stay when they say which buses they belong to,
 * since the readers above can then find them again; the rest would land on
 * whatever element has their idx by then, and is left out. (The server cuts
 * the layout it copies to such a file down the same way.)
 */
export function layoutForRenumberedCopy(layout: SidecarLayout): FullSidecarLayout {
  const kept = <T>(
    section: Record<string, Record<string, T>> | undefined,
    keep: (entry: T) => boolean,
  ): Record<string, Record<string, T>> => {
    const out: Record<string, Record<string, T>> = {};
    for (const [outer, inner] of Object.entries(section ?? {})) {
      const entries = Object.entries(inner).filter(([, entry]) => keep(entry));
      if (entries.length > 0) out[outer] = Object.fromEntries(entries);
    }
    return out;
  };
  const busLabels = layout.label_offsets?.bus;
  return {
    ...buildSidecarLayout(layout.coordinates, {
      andesVersion: layout.andes_version,
      nonBusCoords: kept(layout.non_bus_coordinates, (c) => c.bus !== undefined && c.bus !== null),
      sections: {
        busbars: layout.busbars ?? {},
        branches: kept(
          layout.branches,
          (r) => r.bus1 !== undefined && r.bus1 !== null && r.bus2 !== undefined && r.bus2 !== null,
        ),
        label_offsets: busLabels && Object.keys(busLabels).length > 0 ? { bus: busLabels } : {},
        connections: kept(layout.connections, (c) => c.bus !== undefined && c.bus !== null),
        figure: layout.figure ?? {},
      },
    }),
    last_modified: layout.last_modified,
  };
}

/**
 * Whether two layouts draw the same diagram: every section equal, whatever
 * their timestamps and version stamps say. A section one of them leaves out
 * counts as empty.
 */
export function samePlacement(a: SidecarLayout, b: SidecarLayout): boolean {
  const drawn = (layout: SidecarLayout): string => {
    const full = { ...buildSidecarLayout({}), ...layout };
    // Keys in a fixed order, so two equal sections written in different
    // orders still compare equal.
    // A field that is `null` is one that is not set: the server writes every
    // optional field out, the capture leaves some of them off.
    const ordered = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(ordered);
      if (value === null || typeof value !== 'object') return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, inner]) => inner !== null && inner !== undefined)
          .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
          .map(([key, inner]) => [key, ordered(inner)]),
      );
    };
    return JSON.stringify(
      ordered({
        coordinates: full.coordinates,
        non_bus_coordinates: full.non_bus_coordinates,
        controller_coordinates: full.controller_coordinates,
        units: full.units,
        busbars: full.busbars,
        branches: full.branches,
        label_offsets: full.label_offsets,
        connections: full.connections,
        figure: full.figure,
      }),
    );
  };
  return drawn(a) === drawn(b);
}

/**
 * The positions of `layout` as drag overrides, keyed by React Flow node id (a
 * bus idx, or `${uiCategory}-${idx}`). It is how a layout is applied to a system
 * that has no case file to keep one beside: a snapshot restored into a system
 * built from scratch. The UI-category layer is read, which the writer always
 * emits; a model-class layer names no node without the topology.
 */
export function dragOverridesFromLayout(layout: SidecarLayout): Record<string, BusCoord> {
  const out: Record<string, BusCoord> = {};
  for (const [idx, coord] of Object.entries(layout.coordinates)) {
    out[idx] = { x: coord.x, y: coord.y };
  }
  for (const [outer, inner] of Object.entries(layout.non_bus_coordinates ?? {})) {
    if (!UI_CATEGORIES.has(outer)) continue;
    for (const [idx, coord] of Object.entries(inner)) {
      out[`${outer}-${idx}`] = { x: coord.x, y: coord.y };
    }
  }
  return out;
}

// ---- debounced PUT --------------------------------------------------------

type PutFn = (layout: SidecarLayout) => void | Promise<void>;

/** The debounced write waiting per case path: its timer, and the write itself. */
const pending = new Map<string, { handle: ReturnType<typeof setTimeout>; send: () => void }>();

/**
 * Schedule a debounced sidecar PUT. Subsequent calls within `delayMs`
 * for the same `casePath` cancel the prior timer and replace its
 * payload. Tests use vitest fake timers to drive deterministic flushing.
 *
 * The actual PUT call is delegated to the `put` callback the consumer
 * provides — usually a thin wrapper over `usePutSidecar.mutate`. Keeping
 * the I/O outside this module keeps the tests pure (no fetch mocks).
 */
export function debouncedPutSidecar(
  casePath: string,
  layout: SidecarLayout,
  put: PutFn,
  delayMs: number = 500,
): void {
  const existing = pending.get(casePath);
  if (existing) {
    clearTimeout(existing.handle);
  }
  const send = () => {
    pending.delete(casePath);
    void put(layout);
  };
  pending.set(casePath, { handle: setTimeout(send, delayMs), send });
}

/**
 * Drop the debounced PUT waiting for a case path, unsent. For when what
 * it would write is no longer wanted: the layout was reset, or a restored
 * snapshot brought its own.
 */
export function cancelPendingSidecarPut(casePath: string): void {
  const existing = pending.get(casePath);
  if (existing) {
    clearTimeout(existing.handle);
    pending.delete(casePath);
  }
}

/**
 * Send the debounced PUT waiting for a case path now, without waiting
 * out its delay. Called when the canvas goes away (another view is shown,
 * another case is opened): the drag it holds is on screen and in the
 * store, and dropping the write would leave the file a drag behind what
 * the diagram shows, until the next drag or save. It goes to the path it
 * was scheduled for, whatever is open by now.
 */
export function flushPendingSidecarPut(casePath: string): void {
  const existing = pending.get(casePath);
  if (existing) {
    clearTimeout(existing.handle);
    existing.send();
  }
}

/** Test helper: clear all pending timers (used by sidecar.test.ts). */
export function __clearAllPendingForTests(): void {
  for (const { handle } of pending.values()) {
    clearTimeout(handle);
  }
  pending.clear();
}
