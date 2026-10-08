/**
 * The diagram as it is drawn, worked out in one place: from the nodes where
 * they stand and the edges with the routes stored for them, everything the
 * canvas hands to React Flow besides.
 *
 * `pictureOf` does it in the order each part depends on the one before:
 *
 * 1. the connectors of the devices, and the bars as long as those need;
 * 2. where the control chains that are drawn out stand: beside their unit,
 *    on a side where no symbol, bar or connector is in the way;
 * 3. the route of every line and transformer, clear of all of that and of
 *    each other (`routeDiagram`), with it the bars and the taps as they are
 *    drawn, and the symbol of every transformer on its route, which the
 *    routes are held to as they are to the symbol of a device;
 * 4. the label of every bus, clear of the lines and the symbols;
 * 5. the P / Q readout of every generator and load, clear of the lines, the
 *    symbols and the labels of the buses;
 * 6. the flow label of every line, clear of all of those and of each other.
 *
 * `drawnDiagram` turns a picture into what the overlap checker reads
 * (`findOverlaps`): the tests hold the example cases to it in every state,
 * and the picture they check is the one the canvas draws.
 *
 * `drawsClear` is the same check asked before a node comes to stand where
 * it was dropped (`clearDrop`): whether the diagram, drawn with the nodes
 * there, has anything on anything else that was not so before the move.
 * `routesDrawClear` asks it of a route that was drawn by hand, before the
 * diagram keeps it, and `connectorDrawn` of something that came to be drawn
 * without a move: the connector of a draft that was just given its bus.
 * `drawsUndisturbed` asks besides that no line had to give way, and
 * `drawnWith` says how far round each line goes that did.
 *
 * `routesOf` is the third part alone, for what asks only how the lines of a
 * diagram run: which of them the diagram routes afresh without its drafts
 * (`draftRoutes.ts`), and where they run without one of them
 * (`connectedPlace`).
 *
 * Pure: no React, no React Flow, nothing read but the arguments.
 */
import {
  BAR_LENGTH,
  BAR_THICKNESS,
  labelBoxAt,
  layoutConnections,
  routesThrough,
  type ConnectionEdge,
  type ConnectionPass,
  type LabelPlace,
  type NodeSize,
  type Rect,
} from './connections';
import {
  chooseChainSide,
  unitChainPlaces,
  unitChainSize,
  type ChainSide,
  type UnitNodeData,
} from './graph';
import {
  LINE_LABEL_BOX,
  TRANSFORMER_LABEL_BOX,
  boxOnDiagram,
  busLabelReserve,
  limitMarkerBox,
  markerId,
  overlaps,
  placeBranchLabels,
  placeBusLabels,
  placeReadouts,
  readoutReserve,
  symbolBoxes,
  type BusLabel,
  type LabelNode,
  type ReadoutPlace,
} from './labels';
import {
  countCrossings,
  findOverlaps,
  type DrawnBar,
  type DrawnBox,
  type DrawnDiagram,
  type DrawnLine,
} from './overlapCheck';
import { routeDiagram, type RoutedDiagram, type RoutingOptions } from './routing';

export interface PictureOptions extends Omit<
  RoutingOptions,
  'obstacles' | 'keepFree' | 'preferFree'
> {
  /** Whether the values of a power flow show: the labels of the buses are larger, and the readouts and flow labels are drawn. */
  values: boolean;
  /**
   * How wide the readout of each device and the flow label of each line is
   * with the values it shows, by node id and by edge id (`readoutWidth`,
   * `flowLabelWidth`). One without an entry is taken at its widest.
   */
  labelWidths?: {
    readouts?: ReadonlyMap<string, number>;
    flows?: ReadonlyMap<string, number>;
  };
}

export interface Picture<E extends ConnectionEdge> extends RoutedDiagram<E> {
  /** Where each control chain that is drawn out stands, by the id of the node of its unit. */
  chains: Map<string, { side: ChainSide; box: Rect }>;
  /** Where the label of each bus stands, by bus id. */
  busLabels: Map<string, BusLabel>;
  /** Where the P / Q readout of each generator and load stands, by node id. */
  readouts: Map<string, ReadoutPlace>;
  /** Where each line carries its flow label and each transformer its symbol, by edge id. */
  labelPlaces: Map<string, LabelPlace>;
}

const NO_SIZES: ReadonlyMap<string, NodeSize> = new Map();

/**
 * The first three parts of a picture: the connectors of the devices, the
 * chains, and the routes with the symbols of the transformers.
 */
function routedAlways<E extends ConnectionEdge>(
  nodes: readonly LabelNode[],
  edges: readonly E[],
  options: PictureOptions,
) {
  const { values: _values, labelWidths: _labelWidths, ...routing } = options;
  const sizes = routing.sizes ?? NO_SIZES;
  const {
    steps: _steps,
    gridPoints: _gridPoints,
    dragging: _dragging,
    ...connectionOptions
  } = routing;

  // The connectors of the devices alone: what a chain and a route go round.
  const stubs = layoutConnections(
    nodes,
    edges.filter((edge) => edge.type === 'stub'),
    connectionOptions,
  );
  const chains = placeChains(nodes, stubs, sizes);
  const chainBoxes = new Map([...chains].map(([id, { box }]) => [id, box]));

  const routed = routeDiagram(nodes, edges, {
    ...routing,
    obstacles: [...chainBoxes.values()],
    keepFree: readoutReserve(nodes, stubs, sizes, { chains: chainBoxes }),
    preferFree: busLabelReserve(nodes, stubs, sizes, { chains: chainBoxes }),
  });
  return { routed, chains, chainBoxes, sizes };
}

/**
 * The first four parts of a picture (those three, and the labels of the
 * buses): everything on it that is drawn whatever is in the way. The
 * readouts and the flow labels come after, and are left off where they
 * have no place.
 */
function drawnAlways<E extends ConnectionEdge>(
  nodes: readonly LabelNode[],
  edges: readonly E[],
  options: PictureOptions,
) {
  const { routed, chains, chainBoxes, sizes } = routedAlways(nodes, edges, options);
  // The symbols of the transformers stand where the routing has them: every
  // label keeps off them.
  const symbols = symbolBoxes(routed.symbols);
  const busLabels = placeBusLabels(
    nodes,
    routed.connections,
    sizes,
    options.values,
    chainBoxes,
    symbols,
  );
  return { routed, chains, chainBoxes, symbols, busLabels, sizes };
}

/**
 * How the lines and transformers of `nodes` and `edges` run in the picture
 * of them (`pictureOf`), without the labels a picture places after: the
 * routes, and which of them were made afresh.
 */
export function routesOf<E extends ConnectionEdge>(
  nodes: readonly LabelNode[],
  edges: readonly E[],
  options: PictureOptions,
): RoutedDiagram<E> {
  return routedAlways(nodes, edges, options).routed;
}

/** The picture of the diagram whose nodes are `nodes` and whose edges are `edges`. */
export function pictureOf<E extends ConnectionEdge>(
  nodes: readonly LabelNode[],
  edges: readonly E[],
  options: PictureOptions,
): Picture<E> {
  const { values, labelWidths } = options;
  const { routed, chains, chainBoxes, symbols, busLabels, sizes } = drawnAlways(
    nodes,
    edges,
    options,
  );
  const { connections } = routed;
  // The readouts show with the values, and stand clear of the labels of the
  // buses as those are then.
  const labelBoxes = new Map([...busLabels].map(([id, { box }]) => [id, box]));
  const readouts: Map<string, ReadoutPlace> = values
    ? placeReadouts(nodes, connections, sizes, {
        chains: chainBoxes,
        busLabels: labelBoxes,
        symbols,
        widths: labelWidths?.readouts,
      })
    : new Map();
  const labelPlaces = placeBranchLabels(nodes, routed.edges, connections, sizes, {
    busLabels: labelBoxes,
    readouts: [...readouts.values()].map(({ box }) => box),
    chains: chainBoxes,
    symbols: routed.symbols,
    values,
    widths: labelWidths?.flows,
    quick: options.dragging === true,
  });
  return { ...routed, chains, busLabels, readouts, labelPlaces };
}

/**
 * Where the control chains that are drawn out stand. A chain is drawn out
 * on the side of its unit away from the bus. Where a bar, another symbol or
 * the connector of a device is in the way there and not beside the symbol,
 * it goes beside the symbol. The lines and transformers are routed round it
 * afterwards, so they do not count here.
 */
function placeChains(
  nodes: readonly LabelNode[],
  stubs: ConnectionPass,
  sizes: ReadonlyMap<string, NodeSize>,
): Map<string, { side: ChainSide; box: Rect }> {
  const out = new Map<string, { side: ChainSide; box: Rect }>();
  // What stands on the diagram, as boxes: worked out when a unit has its
  // chain drawn out and the chain needs a place, not otherwise.
  let standing: { id: string; box: Rect }[] | null = null;
  let connectorsThrough: ReturnType<typeof routesThrough> | null = null;
  for (const n of nodes) {
    const unit = (n.data as { unit?: UnitNodeData } | undefined)?.unit;
    if (n.type !== 'generator' || unit?.expanded !== true) continue;
    const around = (standing ??= nodes.map((m) => ({
      id: m.id,
      box: boxOnDiagram(m, sizes, stubs.bars),
    })));
    const through = (connectorsThrough ??= routesThrough(stubs.routes));
    const measured = sizes.get(n.id);
    const places = unitChainPlaces(
      {
        ...n.position,
        width: measured?.width ?? n.initialWidth ?? 0,
        height: measured?.height ?? n.initialHeight ?? 0,
      },
      unitChainSize(unit.members),
    );
    const taken = [...out.values()];
    const side = chooseChainSide(
      unit.side === 'below' ? 'below' : 'above',
      places,
      (place) =>
        around.filter(({ id, box }) => id !== n.id && overlaps(box, place)).length +
        taken.filter(({ box }) => overlaps(box, place)).length +
        through(place, `stub-${n.id}`),
    );
    out.set(n.id, { side, box: places[side] });
  }
  return out;
}

/** What `drawnDiagram` reads of an edge besides what a connection needs. */
interface DrawnEdge extends ConnectionEdge {
  data?: Record<string, unknown>;
}

/**
 * `picture` as the overlap checker reads it: every connector as a line,
 * every bar, and every box: the symbols of the devices and the badges, the
 * room of the limit mark on the corner of each generator, the chains that
 * are drawn out, the symbols of the transformers, the labels of the buses,
 * and with `values` the readouts of the devices and the flow labels of the
 * lines.
 */
export function drawnDiagram(
  nodes: readonly LabelNode[],
  picture: Picture<DrawnEdge>,
  options: {
    sizes?: ReadonlyMap<string, NodeSize>;
    values: boolean;
    labelWidths?: PictureOptions['labelWidths'];
  },
): DrawnDiagram {
  const sizes = options.sizes ?? NO_SIZES;
  const { connections } = picture;
  const lines: DrawnLine[] = [];
  const boxes: DrawnBox[] = [];
  for (const edge of picture.edges) {
    const route = connections.routes.get(edge.id);
    if (route === undefined) continue;
    lines.push({ id: edge.id, points: route.points, from: edge.source, to: edge.target });
    const at = picture.labelPlaces.get(edge.id);
    if (edge.type === 'stub' || at === undefined) continue;
    if (edge.type === 'transformer') {
      const { width, height } = TRANSFORMER_LABEL_BOX;
      boxes.push({
        id: `symbol:${edge.id}`,
        kind: 'symbol',
        box: labelBoxAt(at, width, height),
        of: [edge.id],
      });
    } else if (options.values && at.hidden !== true) {
      const { height } = LINE_LABEL_BOX;
      const width = options.labelWidths?.flows?.get(edge.id) ?? LINE_LABEL_BOX.width;
      boxes.push({
        id: `flow:${edge.id}`,
        kind: 'label',
        box: labelBoxAt(at, width, height),
        of: [edge.id],
      });
    }
  }
  const bars: DrawnBar[] = [];
  for (const node of nodes) {
    const { x, y } = node.position;
    if ((node.type ?? 'bus') === 'bus') {
      const bar = connections.bars.get(node.id);
      bars.push({
        id: node.id,
        left: x + (bar?.start ?? 0),
        right: x + (bar?.end ?? BAR_LENGTH),
        y: y + BAR_THICKNESS / 2,
      });
      const label = picture.busLabels.get(node.id);
      if (label !== undefined) {
        boxes.push({ id: `label:${node.id}`, kind: 'label', box: label.box, of: [node.id] });
      }
      continue;
    }
    const size = sizes.get(node.id);
    boxes.push({
      id: node.id,
      kind: 'symbol',
      box: {
        left: x,
        right: x + (size?.width ?? node.initialWidth ?? 0),
        top: y,
        bottom: y + (size?.height ?? node.initialHeight ?? 0),
      },
    });
    const marker = limitMarkerBox(node, sizes);
    if (marker !== null) {
      boxes.push({ id: markerId(node.id), kind: 'symbol', box: marker, of: [node.id] });
    }
    const chain = picture.chains.get(node.id);
    if (chain !== undefined) {
      boxes.push({ id: `chain:${node.id}`, kind: 'block', box: chain.box, of: [node.id] });
    }
    const readout = picture.readouts.get(node.id);
    if (options.values && readout !== undefined && readout.spot !== 'none') {
      boxes.push({ id: `readout:${node.id}`, kind: 'readout', box: readout.box, of: [node.id] });
    }
  }
  return { lines, bars, boxes };
}

/**
 * Whether a diagram can be drawn with its nodes where a move has put them,
 * as `clearDrop` asks of a place before it lets what was dropped stand
 * there (`DropOptions.clear`). The rules of `clearDrop` are about the boxes
 * of the nodes; whether the connector of a device that was dropped far from
 * its bus finds a way there that runs through no symbol and no bar, and
 * whether every line still has one round it, only the picture says.
 *
 * `before` are the nodes as they stood before the move, and `edges` the
 * edges with the routes kept for them then. The answer says, of the same
 * nodes somewhere else, whether their picture has nothing on anything else
 * (`findOverlaps`) that the picture before the move did not have: what a
 * diagram came with (a layout saved with two symbols on each other) is not
 * held against the move.
 */
export function drawsClear<E extends DrawnEdge>(
  before: readonly LabelNode[],
  edges: readonly E[],
  options: PictureOptions,
): (nodes: readonly LabelNode[]) => boolean {
  let known: Set<string> | null = null;
  return (nodes) => {
    const now = overlapsDrawn(nodes, edges, options);
    if (now.length === 0) return true;
    known ??= new Set(overlapsDrawn(before, edges, options));
    return now.every((overlap) => known!.has(overlap));
  };
}

/**
 * As `drawsClear`, and asking more: that no line or transformer has to be
 * routed afresh for the nodes to stand where they are put, beyond the ones
 * the picture before routed afresh already. A device that is dragged onto a
 * line has the line routed round it; something that is placed where nothing
 * was dragged (a draft dropped from the palette) leaves the lines as they
 * run, and stands beside them.
 */
export function drawsUndisturbed<E extends DrawnEdge>(
  before: readonly LabelNode[],
  edges: readonly E[],
  options: PictureOptions,
): (nodes: readonly LabelNode[]) => boolean {
  let known: { overlaps: Set<string>; rerouted: number } | null = null;
  const named = ({ kind, a, b }: { kind: string; a: string; b: string }) => `${kind}|${a}|${b}`;
  return (nodes) => {
    const now = diagramDrawn(nodes, edges, options);
    const found = findOverlaps(now.diagram);
    if (found.length === 0 && now.rerouted === 0) return true;
    if (known === null) {
      const was = diagramDrawn(before, edges, options);
      known = { overlaps: new Set(findOverlaps(was.diagram).map(named)), rerouted: was.rerouted };
    }
    const { overlaps, rerouted } = known;
    return now.rerouted <= rerouted && found.every((overlap) => overlaps.has(named(overlap)));
  };
}

/** What `connectorDrawn` says of a connector. */
export interface ConnectorDrawn {
  over: boolean;
  crossings: number;
  bends: number;
  /** How far its most slanted run is off level or upright: 0 when every run is one or the other. */
  slant: number;
  /** How long the connector is, along its runs. */
  length: number;
  /** How many lines and transformers had to be routed afresh for the picture. */
  rerouted: number;
  /**
   * By how much each of those is longer than the route kept for it, by edge
   * id (`longerThanKept`): next to nothing for one whose end only moved along
   * its bar to make room for a tap, and the length of the way round for one
   * that had to go round something.
   */
  longer: ReadonlyMap<string, number>;
}

/** How long the route through `points` is. */
function lengthOf(points: readonly (readonly [number, number])[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) {
    length += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  }
  return length;
}

/**
 * By how much each route among `changed`, the routes a picture of `edges`
 * made afresh (`RoutedDiagram.changed`), is longer than the one kept for its
 * line or transformer, by edge id. A line that keeps no route has none to
 * be longer than, and is left out.
 */
export function longerThanKept<E extends ConnectionEdge>(
  edges: readonly E[],
  changed: RoutedDiagram<E>['changed'],
): Map<string, number> {
  const longer = new Map<string, number>();
  for (const edge of edges) {
    const made = changed.get(edge.id);
    const kept = edge.data?.bendPoints;
    if (made === undefined || edge.type === 'stub' || !Array.isArray(kept)) continue;
    longer.set(edge.id, lengthOf(made.points) - lengthOf(kept as [number, number][]));
  }
  return longer;
}

/**
 * How the picture of `nodes` and `edges` draws the device `nodeId` and its
 * connector `edgeId`: whether either is on anything else, or anything else
 * on it (`over`), how many other lines the connector crosses, how many
 * bends it has and how far its runs slant (no bend and no slant when it runs
 * straight up or down to its bar), how long it is, and how many lines
 * the picture had to route afresh (none when every route kept for the
 * diagram still holds with the device there), each with how much longer
 * that made it. Asked of something that came
 * to be drawn without a move, which `drawsClear` has no diagram before to
 * hold it against: a draft that was just given its bus.
 */
export function connectorDrawn<E extends DrawnEdge>(
  nodes: readonly LabelNode[],
  edges: readonly E[],
  options: PictureOptions,
  nodeId: string,
  edgeId: string,
): ConnectorDrawn {
  const { diagram, rerouted, longer } = diagramDrawn(nodes, edges, options);
  const its = (id: string) => id === nodeId || id === edgeId;
  const connector = diagram.lines.find((line) => line.id === edgeId);
  let crossings = 0;
  if (connector !== undefined) {
    for (const line of diagram.lines) {
      if (line !== connector) crossings += countCrossings([connector, line]);
    }
  }
  const points = connector?.points ?? [];
  let slant = 0;
  for (let i = 1; i < points.length; i += 1) {
    const [across, down] = [points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]];
    slant = Math.max(slant, Math.min(Math.abs(across), Math.abs(down)));
  }
  return {
    over: findOverlaps(diagram).some(({ a, b }) => its(a) || its(b)),
    crossings,
    bends: Math.max(0, points.length - 2),
    slant,
    length: lengthOf(points),
    rerouted,
    longer,
  };
}

/**
 * The picture of `nodes` and `edges` as the overlap checker reads it, of
 * what is drawn whatever is in the way. A readout or a flow label that has
 * no place is left off, so neither is ever on anything, and placing them is
 * most of the work of a picture with values on it.
 */
function diagramDrawn<E extends DrawnEdge>(
  nodes: readonly LabelNode[],
  edges: readonly E[],
  options: PictureOptions,
): { diagram: DrawnDiagram; rerouted: number; longer: Map<string, number> } {
  const { routed, chains, busLabels } = drawnAlways(nodes, edges, options);
  const picture = {
    ...routed,
    chains,
    busLabels,
    readouts: new Map<string, ReadoutPlace>(),
    labelPlaces: routed.symbols,
  };
  return {
    diagram: drawnDiagram(nodes, picture, { sizes: options.sizes, values: false }),
    rerouted: routed.changed.size,
    longer: longerThanKept(edges, routed.changed),
  };
}

/**
 * What the picture of `nodes` and `edges` has on what, each as one name,
 * and by how much each line it routes afresh is longer than the route kept
 * for it (`longerThanKept`): for holding a place to more than `drawsClear`
 * does, as the place of a draft is, which leaves the lines as they run
 * where it can (`draftDrop`).
 */
export function drawnWith<E extends DrawnEdge>(
  nodes: readonly LabelNode[],
  edges: readonly E[],
  options: PictureOptions,
): { overlaps: string[]; longer: ReadonlyMap<string, number> } {
  const { diagram, longer } = diagramDrawn(nodes, edges, options);
  return {
    overlaps: findOverlaps(diagram).map(({ kind, a, b }) => `${kind}|${a}|${b}`),
    longer,
  };
}

/** What is on what in that picture, each as one name. */
function overlapsDrawn<E extends DrawnEdge>(
  nodes: readonly LabelNode[],
  edges: readonly E[],
  options: PictureOptions,
): string[] {
  return findOverlaps(diagramDrawn(nodes, edges, options).diagram).map(
    ({ kind, a, b }) => `${kind}|${a}|${b}`,
  );
}

/**
 * Whether a diagram can be drawn with a route of it changed by hand, as the
 * canvas asks before it keeps one (`routeCheck.ts` has said that the route
 * itself is on nothing; this is the picture the whole diagram then gives:
 * the taps as they are handed out with the route in place, the symbol of a
 * transformer where it has room on it, the labels of the buses around it).
 *
 * `before` are the edges with the routes kept for them now. The answer
 * says, of the same edges with other routes, whether their picture has
 * nothing on anything else (`findOverlaps`) that the picture as it is does
 * not have.
 */
export function routesDrawClear<E extends DrawnEdge>(
  nodes: readonly LabelNode[],
  before: readonly E[],
  options: PictureOptions,
): (edges: readonly E[]) => boolean {
  let known: Set<string> | null = null;
  return (edges) => {
    const now = overlapsDrawn(nodes, edges, options);
    if (now.length === 0) return true;
    known ??= new Set(overlapsDrawn(nodes, before, options));
    return now.every((overlap) => known!.has(overlap));
  };
}
