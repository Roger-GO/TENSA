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
 * sections it knows and carries the rest through unchanged, so a section
 * another part of the diagram writes is never lost by a drag.
 *
 * Entries are keyed by ANDES idx, and an idx does not always keep its
 * meaning: a PSS/E `.raw` file holds none, so a system saved as one comes
 * back with its devices and branches numbered afresh, and a deleted
 * element can give its idx to the next one added. A device position and a
 * branch route therefore say what they are anchored to (the device's bus,
 * the branch's two buses). `resolveDeviceCoords` and `branchPolylines` use
 * an entry only for an element on those buses, and match an entry whose
 * idx no longer fits to the element that is there now.
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

function routeAt(value: unknown, path: string): LayoutBranchRoute {
  const r = objectAt(value, path);
  const routing = r.routing ?? 'auto';
  if (routing !== 'auto' && routing !== 'polyline') {
    throw new TypeError(`${path}.routing: expected auto or polyline`);
  }
  let bendPoints: BusCoord[] = [];
  if (r.bend_points !== undefined) {
    if (!Array.isArray(r.bend_points)) {
      throw new TypeError(`${path}.bend_points: expected array`);
    }
    if (r.bend_points.length > MAX_BEND_POINTS) {
      throw new TypeError(`${path}.bend_points: at most ${MAX_BEND_POINTS} points`);
    }
    bendPoints = r.bend_points.map((point, i) => coordAt(point, `${path}.bend_points[${i}]`));
  }
  return {
    routing,
    bend_points: bendPoints,
    bus1: anchorAt(r.bus1, `${path}.bus1`),
    bus2: anchorAt(r.bus2, `${path}.bus2`),
    source_face: sideAt(r.source_face, `${path}.source_face`),
    target_face: sideAt(r.target_face, `${path}.target_face`),
  };
}

function figureAt(value: unknown, path: string): FullSidecarLayout['figure'] {
  return mapAt(value, path, (setting, settingPath) => {
    if (typeof setting === 'boolean' || typeof setting === 'string') return setting;
    return finiteAt(setting, settingPath);
  });
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
      const expanded = objectAt(value, path).expanded ?? false;
      if (typeof expanded !== 'boolean') {
        throw new TypeError(`${path}.expanded: expected boolean`);
      }
      return { expanded };
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
    out.set(key, { x: entry.x, y: entry.y });
    claimed.add(key);
  }

  // The entries nobody claimed, by category and bus, in the order the layout lists them.
  const free = new Map<string, LayoutDeviceCoord[]>();
  for (const category of UI_CATEGORIES) {
    for (const [idx, entry] of Object.entries(nonBus[category] ?? {})) {
      if (entry.bus === undefined || entry.bus === null) continue;
      if (claimed.has(`${category}|${idx}`)) continue;
      const slot = `${category}|${entry.bus}`;
      const list = free.get(slot);
      if (list) list.push(entry);
      else free.set(slot, [entry]);
    }
  }
  for (const device of unplaced) {
    const key = `${device.category}|${device.idx}`;
    if (device.bus === null || out.has(key)) continue;
    const entry = free.get(`${device.category}|${device.bus}`)?.shift();
    if (entry !== undefined) out.set(key, { x: entry.x, y: entry.y });
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
 * The layout of the diagram as it is drawn: the position of every bus and
 * device, the controllers that were placed on their own, and the route of
 * every branch drawn through fixed points. This is what goes with a saved
 * system, so a reload draws the same picture whatever placed the nodes
 * (a drag, the curated layout of the case, or auto-layout).
 *
 * `base` is the layout the diagram was drawn from. The sections the canvas
 * does not draw from yet (unit state, busbars, label offsets, connection
 * faces, figure settings) and a branch's chosen faces are carried over from
 * it, minus the entries of elements `topology` no longer has, so a drag never
 * loses what another editor of the layout wrote.
 */
export function captureLayout(
  diagram: { nodes: ReadonlyArray<DiagramNode>; edges: ReadonlyArray<DiagramEdge> },
  topology: TopologySummary,
  base: SidecarLayout | null,
): FullSidecarLayout {
  const coordinates: CoordsByIdx = {};
  const nonBus: NonBusOverride[] = [];
  const controllers: NonBusCoordsByModel = {};
  for (const n of diagram.nodes) {
    const coord = { x: n.position.x, y: n.position.y };
    if (n.type === 'bus') {
      coordinates[n.id] = coord;
    } else if (isUiCategory(n.type)) {
      const idx = typeof n.data.idx === 'string' ? n.data.idx : n.id.slice(n.type.length + 1);
      const modelClass = typeof n.data.kind === 'string' ? n.data.kind : null;
      const bus = typeof n.data.parentBus === 'string' ? n.data.parentBus : null;
      nonBus.push({ uiCategory: n.type, idx, modelClass, coord, bus });
    } else if (n.type === 'controller' && n.data.placed === true) {
      // A docked controller follows its device and needs no entry.
      const { kind, idx } = n.data;
      if (typeof kind === 'string' && typeof idx === 'string') {
        (controllers[kind] ??= {})[idx] = coord;
      }
    }
  }

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
      Array.isArray(polyline) && polyline.length >= 2 && polyline.length <= MAX_BEND_POINTS;
    if (!drawnThroughPoints && sourceFace === null && targetFace === null) continue;
    (branches[bucket] ??= {})[idx] = {
      routing: drawnThroughPoints ? 'polyline' : 'auto',
      bend_points: drawnThroughPoints ? polyline.map(([x, y]) => ({ x, y })) : [],
      bus1: e.source ?? null,
      bus2: e.target ?? null,
      source_face: sourceFace,
      target_face: targetFace,
    };
  }

  const living = elementKeys(topology);
  const drawnBuses = new Set(Object.keys(coordinates));
  const drawnUnits = new Set(nonBus.filter((o) => o.uiCategory === 'generator').map((o) => o.idx));
  return buildSidecarLayout(coordinates, {
    andesVersion: base?.andes_version,
    nonBusCoords: buildNonBusCoordinates(nonBus),
    sections: {
      controller_coordinates: controllers,
      units: Object.fromEntries(
        Object.entries(base?.units ?? {}).filter(([idx]) => drawnUnits.has(idx)),
      ),
      busbars: Object.fromEntries(
        Object.entries(base?.busbars ?? {}).filter(([idx]) => drawnBuses.has(idx)),
      ),
      branches,
      label_offsets: keepLiving(base?.label_offsets, living),
      connections: keepLiving(base?.connections, living),
      figure: { ...(base?.figure ?? {}) },
    },
  });
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
 */
export function branchPolylines(
  layout: SidecarLayout | null,
  topology: TopologySummary,
): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  if (!layout?.branches) return out;
  const drawable = (route: LayoutBranchRoute | undefined): route is LayoutBranchRoute =>
    route !== undefined && route.routing === 'polyline' && (route.bend_points ?? []).length >= 2;
  const polyline = (route: LayoutBranchRoute): [number, number][] =>
    (route.bend_points ?? []).map((point): [number, number] => [point.x, point.y]);
  const anchored = (route: LayoutBranchRoute) =>
    route.bus1 !== undefined &&
    route.bus1 !== null &&
    route.bus2 !== undefined &&
    route.bus2 !== null;

  const claimed = new Set<string>();
  const unrouted: { id: string; slot: string }[] = [];
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
      } else if (bus1 !== null && bus2 !== null) {
        unrouted.push({ id, slot: `${bucket}|${bus1}|${bus2}` });
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
  for (const { id, slot } of unrouted) {
    const route = free.get(slot)?.shift();
    if (route !== undefined) out.set(id, polyline(route));
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
 * afresh. What is keyed by bus stays. A device position and a branch route
 * stay when they say which buses they belong to, since the readers above
 * can then find them again; the rest would land on whatever element has
 * their idx by then, and is left out. (The server cuts the layout it copies
 * to such a file down the same way.)
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
