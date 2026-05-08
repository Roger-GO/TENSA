/**
 * SLD layout sidecar — schema validation + drift detection + debounced
 * persistence helpers.
 *
 * The sidecar is a JSON document keyed by bus idx (stringified) that
 * stores the canvas position of each bus for one case. Lifecycle:
 *
 * - On case load: `GET /workspace/layout?case_path=<rel>` (Unit 5b
 *   hook — `useGetSidecar`). If 404, run auto-layout. If found, run
 *   `mergeWithDrift` against the topology to produce the final coords
 *   the canvas renders.
 * - On user drag (debounced ~500 ms): `PUT /workspace/layout?case_path=
 *   <rel>` with the updated coordinates. `debouncedPutSidecar` below
 *   coalesces rapid drags into a single PUT.
 *
 * No external dep on Zod; the validator is a hand-written shape check
 * — keeps the bundle smaller and the failure paths easier to read.
 */
import type { SidecarLayout, BusCoord, TopologySummary } from '@/api/types';

/** Current sidecar schema version. Bumped on incompatible shape changes. */
export const SIDECAR_SCHEMA_VERSION = '1';

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
export type NonBusCoordsByModel = Record<string, Record<string, BusCoord>>;

/** UI categories the canvas tags non-bus React Flow nodes with. */
const UI_CATEGORIES: ReadonlySet<string> = new Set(['generator', 'load', 'shunt']);

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

/**
 * Validate that a JSON-parsed object matches the SidecarLayout shape.
 *
 * Returns the value as a typed `SidecarLayout` on success. Throws a
 * `TypeError` with a precise path on failure — sidecar files are user-
 * editable, so a clear error message earns its keep.
 */
export function parseSidecar(input: unknown): SidecarLayout {
  if (!input || typeof input !== 'object') {
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
  if (!obj.coordinates || typeof obj.coordinates !== 'object') {
    throw new TypeError('sidecar.coordinates: expected object');
  }
  const rawCoords = obj.coordinates as Record<string, unknown>;
  const coords: Record<string, BusCoord> = {};
  for (const [key, raw] of Object.entries(rawCoords)) {
    if (!raw || typeof raw !== 'object') {
      throw new TypeError(`sidecar.coordinates[${key}]: expected object`);
    }
    const c = raw as Record<string, unknown>;
    if (typeof c.x !== 'number' || !Number.isFinite(c.x)) {
      throw new TypeError(`sidecar.coordinates[${key}].x: expected finite number`);
    }
    if (typeof c.y !== 'number' || !Number.isFinite(c.y)) {
      throw new TypeError(`sidecar.coordinates[${key}].y: expected finite number`);
    }
    coords[key] = { x: c.x, y: c.y };
  }
  // `non_bus_coordinates` is optional — old sidecars without the field
  // (incl. every curated layout shipped before v0.1.y) read as `{}`.
  const nonBusCoords: NonBusCoordsByModel = {};
  if (obj.non_bus_coordinates !== undefined) {
    if (
      !obj.non_bus_coordinates ||
      typeof obj.non_bus_coordinates !== 'object' ||
      Array.isArray(obj.non_bus_coordinates)
    ) {
      throw new TypeError('sidecar.non_bus_coordinates: expected object');
    }
    const rawNonBus = obj.non_bus_coordinates as Record<string, unknown>;
    for (const [outer, inner] of Object.entries(rawNonBus)) {
      if (!inner || typeof inner !== 'object' || Array.isArray(inner)) {
        throw new TypeError(`sidecar.non_bus_coordinates[${outer}]: expected object`);
      }
      const innerEntries: Record<string, BusCoord> = {};
      for (const [idx, raw] of Object.entries(inner as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object') {
          throw new TypeError(`sidecar.non_bus_coordinates[${outer}][${idx}]: expected object`);
        }
        const c = raw as Record<string, unknown>;
        if (typeof c.x !== 'number' || !Number.isFinite(c.x)) {
          throw new TypeError(
            `sidecar.non_bus_coordinates[${outer}][${idx}].x: expected finite number`,
          );
        }
        if (typeof c.y !== 'number' || !Number.isFinite(c.y)) {
          throw new TypeError(
            `sidecar.non_bus_coordinates[${outer}][${idx}].y: expected finite number`,
          );
        }
        innerEntries[idx] = { x: c.x, y: c.y };
      }
      nonBusCoords[outer] = innerEntries;
    }
  }
  return {
    schema_version: obj.schema_version,
    andes_version: obj.andes_version,
    last_modified: obj.last_modified,
    coordinates: coords,
    non_bus_coordinates: nonBusCoords,
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
 * One non-bus drag override the writer needs to persist. The drag
 * override map keyed by React Flow node id (`${uiCategory}-${idx}`) does
 * NOT carry the ANDES model class on its own — the caller (e.g.,
 * `SaveSystemButton.writeSidecarAlongside`) resolves the model class from
 * the topology before passing the entries here. Entries with a `null`
 * `modelClass` get written ONLY under the UI-category layer (the
 * model-class fallback is omitted).
 */
export interface NonBusOverride {
  /** UI category React Flow tagged the node with. */
  uiCategory: 'generator' | 'load' | 'shunt';
  /** Element idx (stringified). */
  idx: string;
  /** ANDES model class name (e.g., `PV`, `GENROU`, `PQ`). `null` if unknown. */
  modelClass: string | null;
  /** The dragged coordinate. */
  coord: BusCoord;
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
  const ensureLayer = (key: string): Record<string, BusCoord> => {
    let layer = out[key];
    if (!layer) {
      layer = {};
      out[key] = layer;
    }
    return layer;
  };
  for (const o of overrides) {
    if (o.modelClass) {
      ensureLayer(o.modelClass)[o.idx] = { x: o.coord.x, y: o.coord.y };
    }
    ensureLayer(o.uiCategory)[o.idx] = { x: o.coord.x, y: o.coord.y };
  }
  return out;
}

/**
 * Resolve a sidecar's `non_bus_coordinates` into the per-(model|idx)
 * Map the graph builder consumes. Builds two views simultaneously:
 *
 * - exact `${modelClass}|${idx}` keys for entries the sidecar saved
 *   under the precise model-class layer.
 * - fallback `${uiCategory}|${idx}` keys (computed from the entry's
 *   outer key when it matches a known UI category).
 *
 * The graph builder reads model-class first (`PV|1`) and the writer
 * already wrote that key on save, so the precise hit lands in the same
 * Map. When the model class changed since save (kind-edit case), the
 * graph builder won't find `GENROU|1` directly — it should fall back to
 * the UI-category key (`generator|1`) to recover the dragged position.
 *
 * The returned Map carries BOTH key shapes side by side. Conflicts
 * (same key written twice from different layers) prefer the
 * model-class layer because it iterates first.
 */
export function nonBusCoordsAsMap(nonBus: NonBusCoordsByModel | undefined): Map<string, BusCoord> {
  const out = new Map<string, BusCoord>();
  if (!nonBus) return out;
  // Pass 1: UI-category layers — fold into `${uiCategory}|${idx}`. We
  // walk these first so the model-class pass overrides on conflict.
  for (const [outer, inner] of Object.entries(nonBus)) {
    if (!UI_CATEGORIES.has(outer)) continue;
    for (const [idx, coord] of Object.entries(inner)) {
      out.set(`${outer}|${idx}`, coord);
    }
  }
  // Pass 2: model-class layers — fold into `${modelClass}|${idx}`. The
  // graph builder's primary lookup hits these on the no-edit path.
  for (const [outer, inner] of Object.entries(nonBus)) {
    if (UI_CATEGORIES.has(outer)) continue;
    for (const [idx, coord] of Object.entries(inner)) {
      out.set(`${outer}|${idx}`, coord);
    }
  }
  return out;
}

/**
 * Build a fresh sidecar payload from the current coordinate map. Used by
 * `debouncedPutSidecar` and by curated-layout-export tooling.
 *
 * Pass `nonBusCoords` to persist generator/load/shunt drag positions
 * alongside the bus coords. Defaults to an empty object when omitted —
 * old call sites that only persist bus coords keep working unchanged.
 */
export function buildSidecarLayout(
  coords: CoordsByIdx,
  options: {
    andesVersion?: string;
    nonBusCoords?: NonBusCoordsByModel;
  } = {},
): SidecarLayout {
  return {
    schema_version: SIDECAR_SCHEMA_VERSION,
    andes_version: options.andesVersion ?? 'unknown',
    last_modified: new Date().toISOString(),
    coordinates: coords,
    non_bus_coordinates: options.nonBusCoords ?? {},
  };
}

// ---- debounced PUT --------------------------------------------------------

type PutFn = (layout: SidecarLayout) => void | Promise<void>;

/** Internal handle for the most recent debounced timer per case path. */
const pending = new Map<string, ReturnType<typeof setTimeout>>();

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
    clearTimeout(existing);
  }
  const handle = setTimeout(() => {
    pending.delete(casePath);
    void put(layout);
  }, delayMs);
  pending.set(casePath, handle);
}

/**
 * Cancel any pending debounced PUT for a case path. Called when the
 * user changes case (no point flushing the prior layout to a stale
 * path) or the canvas unmounts.
 */
export function cancelPendingSidecarPut(casePath: string): void {
  const existing = pending.get(casePath);
  if (existing) {
    clearTimeout(existing);
    pending.delete(casePath);
  }
}

/** Test helper: clear all pending timers (used by sidecar.test.ts). */
export function __clearAllPendingForTests(): void {
  for (const handle of pending.values()) {
    clearTimeout(handle);
  }
  pending.clear();
}
