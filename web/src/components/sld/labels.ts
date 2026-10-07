/**
 * Where the labels of the diagram stand: the name and the values under the
 * bar of a bus, the P / Q readout of a generator or load, and the flow label
 * of a line or the symbol of a transformer.
 *
 * Each is placed from the diagram as it is drawn (the nodes where they are,
 * the bars and the routes `layoutConnections` worked out), one kind after
 * the other, each clear of the ones before it:
 *
 * - The label of a bus hangs under its bar and moves along it, clear of the
 *   connectors that land on the south face, of the runs that pass under the
 *   bar, of the symbols and the bars that stand there, and of the label of a
 *   bus placed before it (`busLabelClear`, which `busLabelPlace` in
 *   `connections.ts` takes). Where the strip under the bar has no place for
 *   it and the strip over the bar has, it stands over the bar.
 * - The readout of a device hangs off the face its connector leaves by,
 *   beside the connector: on its right, or on its left, whichever no
 *   connector runs through and nothing stands in. With neither it goes to
 *   the far side of the device, then beside its symbol, and with no place
 *   free it stays where it would first stand (`placeReadouts`). Every device
 *   gets its first choice before any gets its second.
 * - The label of a branch stands on a straight run of its route, or beside
 *   one, where it covers least (`placeBranchLabels`, over
 *   `branchLabelPlaces` in `connections.ts`).
 *
 * `readoutReserve` is what Tidy diagram asks for before it routes: the
 * places each readout would take with no branch drawn, of which a tidied
 * route leaves each device one where it can (`TidyOptions.keepFree`).
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
  branchLabelPlaces,
  busLabelPlace,
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
export const LINE_LABEL_BOX = { width: 84, height: 18 };
export const TRANSFORMER_LABEL_BOX = { width: 30, height: 30 };

/** How much two boxes may reach into each other and still count as apart: the slack of a size hint. */
const OVERLAP_SLACK = 2;

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

/** How high the label of a bus is with a voltage and an angle in it, and with its name alone. */
const BUS_LABEL_HEIGHT = { values: NODE_FOOTPRINT.bus.height + 4 - BAR_THICKNESS, name: 18 };

/** The gap between a bar and a label that stands over it. */
const BUS_LABEL_OVER_GAP = 4;

/** What is shut to the label of a bus, in the strip under its bar and in the one over it. */
export interface BusLabelClear {
  below: [number, number][];
  above: [number, number][];
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
  const out = new Map<string, BusLabelClear>();
  for (const node of nodes) {
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
    out.set(node.id, clear);
    standing.add({ id: `label:${node.id}`, box: busLabelBox(node, values, bar, clear) });
  }
  return out;
}

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
 * from the bus; `east` and `west` beside the symbol, level with its middle.
 */
export type ReadoutSpot = 'right' | 'left' | 'centre' | 'far' | 'east' | 'west';

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
): { spots: Record<ReadoutSpot, Rect>; first: ReadoutSpot[]; lean: number } {
  const size = sizes.get(node.id);
  const width = size?.width ?? node.initialWidth ?? 0;
  const height = size?.height ?? node.initialHeight ?? 0;
  const side =
    (node.data?.valueSide as 'above' | 'below' | undefined) ??
    (node.type === 'generator' ? 'below' : 'above');
  const box = { ...node.position, width, height };
  const near = readoutPlaces(box, side);
  const middle = { x: node.position.x + width / 2, y: node.position.y + height / 2 };
  const centred = (of: Rect): Rect => ({
    ...of,
    left: middle.x - DEVICE_VALUE_LABEL.width / 2,
    right: middle.x + DEVICE_VALUE_LABEL.width / 2,
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
      far: centred(readoutPlaces(box, side === 'below' ? 'above' : 'below').right),
      east: { ...level, left: east, right: east + DEVICE_VALUE_LABEL.width },
      west: { ...level, left: west - DEVICE_VALUE_LABEL.width, right: west },
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

/** What stands on the diagram that a readout keeps out of: every node, and what `surroundings` adds. */
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
  for (const [id, box] of surroundings.chains ?? []) standing.push({ id: `chain:${id}`, box });
  for (const [id, box] of surroundings.busLabels ?? []) standing.push({ id: `label:${id}`, box });
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
      if (taken.some((other) => overlaps(other, place, OVERLAP_SLACK))) return;
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
 * stands where it first would.
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
    const { spots, first, lean } = readoutSpots(n, connections, sizes);
    // A unit whose chain is drawn out keeps to the side of its bus: the
    // chain stands beyond a readout on its own side (`GeneratorNode`).
    const chain = surroundings.chains?.has(n.id) === true;
    const wanted: ReadoutSpot[] = chain
      ? first
      : [
          ...first,
          'far',
          ...(lean === 1 ? (['west', 'east'] as const) : (['east', 'west'] as const)),
        ];
    const own = `stub-${n.id}`;
    // Each as a place it can have: no connector runs through it and nothing
    // stands in it.
    const places = wanted.map((spot) => {
      const place = spots[spot];
      const free =
        through(place, own) === 0 &&
        inTheWay(place).every(
          ({ id, box }) =>
            id === n.id || id === `chain:${n.id}` || !overlaps(box, place, OVERLAP_SLACK),
        );
      return free ? place : null;
    });
    return { spots, wanted, places };
  });
  const got = handOut(asked.map(({ places }) => places));
  const out = new Map<string, ReadoutPlace>();
  devices.forEach((n, i) => {
    const { spots, wanted } = asked[i]!;
    const spot = wanted[got[i]!] ?? wanted[0]!;
    out.set(n.id, { spot, box: spots[spot] });
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
          through(place, `stub-${n.id}`) === 0 &&
          inTheWay(place).every(
            ({ id, box }) =>
              id === n.id || id === `chain:${n.id}` || !overlaps(box, place, OVERLAP_SLACK),
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
          taken.every(
            (other) => other.device === device || !overlaps(other.box, place, OVERLAP_SLACK),
          ),
      ),
    )
    .filter((places) => places.length > 0);
}

// ---- the label of a branch ----------------------------------------------------

/**
 * Where each line carries its flow label and each transformer its symbol
 * (`branchLabelPlaces`): on a straight run of its route, or for a flow
 * label beside one, clear of the symbols, of the bars, of the labels of the
 * buses, of the readouts of the devices, and of each other.
 */
export function placeBranchLabels(
  nodes: readonly LabelNode[],
  edges: readonly ConnectionEdge[],
  connections: ConnectionLayout,
  sizes: ReadonlyMap<string, NodeSize>,
  labels: { busLabels: ReadonlyMap<string, Rect>; readouts: Iterable<Rect> },
): Map<string, LabelPlace> {
  const boxes: Rect[] = [];
  for (const n of nodes) {
    if ((n.type ?? 'bus') === 'bus') boxes.push(barBox(n, connections.bars));
    else boxes.push(boxOnDiagram(n, sizes, connections.bars));
  }
  boxes.push(...labels.busLabels.values(), ...labels.readouts);
  return branchLabelPlaces(
    connections.routes,
    edges
      .filter((edge) => edge.type !== 'stub')
      .map((edge) =>
        edge.type === 'transformer'
          ? { id: edge.id, ...TRANSFORMER_LABEL_BOX }
          : { id: edge.id, ...LINE_LABEL_BOX, beside: true },
      ),
    boxes,
  );
}
