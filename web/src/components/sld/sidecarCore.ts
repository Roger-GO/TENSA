/**
 * The part of the layout sidecar that is read before the diagram is: what a
 * save, a snapshot and a saved copy need of a layout, and the write that
 * waits for a drag to end.
 *
 * `sidecar.ts` describes the layout file and holds the rest: reading and
 * checking one, fitting it to a topology, and capturing the diagram as it
 * is drawn, which only the diagram does. That module is loaded with the
 * diagram; this one is small enough for the first screen, where the hooks
 * that save and restore are. What the app uses of it is also exported from
 * `sidecar.ts`, which is where the diagram and the tests take it from.
 *
 * - `hasSavedPositions`: whether a layout places anything at all.
 * - `buildSidecarLayout`: a layout with every section present.
 * - `connectorStyleOf`, `unitStatesOf`, `dragOverridesFromLayout`,
 *   `routeOverridesFromLayout`: a layout as the store holds a diagram, for
 *   a snapshot that is restored into a system with no case file.
 * - `layoutForRenumberedCopy`, `samePlacement`: what goes beside a copy
 *   saved in a format that keeps no idx, and whether two layouts draw the
 *   same diagram.
 * - `debouncedPutSidecar` and the three that cancel, flush and clear it.
 */
import type { SidecarLayout, BusCoord, LayoutDeviceCoord } from '@/api/types';
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
export const UI_CATEGORIES: ReadonlySet<string> = new Set(['generator', 'load', 'shunt']);

/** The branch buckets a route is filed under, which are also the edge-id prefixes. */
export const BRANCH_BUCKETS: ReadonlySet<string> = new Set(['line', 'transformer']);

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

/** Where the two buses of a branch stood when its route was made. */
export interface RouteAnchors {
  source: BusCoord;
  target: BusCoord;
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
