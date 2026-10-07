/**
 * Where the labels of the diagram stand: the name and the values under the
 * bar of a bus, the P / Q readout of a generator or load, and the flow label
 * of a line or the symbol of a transformer.
 *
 * Each is placed from the diagram as it is drawn (the nodes where they are,
 * the bars and the routes `layoutConnections` worked out), one kind after
 * the other, each clear of the ones before it:
 *
 * - The symbol of a transformer stands on a straight run of its route,
 *   clear of the symbols, the bars and the other lines
 *   (`placeTransformerSymbols`). It is part of the line and is always
 *   drawn, so it is placed first, the routes are held to it (`routing.ts`),
 *   and every label after it keeps off it.
 * - The label of a bus hangs under its bar and moves along it, clear of the
 *   connectors that land on the south face, of the runs that pass under the
 *   bar, of the symbols and the bars that stand there, and of the label of a
 *   bus placed before it (`busLabelClear`, which `busLabelPlace` in
 *   `connections.ts` takes). Where the strip under the bar has no place for
 *   it and the strip over the bar has, it stands over the bar, and with no
 *   place in either it stands beside a tip of the bar, level with it, or
 *   right under or over the bar a little way past a tip. It stays next to
 *   its bar: where the name with the voltage and the angle under it has no
 *   such place, the name alone is looked for one (`compact`; the values
 *   are in the tables and in the tooltip of the label), and only a name
 *   that has none either stands further off (`placeBusLabels`), where
 *   nothing that belongs to another bus stands or runs between it and its
 *   bar: a name with the connector of another bus's load in between reads
 *   as the name of that bus. For the same reason no label stands right
 *   under the bar of another bus (`UNDER_ANOTHER_BAR`), where the label of
 *   that bus would hang.
 * - The readout of a device hangs off the face its connector leaves by,
 *   beside the connector: on its right, or on its left, whichever no
 *   connector runs through and nothing stands in. With neither it goes to
 *   the far side of the device, then beside its symbol, and with no place
 *   free it is left off (`placeReadouts`): the values are in the tables and
 *   in the Inspector, and a readout drawn over a line or a symbol can be
 *   read on neither. Every device gets its first choice before any gets its
 *   second.
 * - The flow label of a line stands on a straight run of its route, or
 *   beside one, where it covers least (`placeBranchLabels`, over
 *   `branchLabelPlaces` in `connections.ts`), and a little way off the
 *   symbol of every device (`LABEL_ROOM`): flush against one, it reads as
 *   part of it. One that has no place clear of everything else is left off
 *   as well; the arrow of the flow stays on the line.
 *
 * `readoutReserve` is what Tidy diagram asks for before it routes: the
 * places each readout would take with no branch drawn, of which a tidied
 * route leaves each device one where it can (`TidyOptions.keepFree`).
 *
 * A generator carries a mark on its top right corner when its reactive
 * output is on or past a limit, which hangs out of its box
 * (`limitMarkerBox`). Every label keeps off the room of that mark as it
 * keeps off the symbol, on every generator, so a power flow that puts a
 * mark there puts it on nothing.
 *
 * The sizes are the ones the diagram takes a label to have, not the ones a
 * browser gives it: `BusNode` places the label of a bus by the same width
 * (`busLabelWidth`), so that what is worked out here is what is drawn.
 *
 * Pure: no React, no React Flow, nothing read but the arguments.
 */
import {
  BAR_LENGTH,
  BAR_THICKNESS,
  TRANSFORMER_SYMBOL_SIZE,
  branchLabelPlaces,
  busLabelPlace,
  labelBoxAt,
  routesThrough,
  runsIn,
  type BarGeometry,
  type ConnectionEdge,
  type ConnectionLayout,
  type ConnectionNode,
  type LabelPlace,
  type NodeSize,
  type Rect,
} from './connections';
import {
  DEVICE_VALUE_LABEL,
  NODE_FOOTPRINT,
  readoutPlaces,
  unitChainPlaces,
  unitChainSize,
  type UnitNodeData,
} from './graph';

/** A node as the labels are placed against it: what the connection pass reads, and its data. */
export interface LabelNode extends ConnectionNode {
  data?: Record<string, unknown>;
}

/**
 * The room the label of a branch is given when its place is looked for: the
 * flow and loading of a line at their longest (`LineFlowLabel`), and the
 * symbol of a transformer (`TransformerEdge`).
 */
export const LINE_LABEL_BOX = { width: 84, height: 19 };
export const TRANSFORMER_LABEL_BOX = {
  width: TRANSFORMER_SYMBOL_SIZE,
  height: TRANSFORMER_SYMBOL_SIZE,
};

/**
 * How wide the flow label of a line is with these texts in it
 * (`LineFlowLabel`: 10 px monospace, the arrow of the direction before the
 * flow, the padding and the border of the label). `null` for a text that is
 * not shown.
 */
export function flowLabelWidth(flow: string | null, loading: string | null): number {
  const texts = [flow === null ? null : `→${flow}`, loading].filter(
    (text): text is string => text !== null,
  );
  const letters = texts.reduce((sum, text) => sum + text.length, 0);
  // A gap between the arrow and the flow, and between the flow and the loading.
  const gaps = (flow === null ? 0 : 1) + (flow !== null && loading !== null ? 1 : 0);
  return Math.ceil(6 * letters + 4 * gaps + 14);
}

/**
 * How wide the P / Q readout of a device is with these two lines in it
 * (`DeviceValueLabel`: 9 px monospace and its padding).
 */
export function readoutWidth(p: string | null, q: string | null): number {
  return Math.ceil(5.4 * Math.max(p?.length ?? 0, q?.length ?? 0) + 8);
}

/** Whether two boxes share any room. */
export function overlaps(a: Rect, b: Rect, slack = 0): boolean {
  return (
    a.left < b.right - slack &&
    b.left < a.right - slack &&
    a.top < b.bottom - slack &&
    b.top < a.bottom - slack
  );
}

/**
 * The room `node` takes on the diagram: the box it is drawn in, and for a
 * bus its bar, as long as it is drawn, with the strip under it.
 */
export function boxOnDiagram(
  node: LabelNode,
  sizes: ReadonlyMap<string, NodeSize>,
  bars: ReadonlyMap<string, BarGeometry>,
): Rect {
  const { x, y } = node.position;
  if ((node.type ?? 'bus') === 'bus') {
    const bar = bars.get(node.id);
    return {
      left: x + (bar?.start ?? 0),
      right: x + (bar?.end ?? NODE_FOOTPRINT.bus.width),
      top: y,
      bottom: y + NODE_FOOTPRINT.bus.height,
    };
  }
  const size = sizes.get(node.id);
  return {
    left: x,
    right: x + (size?.width ?? node.initialWidth ?? 0),
    top: y,
    bottom: y + (size?.height ?? node.initialHeight ?? 0),
  };
}

/** The bar of a bus alone, as it is drawn: without the strip its label hangs in. */
function barBox(node: LabelNode, bars: ReadonlyMap<string, BarGeometry>): Rect {
  const bar = bars.get(node.id);
  return {
    left: node.position.x + (bar?.start ?? 0),
    right: node.position.x + (bar?.end ?? BAR_LENGTH),
    top: node.position.y,
    bottom: node.position.y + BAR_THICKNESS,
  };
}

/**
 * The mark of a generator at a reactive limit (`GeneratorNode`): a triangle
 * `size` across on the top right corner of the symbol, which reaches `out`
 * past the corner both ways (drawn in a square of 10 set 3 out, with a
 * margin of 1 round it).
 */
export const LIMIT_MARKER = { size: 8, out: 2 };

/**
 * The room the limit mark of the generator `node` takes, whether a power
 * flow has put one there or not; `null` for a node that is no generator.
 * It is the triangle as it is drawn, which ends where a readout that hangs
 * off the top of the symbol begins.
 */
export function limitMarkerBox(node: LabelNode, sizes: ReadonlyMap<string, NodeSize>): Rect | null {
  if (node.type !== 'generator') return null;
  const width = sizes.get(node.id)?.width ?? node.initialWidth ?? 0;
  const right = node.position.x + width + LIMIT_MARKER.out;
  const top = node.position.y - LIMIT_MARKER.out;
  return { left: right - LIMIT_MARKER.size, right, top, bottom: top + LIMIT_MARKER.size };
}

/** What the limit mark of a generator goes by among the boxes of a diagram. */
export const markerId = (nodeId: string): string => `marker:${nodeId}`;

/** The room of the limit mark of every generator among `nodes`. */
function markerBoxes(
  nodes: readonly LabelNode[],
  sizes: ReadonlyMap<string, NodeSize>,
): { id: string; box: Rect }[] {
  const out: { id: string; box: Rect }[] = [];
  for (const node of nodes) {
    const box = limitMarkerBox(node, sizes);
    if (box !== null) out.push({ id: markerId(node.id), box });
  }
  return out;
}

/** The side of the squares the boxes are sorted into, to find the ones near a place. */
const BOX_CELL = 128;

/** Boxes kept so that the ones that reach into a given box are found without looking at them all. */
interface BoxIndex<T extends { box: Rect }> {
  add: (entry: T) => void;
  near: (box: Rect) => T[];
}

function boxIndex<T extends { box: Rect }>(boxes: readonly T[] = []): BoxIndex<T> {
  const cells = new Map<string, T[]>();
  const cellsOf = (box: Rect): string[] => {
    const keys: string[] = [];
    const [c0, c1] = [Math.floor(box.left / BOX_CELL), Math.floor(box.right / BOX_CELL)];
    const [r0, r1] = [Math.floor(box.top / BOX_CELL), Math.floor(box.bottom / BOX_CELL)];
    for (let c = c0; c <= c1; c += 1) for (let r = r0; r <= r1; r += 1) keys.push(`${c}|${r}`);
    return keys;
  };
  const add = (entry: T): void => {
    for (const key of cellsOf(entry.box)) {
      const list = cells.get(key);
      if (list) list.push(entry);
      else cells.set(key, [entry]);
    }
  };
  for (const entry of boxes) add(entry);
  return {
    add,
    near: (box) => {
      const found = new Set<T>();
      for (const key of cellsOf(box)) {
        for (const entry of cells.get(key) ?? []) {
          if (overlaps(entry.box, box)) found.add(entry);
        }
      }
      return [...found];
    },
  };
}

/** The boxes among `boxes` that reach into a given box, as a lookup. */
function boxesNear<T extends { box: Rect }>(boxes: readonly T[]): (box: Rect) => T[] {
  return boxIndex(boxes).near;
}

/**
 * Where the control chains that are drawn out stand, by the id of the node
 * of their unit: on the side the node says (`data.unit.side`).
 */
export function chainBoxes(
  nodes: readonly LabelNode[],
  sizes: ReadonlyMap<string, NodeSize>,
): Map<string, Rect> {
  const boxes = new Map<string, Rect>();
  for (const n of nodes) {
    const unit = n.data?.unit as UnitNodeData | undefined;
    if (n.type !== 'generator' || unit?.expanded !== true) continue;
    const size = sizes.get(n.id);
    const places = unitChainPlaces(
      {
        ...n.position,
        width: size?.width ?? n.initialWidth ?? 0,
        height: size?.height ?? n.initialHeight ?? 0,
      },
      unitChainSize(unit.members),
    );
    boxes.set(n.id, places[unit.side ?? 'above']);
  }
  return boxes;
}

// ---- the label of a bus -------------------------------------------------------

/**
 * How far either side of its bar the strips reach in which the label of a
 * bus looks for a place: as far as the label may stand past a tip, and its
 * own half width.
 */
const LABEL_STRIP_REACH = BAR_LENGTH;

/**
 * How high the label of a bus is with a voltage and an angle in it, and
 * with its name alone, from the bar it hangs under: the 4 px between the
 * two and the lines of text (`BusNode`: two of 10 px and one of 9 px, set
 * tight). The readout of a device that hangs under the bus at the default
 * distance stands right under it.
 */
const BUS_LABEL_HEIGHT = { values: 40, name: 18 };

/** The gap between a bar and a label that stands over it. */
const BUS_LABEL_OVER_GAP = 4;

/**
 * How far under the bar of another bus a label stands at the least that
 * does not hang under its own bar: twice as far as from its own. A label
 * hangs under its bar, so one that stands over its own bar with another
 * bar right over it (two bars a row apart) reads as the label of that bus.
 */
const UNDER_ANOTHER_BAR = 2 * BUS_LABEL_OVER_GAP;

/** What is shut to the label of a bus, in the strip under its bar and in the one over it. */
export interface BusLabelClear {
  below: [number, number][];
  above: [number, number][];
}

/**
 * Where the label of a bus stands: under its bar, over it, beside one of
 * its tips, or `away` from the bar, in the nearest place to it that is
 * clear, where none of those is.
 */
export type BusLabelSide = 'below' | 'above' | 'east' | 'west' | 'away';

/** The label of a bus as it is drawn. */
export interface BusLabel {
  /** The x of its middle, as an offset from the origin of the bus node. */
  offset: number;
  side: BusLabelSide;
  /** The box it takes on the diagram. */
  box: Rect;
  /**
   * Set where the label shows the name of the bus alone, though a power
   * flow has given it a voltage and an angle: with those under it, it had
   * no place next to its bar.
   */
  compact?: true;
  /** Set where it had no place next to its bar at all, and stands further off. */
  far?: true;
}

/** The gap between a tip of a bar and a label that stands beside it. */
export const BUS_LABEL_BESIDE_GAP = 6;

/**
 * Place the label of every bus, one after the other in the order of the
 * nodes, each as `BusNode` draws it (with `values`, as large as it is with
 * a voltage and an angle in it). The answer has where each stands and what
 * each has to stand clear of in the strips under and over its bar. The
 * buses named in `first` are placed before the others.
 */
function walkBusLabels(
  nodes: readonly LabelNode[],
  connections: ConnectionLayout,
  sizes: ReadonlyMap<string, NodeSize>,
  values: boolean,
  chains: ReadonlyMap<string, Rect>,
  symbols: ReadonlyMap<string, Rect>,
  first: ReadonlySet<string> = new Set(),
): { clears: Map<string, BusLabelClear>; labels: Map<string, BusLabel> } {
  const runsThrough = runsIn(connections.routes);
  const standing = boxIndex(
    nodes.map((n) => ({
      id: n.id,
      box:
        (n.type ?? 'bus') === 'bus'
          ? barBox(n, connections.bars)
          : boxOnDiagram(n, sizes, connections.bars),
    })),
  );
  const bars = new Set(nodes.filter((n) => (n.type ?? 'bus') === 'bus').map((n) => n.id));
  for (const marker of markerBoxes(nodes, sizes)) standing.add(marker);
  for (const [id, box] of chains) standing.add({ id: `chain:${id}`, box });
  for (const [id, box] of symbols) standing.add({ id: `symbol:${id}`, box });
  // The devices of each bus, by node id: what may stand between a bus and
  // its name without the name reading as another's.
  const busOf = new Map<string, string>();
  for (const n of nodes) {
    const parent = n.data?.parentBus;
    if (typeof parent === 'string') busOf.set(n.id, parent);
  }
  const clears = new Map<string, BusLabelClear>();
  const labels = new Map<string, BusLabel>();
  const inOrder =
    first.size === 0
      ? nodes
      : [...nodes.filter((n) => first.has(n.id)), ...nodes.filter((n) => !first.has(n.id))];
  for (const node of inOrder) {
    if ((node.type ?? 'bus') !== 'bus') continue;
    const bar = connections.bars.get(node.id);
    if (bar === undefined) continue;
    const origin = node.position;
    const shutIn = (top: number, bottom: number): [number, number][] => {
      const strip: Rect = {
        left: origin.x + bar.start - LABEL_STRIP_REACH,
        right: origin.x + bar.end + LABEL_STRIP_REACH,
        top,
        bottom,
      };
      const within = (from: number, to: number): [number, number] => [
        Math.max(from, strip.left) - origin.x,
        Math.min(to, strip.right) - origin.x,
      ];
      return [
        ...runsThrough(strip).map(({ a, b }) => within(Math.min(a[0], b[0]), Math.max(a[0], b[0]))),
        ...standing
          .near(strip)
          .filter(({ id }) => id !== node.id)
          .map(({ box }) => within(box.left, box.right)),
      ];
    };
    // As high as the label is with a voltage and an angle in it.
    const clear = {
      below: shutIn(
        origin.y + BAR_THICKNESS + 1,
        origin.y + BAR_THICKNESS + BUS_LABEL_HEIGHT.values,
      ),
      above: shutIn(origin.y - BUS_LABEL_OVER_GAP - BUS_LABEL_HEIGHT.values, origin.y - 1),
    };
    clears.set(node.id, clear);

    const name = String(node.data?.name || node.data?.idx || node.id);
    // Nothing runs through it, nothing stands in it, and where it does not
    // hang under its own bar, the bar of no other bus stands right over it.
    const free = (box: Rect): boolean =>
      runsThrough(box).length === 0 &&
      standing.near(box).every(({ id }) => id === node.id) &&
      (box.top >= origin.y ||
        standing
          .near({ ...box, top: box.top - UNDER_ANOTHER_BAR, bottom: box.top })
          .every(({ id }) => id === node.id || !bars.has(id)));
    /**
     * A place next to the bar for the label, with the values of a power
     * flow in it (`full`) or the name alone: under the bar or over it,
     * beside a tip, or right under or over the bar a little past a tip.
     * `null` with none.
     */
    const nextToBar = (full: boolean, shut: BusLabelClear): BusLabel | null => {
      const width = busLabelWidth(name, full);
      const height = full ? BUS_LABEL_HEIGHT.values : BUS_LABEL_HEIGHT.name;
      const place = busLabelPlace(bar, width, shut.below, shut.above);
      const hung = busLabelBox(node, full, bar, shut);
      if (free(hung)) {
        return { offset: place.offset, side: place.above ? 'above' : 'below', box: hung };
      }
      // No place under the bar or over it: beside a tip, level with the bar.
      const top = origin.y + BAR_THICKNESS / 2 - height / 2;
      const east = origin.x + bar.end + BUS_LABEL_BESIDE_GAP;
      const west = origin.x + bar.start - BUS_LABEL_BESIDE_GAP;
      const beside: [BusLabelSide, Rect][] = [
        ['east', { left: east, right: east + width, top, bottom: top + height }],
        ['west', { left: west - width, right: west, top, bottom: top + height }],
      ];
      const found =
        beside.find(([, box]) => free(box)) ?? awayFrom(origin, bar, width, height, free, true);
      if (found === undefined) return null;
      return {
        offset: (found[1].left + found[1].right) / 2 - origin.x,
        side: found[0],
        box: found[1],
      };
    };
    let label = nextToBar(values, clear);
    if (label === null && values) {
      // The name alone, which is less than half as high.
      const shut = {
        below: shutIn(
          origin.y + BAR_THICKNESS + 1,
          origin.y + BAR_THICKNESS + BUS_LABEL_HEIGHT.name,
        ),
        above: shutIn(origin.y - BUS_LABEL_OVER_GAP - BUS_LABEL_HEIGHT.name, origin.y - 1),
      };
      const short = nextToBar(false, shut);
      if (short !== null) label = { ...short, compact: true };
    }
    if (label === null) {
      // No place next to the bar at all: the nearest clear place there is,
      // for the name alone, so that it is drawn on nothing; and with none,
      // under the bar whatever is there. Of the clear places, the nearest
      // with nothing of another bus between it and the bar comes first: a
      // line, the connector of a device, a symbol or a label in between
      // makes the name read as theirs.
      const [left, right] = [origin.x + bar.start, origin.x + bar.end];
      const level = origin.y + BAR_THICKNESS / 2;
      // A connector or a line that ends on this bar is the bus's own.
      const ownRun = (id: string): boolean => {
        const points = connections.routes.get(id)?.points ?? [];
        return [points[0], points[points.length - 1]].some(
          (end) =>
            end !== undefined &&
            Math.abs(end[1] - level) <= BAR_THICKNESS &&
            end[0] >= left - 1 &&
            end[0] <= right + 1,
        );
      };
      // And so is the bus itself, a device of it with its limit mark and
      // its chain, and the symbol of a transformer of it. The label of
      // another bus never is.
      const own = (id: string): boolean => {
        if (id.startsWith('label:')) return false;
        if (id.startsWith('symbol:')) return ownRun(id.slice('symbol:'.length));
        const of = id.replace(/^(marker|chain):/, '');
        return of === node.id || busOf.get(of) === node.id;
      };
      const inSight = (box: Rect): boolean => {
        // From the label to the nearest stretch of the bar.
        const between: Rect = {
          left: Math.min(box.left, Math.max(left, Math.min(right, box.left))),
          right: Math.max(box.right, Math.min(right, Math.max(left, box.right))),
          top: Math.min(box.top, level),
          bottom: Math.max(box.bottom, level),
        };
        return (
          runsThrough(between).every(({ id }) => ownRun(id)) &&
          standing.near(between).every(({ id }) => own(id))
        );
      };
      const [width, height] = [busLabelWidth(name, false), BUS_LABEL_HEIGHT.name];
      const found =
        awayFrom(origin, bar, width, height, (box) => free(box) && inSight(box), false) ??
        awayFrom(origin, bar, width, height, free, false);
      if (found !== undefined) {
        label = {
          offset: (found[1].left + found[1].right) / 2 - origin.x,
          side: found[0],
          box: found[1],
          ...(values ? { compact: true as const } : {}),
          far: true,
        };
      } else {
        const place = busLabelPlace(bar, busLabelWidth(name, values), clear.below, clear.above);
        label = {
          offset: place.offset,
          side: place.above ? 'above' : 'below',
          box: busLabelBox(node, values, bar, clear),
        };
      }
    }
    labels.set(node.id, label);
    standing.add({ id: `label:${node.id}`, box: label.box });
  }
  return { clears, labels };
}

/** How far apart the places are that a label with no place by its bar is tried in. */
const AWAY_STEP = 8;

/** How many rows under the bar, and over it, such a label is tried in. */
const AWAY_ROWS = 6;

/**
 * How far past a tip of its bar the near edge of a label may stand and
 * still be next to the bar: further out, it reads as the label of whatever
 * stands there.
 */
const NEAR_BAR = 16;

/**
 * A place for the label of a bus that has none under its bar, over it or
 * beside a tip, where it is clear of everything (`free`).
 *
 * With `near`, next to the bar: in the row right under the bar and the row
 * right over it, along the bar and no further than `NEAR_BAR` past a tip,
 * tried from the middle of the bar outwards. Without, the nearest place
 * there is: in those two rows as far out as it takes, and then in the rows
 * beyond them. `undefined` with none.
 */
function awayFrom(
  origin: { x: number; y: number },
  bar: BarGeometry,
  width: number,
  height: number,
  free: (box: Rect) => boolean,
  near: boolean,
): ['away', Rect] | undefined {
  const middle = origin.x + (bar.start + bar.end) / 2;
  const half = (bar.end - bar.start) / 2;
  const reach = near ? half + NEAR_BAR + width / 2 : half + width + LABEL_STRIP_REACH;
  for (let row = 0; row < (near ? 1 : AWAY_ROWS); row += 1) {
    const further = row * (height + BUS_LABEL_OVER_GAP);
    const tops = [
      origin.y + BAR_THICKNESS + BUS_LABEL_OVER_GAP + further,
      origin.y - BUS_LABEL_OVER_GAP - height - further,
    ];
    for (let off = 0; off <= reach; off += AWAY_STEP) {
      for (const top of tops) {
        for (const centre of off === 0 ? [middle] : [middle - off, middle + off]) {
          const box: Rect = {
            left: centre - width / 2,
            right: centre + width / 2,
            top,
            bottom: top + height,
          };
          if (free(box)) return ['away', box];
        }
      }
    }
  }
  return undefined;
}

/**
 * What the label of each bus has to stand clear of, by bus id: the stretches
 * of the strip under its bar, and of the one over it, that are shut to it,
 * as offsets from the origin of the bus node (`busLabelPlace` takes them).
 * What shuts a stretch is a run of a connector that passes there, a symbol
 * or the bar of another bus that stands there, and the label of a bus placed
 * before this one. The labels are placed in the order of the nodes, each as
 * `BusNode` draws it: with `values`, as large as it is with a voltage and
 * an angle in it.
 */
export function busLabelClear(
  nodes: readonly LabelNode[],
  connections: ConnectionLayout,
  sizes: ReadonlyMap<string, NodeSize>,
  values = true,
): Map<string, BusLabelClear> {
  return walkBusLabels(nodes, connections, sizes, values, new Map(), new Map()).clears;
}

/**
 * Where the label of each bus stands, by bus id: under its bar where the
 * strip there has a place for it (`busLabelPlace`, with what `busLabelClear`
 * finds in the way), over the bar otherwise, and with no place in either
 * strip beside a tip of the bar, level with it, where nothing runs and
 * nothing stands. A label that has none of those places stands in the
 * nearest clear place to its bar (`away`), so that it is drawn on nothing
 * else. `chains` is where the control chains that are drawn out stand, and
 * `symbols` where the symbols of the transformers do; a label keeps off
 * those as well.
 *
 * A label that is placed takes its room from the ones after it. Where one
 * is left with the name alone, or with no place by its bar, the labels are
 * placed once more with those first (`BUS_LABEL_ROUNDS`), and that is kept
 * where it leaves the labels better off: the label of the bus beside it
 * mostly has another place as good as the one it took.
 */
export function placeBusLabels(
  nodes: readonly LabelNode[],
  connections: ConnectionLayout,
  sizes: ReadonlyMap<string, NodeSize>,
  values: boolean,
  chains: ReadonlyMap<string, Rect> = new Map(),
  symbols: ReadonlyMap<string, Rect> = new Map(),
): Map<string, BusLabel> {
  const place = (first?: ReadonlySet<string>): Map<string, BusLabel> =>
    walkBusLabels(nodes, connections, sizes, values, chains, symbols, first).labels;
  const lacking = (labels: ReadonlyMap<string, BusLabel>): number =>
    [...labels.values()].reduce((sum, label) => sum + busLabelLack(label), 0);
  let best = place();
  const first = new Set<string>();
  for (let round = 0; round < BUS_LABEL_ROUNDS; round += 1) {
    const short = [...best].filter(([id, label]) => busLabelLack(label) > 0 && !first.has(id));
    if (short.length === 0) break;
    for (const [id] of short) first.add(id);
    const again = place(first);
    if (lacking(again) >= lacking(best)) break;
    best = again;
  }
  return best;
}

/** How many more times the labels of the buses are placed, with the ones that came off badly first. */
const BUS_LABEL_ROUNDS = 2;

/**
 * What the label of a bus is short of, as a number to compare two places
 * by: nothing (0), its values (1), a place by its bar (2), or both (3).
 */
export function busLabelLack(label: BusLabel): number {
  return (label.far ? 2 : 0) + (label.compact ? 1 : 0);
}

/**
 * The places to keep free for the label of each bus while the branches are
 * routed (`TidyOptions.keepFree`), bus by bus: under the bar and over it,
 * about its middle and about each of its tips, and beside each tip, as
 * large as the label is with a voltage and an angle in it. Only the places
 * that no device connector runs through and nothing stands in count. A
 * route leaves each bus one of them where it can, so the label has a place
 * clear of the lines, after a power flow that is run later as well.
 */
export function busLabelReserve(
  nodes: readonly LabelNode[],
  stubs: ConnectionLayout,
  sizes: ReadonlyMap<string, NodeSize>,
  surroundings: Pick<ReadoutSurroundings, 'chains'> = {},
): Rect[][] {
  const through = routesThrough(stubs.routes);
  const inTheWay = standingFor(nodes, stubs, sizes, surroundings);
  const out: Rect[][] = [];
  for (const node of nodes) {
    if ((node.type ?? 'bus') !== 'bus') continue;
    const bar = stubs.bars.get(node.id);
    if (bar === undefined) continue;
    const { x, y } = node.position;
    const half =
      busLabelWidth(String(node.data?.name || node.data?.idx || node.id), true) / 2 +
      BUS_LABEL_RESERVE_MARGIN;
    const height = BUS_LABEL_HEIGHT.values;
    const under = y + BAR_THICKNESS;
    const over = y - BUS_LABEL_OVER_GAP - height;
    const level = y + BAR_THICKNESS / 2 - height / 2;
    const about = (middle: number, top: number): Rect => ({
      left: x + middle - half,
      right: x + middle + half,
      top,
      bottom: top + height,
    });
    const east = bar.end + BUS_LABEL_BESIDE_GAP + half;
    const west = bar.start - BUS_LABEL_BESIDE_GAP - half;
    const places = [
      about(BAR_LENGTH / 2, under),
      about(BAR_LENGTH / 2, over),
      about(bar.start, under),
      about(bar.end, under),
      about(bar.start, over),
      about(bar.end, over),
      about(east, level),
      about(west, level),
    ].filter((place) => through(place) === 0 && inTheWay(place).every(({ id }) => id === node.id));
    if (places.length > 0) out.push(places);
  }
  return out;
}

/** The room a place kept for the label of a bus has either side of the label. */
const BUS_LABEL_RESERVE_MARGIN = 5;

/**
 * How wide the label of a bus is taken to be when its place is looked for:
 * its name with the limit marker beside it, or with `values` the voltage
 * and the angle a power flow adds, whichever is longer (10 px monospace, the
 * padding of the block). `BusNode` places the label by the same width, so it
 * stands where everything else on the diagram was told it stands.
 */
export function busLabelWidth(name: string, values: boolean): number {
  return 6 * Math.max(name.length + 2, values ? 9 : 0) + 8;
}

/**
 * The box the label of a bus takes, where `BusNode` draws it: the name, and
 * with `values` the voltage and the angle a power flow adds, under the bar
 * or over it as `busLabelPlace` has it.
 */
export function busLabelBox(
  node: LabelNode,
  values: boolean,
  bar: BarGeometry | undefined,
  clear: BusLabelClear | undefined,
): Rect {
  const width = busLabelWidth(String(node.data?.name || node.data?.idx || node.id), values);
  const height = values ? BUS_LABEL_HEIGHT.values : BUS_LABEL_HEIGHT.name;
  const place = busLabelPlace(bar, width, clear?.below, clear?.above);
  const middle = node.position.x + place.offset;
  const top = place.above
    ? node.position.y - BUS_LABEL_OVER_GAP - height
    : node.position.y + BAR_THICKNESS;
  return { left: middle - width / 2, right: middle + width / 2, top, bottom: top + height };
}

// ---- the readout of a device --------------------------------------------------

/**
 * Where the readout of a device stands: `right` and `left` of the connector,
 * on the face it leaves by; `centre` on the side that faces the bus, where
 * the connector leaves by another face; `far` on the side that looks away
 * from the bus; `east` and `west` beside the symbol, level with its middle;
 * `none` for one that has no place and is left off.
 */
export type ReadoutSpot = 'right' | 'left' | 'centre' | 'far' | 'east' | 'west' | 'none';

export interface ReadoutPlace {
  spot: ReadoutSpot;
  box: Rect;
}

/** What `placeReadouts` reads of the diagram besides its nodes. */
export interface ReadoutSurroundings {
  /** The control chains that are drawn out, by the id of the node of their unit. */
  chains?: ReadonlyMap<string, Rect>;
  /** The label of each bus, by bus id; a readout stands clear of them. */
  busLabels?: ReadonlyMap<string, Rect>;
  /** The symbol of each transformer, by edge id; a readout stands clear of them. */
  symbols?: ReadonlyMap<string, Rect>;
  /**
   * How wide the readout of each device is, by node id (`readoutWidth`): as
   * wide as the values it shows. A device without an entry is taken to have
   * the widest readout there is.
   */
  widths?: ReadonlyMap<string, number>;
}

/** The gap between a symbol and a readout that stands beside it (`DeviceValueLabel`). */
const READOUT_BESIDE_GAP = 4;

/**
 * The places the readout of the device `node` can stand, and the ones it
 * takes first, in the order it would take them: beside its connector where
 * that leaves by the face the readout hangs off (on the right, unless the
 * connector goes off to the right itself), under or over the middle of the
 * device otherwise.
 */
function readoutSpots(
  node: LabelNode,
  connections: ConnectionLayout,
  sizes: ReadonlyMap<string, NodeSize>,
  labelWidth: number = DEVICE_VALUE_LABEL.width,
): {
  spots: Record<Exclude<ReadoutSpot, 'none'>, Rect>;
  first: Exclude<ReadoutSpot, 'none'>[];
  lean: number;
} {
  const size = sizes.get(node.id);
  const width = size?.width ?? node.initialWidth ?? 0;
  const height = size?.height ?? node.initialHeight ?? 0;
  const side =
    (node.data?.valueSide as 'above' | 'below' | undefined) ??
    (node.type === 'generator' ? 'below' : 'above');
  const box = { ...node.position, width, height };
  const near = readoutPlaces(box, side, labelWidth);
  const middle = { x: node.position.x + width / 2, y: node.position.y + height / 2 };
  const centred = (of: Rect): Rect => ({
    ...of,
    left: middle.x - labelWidth / 2,
    right: middle.x + labelWidth / 2,
  });
  const level = {
    top: middle.y - DEVICE_VALUE_LABEL.height / 2,
    bottom: middle.y + DEVICE_VALUE_LABEL.height / 2,
  };
  const east = node.position.x + width + READOUT_BESIDE_GAP;
  const west = node.position.x - READOUT_BESIDE_GAP;
  const connector = connections.routes.get(`stub-${node.id}`);
  const lean =
    connector === undefined
      ? 0
      : Math.sign(Math.round(connector.points[1]![0] - connector.points[0]![0]));
  const beside = connector?.sourceSide === (side === 'below' ? 'south' : 'north');
  return {
    spots: {
      right: near.right,
      left: near.left,
      centre: centred(near.right),
      far: centred(readoutPlaces(box, side === 'below' ? 'above' : 'below', labelWidth).right),
      east: { ...level, left: east, right: east + labelWidth },
      west: { ...level, left: west - labelWidth, right: west },
    },
    first: !beside
      ? ['centre']
      : lean === 1
        ? ['left']
        : lean === -1
          ? ['right']
          : ['right', 'left'],
    lean,
  };
}

/**
 * What stands on the diagram that a readout keeps out of: every node, the
 * limit mark of every generator, and what `surroundings` adds.
 */
function standingFor(
  nodes: readonly LabelNode[],
  connections: ConnectionLayout,
  sizes: ReadonlyMap<string, NodeSize>,
  surroundings: ReadoutSurroundings,
): (box: Rect) => { id: string; box: Rect }[] {
  const standing: { id: string; box: Rect }[] = nodes.map((n) => ({
    id: n.id,
    box:
      (n.type ?? 'bus') === 'bus'
        ? barBox(n, connections.bars)
        : boxOnDiagram(n, sizes, connections.bars),
  }));
  standing.push(...markerBoxes(nodes, sizes));
  for (const [id, box] of surroundings.chains ?? []) standing.push({ id: `chain:${id}`, box });
  for (const [id, box] of surroundings.busLabels ?? []) standing.push({ id: `label:${id}`, box });
  for (const [id, box] of surroundings.symbols ?? []) standing.push({ id: `symbol:${id}`, box });
  return boxesNear(standing);
}

/**
 * Hand each device one of the places it asks for. `wanted` lists, device by
 * device, the places it would take, the one it would take first at the
 * front, with `null` for one it cannot have. They are handed out a choice
 * at a time: every device that can have its first choice gets it before any
 * gets its second, so that the second choice of one never takes the only
 * place of the one beside it. A place is taken while it reaches into one
 * handed out before. The answer has, for each device, which of its places
 * it got, or -1.
 */
function handOut(wanted: readonly (readonly (Rect | null)[])[]): number[] {
  const got = wanted.map(() => -1);
  const taken: Rect[] = [];
  const most = wanted.reduce((count, places) => Math.max(count, places.length), 0);
  for (let choice = 0; choice < most; choice += 1) {
    wanted.forEach((places, device) => {
      const place = places[choice];
      if (got[device] !== -1 || place === undefined || place === null) return;
      if (taken.some((other) => overlaps(other, place))) return;
      got[device] = choice;
      taken.push(place);
    });
  }
  return got;
}

/**
 * Where the P / Q readout of each generator and load stands, by node id.
 *
 * It hangs off the side of its device that faces the bus (`data.valueSide`).
 * Where the connector leaves by that face, it stands beside the connector:
 * on its right, unless the connector goes off to the right itself. Where
 * another connector runs through it there, or something stands there (a
 * symbol, the label of a bus, the readout of the device next to it), it
 * takes the other side of the connector, failing that the far side of the
 * device, and failing that a place beside the symbol. With no place free it
 * is left off (`none`, with the box it would first take).
 */
export function placeReadouts(
  nodes: readonly LabelNode[],
  connections: ConnectionLayout,
  sizes: ReadonlyMap<string, NodeSize>,
  surroundings: ReadoutSurroundings = {},
): Map<string, ReadoutPlace> {
  const through = routesThrough(connections.routes);
  const inTheWay = standingFor(nodes, connections, sizes, surroundings);
  const devices = nodes.filter((n) => n.type === 'generator' || n.type === 'load');
  const asked = devices.map((n) => {
    const { spots, first, lean } = readoutSpots(
      n,
      connections,
      sizes,
      surroundings.widths?.get(n.id),
    );
    // A unit whose chain is drawn out keeps to the side of its bus: the
    // chain stands beyond a readout on its own side (`GeneratorNode`).
    const chain = surroundings.chains?.has(n.id) === true;
    const wanted: Exclude<ReadoutSpot, 'none'>[] = chain
      ? first
      : [
          ...first,
          'far',
          ...(lean === 1 ? (['west', 'east'] as const) : (['east', 'west'] as const)),
        ];
    // Each as a place it can have: no connector runs through it, its own
    // included (one that steps round something leaves by a side of the
    // device), and nothing stands in it.
    const places = wanted.map((spot) => {
      const place = spots[spot];
      const free =
        through(place) === 0 &&
        inTheWay(place).every(
          ({ id, box }) => id === n.id || id === `chain:${n.id}` || !overlaps(box, place),
        );
      return free ? place : null;
    });
    return { spots, wanted, places };
  });
  const got = handOut(asked.map(({ places }) => places));
  const out = new Map<string, ReadoutPlace>();
  devices.forEach((n, i) => {
    const { spots, wanted } = asked[i]!;
    const spot = wanted[got[i]!];
    out.set(
      n.id,
      spot === undefined ? { spot: 'none', box: spots[wanted[0]!] } : { spot, box: spots[spot] },
    );
  });
  return out;
}

/**
 * The places to keep free for the readouts while the branches are routed
 * (`TidyOptions.keepFree`), device by device: the places the readout of a
 * generator or load takes first (beside its connector, and on its far
 * side), where no device connector runs through them and nothing stands in
 * them, and without the ones that reach into the place the device beside
 * it takes first. A tidied route leaves each device one of them where it
 * can, so the values have a place clear of the lines, after a power flow
 * that is run later as well.
 */
export function readoutReserve(
  nodes: readonly LabelNode[],
  stubs: ConnectionLayout,
  sizes: ReadonlyMap<string, NodeSize>,
  surroundings: Pick<ReadoutSurroundings, 'chains'> = {},
): Rect[][] {
  const through = routesThrough(stubs.routes);
  const inTheWay = standingFor(nodes, stubs, sizes, surroundings);
  const viable: (Rect | null)[][] = [];
  for (const n of nodes) {
    if (n.type !== 'generator' && n.type !== 'load') continue;
    const { spots, first } = readoutSpots(n, stubs, sizes);
    viable.push(
      [...first, 'far' as const].map((spot) => {
        const place = spots[spot];
        const free =
          through(place) === 0 &&
          inTheWay(place).every(
            ({ id, box }) => id === n.id || id === `chain:${n.id}` || !overlaps(box, place),
          );
        return free ? place : null;
      }),
    );
  }
  // What each device takes with no branch drawn, and besides it the places
  // that do not reach into what another takes.
  const got = handOut(viable);
  const taken = viable.flatMap((places, device) =>
    got[device] === -1 ? [] : [{ device, box: places[got[device]!]! }],
  );
  return viable
    .map((places, device) =>
      places.filter(
        (place): place is Rect =>
          place !== null &&
          taken.every((other) => other.device === device || !overlaps(other.box, place)),
      ),
    )
    .filter((places) => places.length > 0);
}

// ---- the label of a branch ----------------------------------------------------

/**
 * What a label of a branch keeps off, as boxes: the bars, and the symbols
 * of the devices with the limit marks of the generators.
 */
function standingBoxes(
  nodes: readonly LabelNode[],
  connections: ConnectionLayout,
  sizes: ReadonlyMap<string, NodeSize>,
): { bars: Rect[]; symbols: Rect[] } {
  const bars: Rect[] = [];
  const symbols: Rect[] = [];
  for (const n of nodes) {
    if ((n.type ?? 'bus') === 'bus') bars.push(barBox(n, connections.bars));
    else symbols.push(boxOnDiagram(n, sizes, connections.bars));
  }
  for (const { box } of markerBoxes(nodes, sizes)) symbols.push(box);
  return { bars, symbols };
}

/**
 * Where each transformer carries its symbol, by edge id: on a straight run
 * of its route, as near the middle as it is clear of the symbols of the
 * devices, of the bars, of the control chains that are drawn out (`chains`)
 * and of every other line. The symbol is part of the line: it is placed
 * before any label, and with no clear place it stands where it covers
 * least (the routes are made so that it has one: `tidy.ts`, `routing.ts`).
 */
export function placeTransformerSymbols(
  nodes: readonly LabelNode[],
  edges: readonly ConnectionEdge[],
  connections: ConnectionLayout,
  sizes: ReadonlyMap<string, NodeSize>,
  chains: Iterable<Rect> = [],
): Map<string, LabelPlace> {
  const transformers = edges.filter((edge) => edge.type === 'transformer');
  if (transformers.length === 0) return new Map();
  const { bars, symbols } = standingBoxes(nodes, connections, sizes);
  return branchLabelPlaces(
    connections.routes,
    transformers.map((edge) => ({ id: edge.id, ...TRANSFORMER_LABEL_BOX, symbol: true })),
    [...bars, ...symbols, ...chains],
  );
}

/** The box the symbol of each transformer takes where it stands, by edge id. */
export function symbolBoxes(places: ReadonlyMap<string, LabelPlace>): Map<string, Rect> {
  const { width, height } = TRANSFORMER_LABEL_BOX;
  return new Map([...places].map(([id, place]) => [id, labelBoxAt(place, width, height)]));
}

/**
 * Where each line carries its flow label and each transformer its symbol
 * (`branchLabelPlaces`): on a straight run of its route, or for a flow
 * label beside one, clear of the symbols, of the bars, of the labels of the
 * buses, of the readouts of the devices, of the control chains that are
 * drawn out, and of each other. The symbols of the transformers come
 * first: they are always drawn, and stand where `labels.symbols` has them
 * (`placeTransformerSymbols`, which is asked here where it has none). A
 * flow label shows only with the values of a power flow (`values`; without
 * them no line gets a place). One with no place on its line or beside it
 * stands on an upright run turned to read along it (`turned`), and one with
 * no place clear of everything else even so is left off (`hidden`).
 */
export function placeBranchLabels(
  nodes: readonly LabelNode[],
  edges: readonly ConnectionEdge[],
  connections: ConnectionLayout,
  sizes: ReadonlyMap<string, NodeSize>,
  labels: {
    busLabels: ReadonlyMap<string, Rect>;
    readouts: Iterable<Rect>;
    chains?: ReadonlyMap<string, Rect>;
    /** Where the symbols of the transformers stand, by edge id. */
    symbols?: ReadonlyMap<string, LabelPlace>;
    values?: boolean;
    /** How wide the flow label of each line is, by edge id (`flowLabelWidth`); the widest without. */
    widths?: ReadonlyMap<string, number>;
    /**
     * Place each label once and look no further for the ones that are hard
     * to place: for a diagram that is redrawn with every move of a drag.
     */
    quick?: boolean;
  },
): Map<string, LabelPlace> {
  const chains = [...(labels.chains?.values() ?? [])];
  const symbols =
    labels.symbols ?? placeTransformerSymbols(nodes, edges, connections, sizes, chains);
  const out = new Map(symbols);
  if (labels.values === false) return out;
  const lines = edges.filter((edge) => edge.type !== 'stub' && edge.type !== 'transformer');
  const standing = standingBoxes(nodes, connections, sizes);
  const places = branchLabelPlaces(
    connections.routes,
    lines.map((edge) => ({
      id: edge.id,
      ...LINE_LABEL_BOX,
      width: labels.widths?.get(edge.id) ?? LINE_LABEL_BOX.width,
      beside: true,
      mayTurn: true,
      mayHide: true,
    })),
    [
      ...standing.bars,
      ...labels.busLabels.values(),
      ...labels.readouts,
      ...symbolBoxes(symbols).values(),
    ],
    // A flow label keeps a little way off the symbol of a device, its limit
    // mark and a chain that is drawn out.
    { quick: labels.quick, apart: [...standing.symbols, ...chains] },
  );
  for (const [id, place] of places) out.set(id, place);
  return out;
}
