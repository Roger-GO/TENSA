/**
 * Connecting on the diagram by a drag: what is connected to which bus, and
 * what that asks of the draft or of the system.
 *
 * Three gestures end on a bus (`SldCanvas`, `SldWiring`):
 *
 * - a component is dropped on a bus, from the palette or as a draft that is
 *   dragged there, and is connected to it;
 * - a line or a transformer is drawn from one bus to another;
 * - the end of the connector of a device is dragged to another bus, which
 *   moves the device there.
 *
 * This module is everything about them that needs no canvas. `busBars`
 * and `busAt` say which bus a place on the diagram is on: a bus is its bar,
 * which is a few pixels thick, so a place counts as on it within a reach
 * that the canvas keeps the same on screen whatever the zoom
 * (`BUS_HIT_PX`), and of two bars in reach the nearer one is meant.
 * `busUnderBox` is the same for a symbol that is dragged: the bar its box
 * lies on.
 *
 * `attachDraft` is what connecting a draft to a bus sets on it: `bus` for a
 * device, and for a line or a transformer its first end that is still open
 * (`bus1`, then `bus2`), so one dropped on two buses in turn runs between
 * them. A draft is this browser's alone (`store/drafts.ts`), so nothing is
 * sent anywhere.
 *
 * `moveToBus` is what moving a generator, a load or a shunt of the system
 * to another bus asks of the server: an edit of `bus` on its model, and on
 * every model of a generating unit that names the bus itself (the static
 * generator, the machine that takes it over, a converter or a battery on
 * it), since a machine on another bus than its generator is no unit any
 * more (`generatingUnits`). A model whose rated voltage is that of the bus
 * it leaves is given the rated voltage of the bus it goes to: its values
 * are per unit of its own rating, and ANDES rescales the impedances of a
 * device whose `Vn` is not that of its bus. One that was rated off its bus
 * on purpose keeps its rating. The edits are sent one after the other and
 * taken back together when one is refused (`useEditElements`).
 *
 * Pure: no React, nothing read but the arguments.
 */
import type {
  ParamValue,
  TopologyEntry,
  TopologyParamMeta,
  TopologySchema,
  TopologySummary,
} from '@/api/types';
import { generatingUnits } from '@/lib/generatingUnits';
import {
  BAR_LENGTH,
  BAR_THICKNESS,
  type ConnectionLayout,
  type ConnectionNode,
  type Point,
  type Rect,
} from './connections';

/**
 * How near to a bar the pointer has to be, in pixels on screen, to be on
 * its bus. A bar is `BAR_THICKNESS` thick, which no drop can be aimed at.
 */
export const BUS_HIT_PX = 14;

/** The kinds of the palette that are drawn between two buses. */
export type BranchKind = 'Line' | 'Transformer2W';

/** What a branch of each kind is called in a sentence. */
export const BRANCH_NOUN: Record<BranchKind, string> = {
  Line: 'line',
  Transformer2W: 'transformer',
};

export function isBranchKind(kind: string): kind is BranchKind {
  return kind === 'Line' || kind === 'Transformer2W';
}

/** The bar of a bus as it is drawn: where a connection can be dropped. */
export interface BusBar {
  /** The id of the bus node, which is the idx of the bus as text. */
  id: string;
  name: string;
  box: Rect;
}

/** `bus 5`, or `bus 5 (BUS5)` where the diagram shows a name that is not the idx. */
export function busTitle(bus: Pick<BusBar, 'id' | 'name'>): string {
  return bus.name === '' || bus.name === bus.id ? `bus ${bus.id}` : `bus ${bus.id} (${bus.name})`;
}

/** The bars of the buses among `nodes`, as `connections` draws them. */
export function busBars(
  nodes: readonly (ConnectionNode & { data?: unknown })[],
  connections: Pick<ConnectionLayout, 'bars'>,
): BusBar[] {
  const bars: BusBar[] = [];
  for (const node of nodes) {
    if ((node.type ?? 'bus') !== 'bus') continue;
    const bar = connections.bars.get(node.id);
    const name = (node.data as { name?: unknown } | undefined)?.name;
    bars.push({
      id: node.id,
      name: typeof name === 'string' && name !== '' ? name : node.id,
      box: {
        left: node.position.x + (bar?.start ?? 0),
        right: node.position.x + (bar?.end ?? BAR_LENGTH),
        top: node.position.y,
        bottom: node.position.y + BAR_THICKNESS,
      },
    });
  }
  return bars;
}

/** How far `point` is from `box`; zero inside it. */
function distanceToBox(point: { x: number; y: number }, box: Rect): number {
  const dx = Math.max(box.left - point.x, 0, point.x - box.right);
  const dy = Math.max(box.top - point.y, 0, point.y - box.bottom);
  return Math.hypot(dx, dy);
}

/**
 * The bus whose bar is within `reach` of `point`, the nearest of them, or
 * `null` when `point` is on none.
 */
export function busAt(
  point: { x: number; y: number },
  bars: readonly BusBar[],
  reach: number,
): string | null {
  let best: { id: string; far: number } | null = null;
  for (const bar of bars) {
    const far = distanceToBox(point, bar.box);
    if (far <= reach && (best === null || far < best.far)) best = { id: bar.id, far };
  }
  return best?.id ?? null;
}

/**
 * The bus a symbol that stands in `box` was put on: the one whose bar the
 * box lies on, and of several the one nearest to the middle of the box.
 * `null` when it lies on none.
 */
export function busUnderBox(box: Rect, bars: readonly BusBar[]): string | null {
  const middle = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
  let best: { id: string; far: number } | null = null;
  for (const bar of bars) {
    const apart =
      bar.box.left > box.right ||
      bar.box.right < box.left ||
      bar.box.top > box.bottom ||
      bar.box.bottom < box.top;
    if (apart) continue;
    const far = distanceToBox(middle, bar.box);
    if (best === null || far < best.far) best = { id: bar.id, far };
  }
  return best?.id ?? null;
}

/** The place on the bar `box` that is nearest to `toward`: where a line to there leaves it. */
export function nearestOnBar(box: Rect, toward: { x: number; y: number }): Point {
  return [Math.min(box.right, Math.max(box.left, toward.x)), (box.top + box.bottom) / 2];
}

// ---- drafts -------------------------------------------------------------------

/** The fields of a model that name a bus, in the order its form shows them. */
export function busFields(metas: readonly TopologyParamMeta[] | null | undefined): string[] {
  return (metas ?? []).filter((m) => m.kind === 'bus_idx').map((m) => m.name);
}

/** Whether a component with the fields `metas` is connected to a bus at all. */
export function connectsToBus(metas: readonly TopologyParamMeta[] | null | undefined): boolean {
  return busFields(metas).length > 0;
}

export interface DraftAttached {
  /** What to set on the draft. */
  patch: Record<string, ParamValue>;
  /** The field the bus went into. */
  field: string;
  /**
   * For a line or a transformer: the bus it starts at and the bus it goes to
   * once the patch is in, `null` for an end that is still open.
   */
  ends?: { from: string | null; to: string | null };
}

/**
 * What connecting a draft to the bus `bus` sets on it, or why it cannot be
 * connected there. `metas` are the fields of the model the draft is sent as
 * and `values` what its form shows (`draftStatus`); `label` is what the
 * kind is called (`PQ load`).
 */
export function attachDraft(
  label: string,
  metas: readonly TopologyParamMeta[] | null | undefined,
  values: Readonly<Record<string, ParamValue>>,
  bus: string,
): DraftAttached | { refused: string } {
  const fields = busFields(metas);
  const held = (field: string): string | null => {
    const value = values[field];
    return value === undefined || value === '' ? null : String(value);
  };
  const [first, second] = fields;
  if (first === undefined) {
    return { refused: `A ${label} is not connected to a bus, so it stays where it stands.` };
  }
  if (second === undefined) {
    if (held(first) === bus) return { refused: `It is on bus ${bus} already.` };
    return { patch: { [first]: bus }, field: first };
  }
  const [from, to] = [held(first), held(second)];
  if (from === bus || to === bus) {
    return {
      refused: `It ends on bus ${bus} already, and both ends of a branch cannot be on one bus.`,
    };
  }
  // The first end that is open; with both set, the far end is the one moved.
  const field = from === null ? first : second;
  return {
    patch: { [field]: bus },
    field,
    ends: field === first ? { from: bus, to } : { from, to: bus },
  };
}

/** The values a line or a transformer drawn from the bus `from` to the bus `to` starts with. */
export function branchValues(from: string, to: string): Record<string, ParamValue> {
  return { bus1: from, bus2: to };
}

// ---- devices of the system ----------------------------------------------------

/** One edit of an element, as `PUT /sessions/{id}/elements/{model}/{idx}` takes it. */
export interface ElementEdit {
  model: string;
  idx: string;
  params: Record<string, ParamValue>;
}

export interface BusMove {
  /** The bus it is on, and the bus it goes to, by idx as text. */
  from: string;
  to: string;
  /** The edits that move it, in the order they are sent. */
  edits: ElementEdit[];
  /** The rated voltage that goes with it, when the two buses differ in theirs; else `null`. */
  rated: { from: number; to: number } | null;
}

/** The node types of the devices that hang off a bus by a connector. */
const DEVICE_BUCKET: Readonly<Record<string, 'loads' | 'shunts'>> = {
  load: 'loads',
  shunt: 'shunts',
};

function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const same = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));

/**
 * What moving the device drawn as the node `nodeId` to the bus `bus` asks
 * of the server, or why it cannot be moved there. A node of a generating
 * unit stands for all its models.
 */
export function moveToBus(
  topology: TopologySummary,
  schema: TopologySchema | null | undefined,
  nodeId: string,
  bus: string,
): BusMove | { refused: string } {
  const dash = nodeId.indexOf('-');
  const type = dash < 0 ? '' : nodeId.slice(0, dash);
  const idx = dash < 0 ? '' : nodeId.slice(dash + 1);
  let entries: TopologyEntry[];
  if (type === 'generator') {
    const unit = generatingUnits(topology).units.find((u) => u.idx === idx);
    entries = (unit?.members ?? []).map((m) => m.entry);
  } else {
    const bucket = DEVICE_BUCKET[type];
    const list = bucket === undefined ? [] : (topology[bucket] ?? []);
    entries = list.filter((e) => String(e.idx) === idx);
  }
  const root = entries[0];
  const from = root?.params?.bus;
  if (root === undefined || from === undefined || from === '') {
    return { refused: 'It is no longer on the diagram, or it names no bus.' };
  }
  const name = root.name || String(root.idx);
  const fromBus = String(from);
  if (fromBus === bus) return { refused: `${name} is on bus ${bus} already.` };
  const busEntry = (id: string) => topology.buses.find((b) => String(b.idx) === id);
  const target = busEntry(bus);
  if (target === undefined) return { refused: `The system has no bus ${bus}.` };
  const [ratedFrom, ratedTo] = [
    numberOf(busEntry(fromBus)?.params?.Vn),
    numberOf(target.params?.Vn),
  ];
  const edits: ElementEdit[] = [];
  let rated: BusMove['rated'] = null;
  for (const entry of entries) {
    // Of a unit, the models that name the bus themselves; the others follow
    // the machine or the generator they name.
    if (String(entry.params?.bus ?? '') !== fromBus) continue;
    const metas = schema?.models[entry.kind] ?? [];
    if (!metas.some((m) => m.name === 'bus' && m.kind === 'bus_idx')) {
      return {
        refused: `The bus of a ${entry.kind} cannot be changed here. Delete it and add it on bus ${bus}.`,
      };
    }
    const params: Record<string, ParamValue> = { bus: target.idx };
    const own = numberOf(entry.params?.Vn);
    if (
      own !== null &&
      ratedFrom !== null &&
      ratedTo !== null &&
      same(own, ratedFrom) &&
      !same(ratedFrom, ratedTo) &&
      metas.some((m) => m.name === 'Vn')
    ) {
      params.Vn = ratedTo;
      rated = { from: ratedFrom, to: ratedTo };
    }
    edits.push({ model: entry.kind, idx: String(entry.idx), params });
  }
  if (edits.length === 0) return { refused: `${name} names no bus that could be changed.` };
  return { from: fromBus, to: bus, edits, rated };
}

/** `PV 3`, `PV 3 and GENROU_3`, `A, B and C`: the models an edit of several moved. */
export function movedModels(edits: readonly ElementEdit[]): string {
  const names = edits.map((e) => (e.idx.startsWith(e.model) ? e.idx : `${e.model} ${e.idx}`));
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// ---- picking a bus ------------------------------------------------------------

/** What a bus is being picked for (`SldWiring`). */
export type WiringMode =
  /** A line or a transformer from the bus `from`, once that is picked, to the one picked next. */
  | { kind: 'draw'; model: BranchKind; from: string | null }
  /**
   * The device or draft drawn as the node `nodeId`, to be on the bus that is
   * picked: `bus` is the one it is on now, `null` for a draft that is on none.
   */
  | { kind: 'move'; nodeId: string; name: string; bus: string | null };

/** What the bar over the diagram is called while a bus is picked for `mode`. */
export function wiringTitle(mode: WiringMode): string {
  if (mode.kind === 'draw') return `Draw a ${BRANCH_NOUN[mode.model]}`;
  return mode.bus === null ? `Connect ${mode.name}` : `Move ${mode.name} to another bus`;
}

/** What that bar says to do next. */
export function wiringHint(mode: WiringMode, bars: readonly BusBar[]): string {
  const named = (id: string): string => {
    const bar = bars.find((b) => b.id === id);
    return bar === undefined ? `bus ${id}` : busTitle(bar);
  };
  if (mode.kind === 'draw') {
    return mode.from === null
      ? 'Click the bus it starts from and then the bus it goes to, or drag from one to the other. Esc cancels.'
      : `From ${named(mode.from)}: now click the bus it goes to. Esc cancels.`;
  }
  return mode.bus === null
    ? 'Click the bus to connect it to. Esc cancels.'
    : `It is on ${named(mode.bus)}. Click the bus to move it to, or drag the ring at the end of its connector onto that bus. Esc cancels.`;
}
