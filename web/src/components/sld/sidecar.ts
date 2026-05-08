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
  return {
    schema_version: obj.schema_version,
    andes_version: obj.andes_version,
    last_modified: obj.last_modified,
    coordinates: coords,
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
 * Build a fresh sidecar payload from the current coordinate map. Used by
 * `debouncedPutSidecar` and by curated-layout-export tooling.
 */
export function buildSidecarLayout(
  coords: CoordsByIdx,
  options: { andesVersion?: string } = {},
): SidecarLayout {
  return {
    schema_version: SIDECAR_SCHEMA_VERSION,
    andes_version: options.andesVersion ?? 'unknown',
    last_modified: new Date().toISOString(),
    coordinates: coords,
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
