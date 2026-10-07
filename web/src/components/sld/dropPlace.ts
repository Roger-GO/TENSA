/**
 * Where a bus or a device that was dropped comes to stand: where it was
 * dropped, or the nearest place to that where it is on nothing.
 *
 * A drag ends wherever the pointer is let go, which may be on the symbol of
 * another device, on the bar of a bus, or with a bar so close under another
 * that nothing can be drawn between the two. The lines and the labels of a
 * diagram go round what stands on it (`routing.ts`, `labels.ts`); two
 * symbols on each other, or a symbol on a bar, they cannot do anything
 * about. `clearDrop` is what does: it answers how far the nodes that were
 * moved have to be shifted, all by the same way, so that
 *
 * - no symbol that was moved is nearer than `DROP_CLEARANCE` to a symbol or
 *   a bar that was not, and no bar that was moved is as near to a symbol
 *   that was not; level with a bar, a symbol also keeps the room past its
 *   tip that the bar may be drawn out over (`DROP_TIP_ROOM`), and over or
 *   under a bar that is not its own it keeps `DROP_FOREIGN_ROOM`;
 * - no bar that was moved stands over or under another bar nearer than
 *   `DROP_ROW`, the room a label and a line between two bars need, or
 *   beside one nearer than `DROP_ROW_GAP`;
 * - none of them stands on the connector of a device that was not moved,
 *   and nothing that was not moved stands between a bus and a device that
 *   moved along with it: their connector runs straight;
 * - no bar of another bus stands between a device that was moved and its
 *   own bus (`BETWEEN_CLEARANCE`): its connector would have to go round a
 *   bar it has nothing to do with. (It does go round a symbol that stands
 *   there: `connections.ts`.)
 *
 * Those are rules about the boxes of the nodes, which are cheap to hold a
 * place to. What they do not say is whether the diagram can be drawn with
 * the nodes there: whether the connector of a device that was dropped far
 * from its bus has a way to its bar that runs through no symbol and no bar
 * (it steps round what stands next to the device, and runs straight from
 * there), and whether every line has a way round what was dropped. So a
 * place the rules pass is also asked of the picture of the diagram
 * (`DropOptions.clear`, which is `drawsClear` in `picture.ts`), and one
 * where something would be drawn over something else is not taken.
 *
 * The shift is the shortest there is, on a grid of `step` (the grid the
 * nodes snap to, while they do), and `null` when the nodes are clear where
 * they were dropped. The picture is asked of a few places only, each a
 * little way from the ones it said no to (`DROP_PICTURES`,
 * `DROP_PICTURE_APART`); with none of them clear the nodes go back to where
 * they stood before the move (`DropOptions.back`), where the diagram was
 * drawn with nothing on anything else.
 *
 * Pure: no React, no React Flow, nothing read but the arguments.
 */
import {
  BAR_LENGTH,
  BAR_THICKNESS,
  RUN_CLEARANCE,
  SLIDE_CLEARANCE,
  type ConnectionEdge,
  type ConnectionLayout,
  type ConnectionNode,
  type NodeSize,
  type Point,
  type Rect,
} from './connections';
import { GRID_STEP, MAX_OVERHANG } from './tidy';

/** The room a symbol that is dropped keeps to another symbol and to a bar. */
export const DROP_CLEARANCE = 8;

/**
 * How far apart, up and down, two bars are that stand one over the other:
 * the rows of the automatic arrangement are as far apart (`alignToGrid`).
 */
export const DROP_ROW = 3 * GRID_STEP;

/**
 * The room two bars that stand side by side keep between their tips: as
 * much as a line keeps to the tip of a bar it passes (`SLIDE_CLEARANCE`).
 */
export const DROP_ROW_GAP = SLIDE_CLEARANCE;

/**
 * The room a symbol keeps to a tip of a bar it stands level with: a bar is
 * drawn out past its tip for the lines that land there, as far as
 * `MAX_OVERHANG`, and the bar of the symbol's own bus by the room its taps
 * keep from the one at its tip.
 */
export const DROP_TIP_ROOM = MAX_OVERHANG;
export const DROP_OWN_TIP_ROOM = 2 * GRID_STEP;

/**
 * The room a symbol keeps over and under a bar that is not its own: as much
 * as a line keeps to a bar it passes (`RUN_CLEARANCE`), which is what the
 * automatic arrangement leaves between a device and the bar of the next row.
 */
export const DROP_FOREIGN_ROOM = RUN_CLEARANCE;

/** How near a connector may pass a symbol, and a bar, that is dropped beside it. */
const CONNECTOR_CLEARANCE = 4;
const CONNECTOR_BAR_CLEARANCE = 8;

/** How far the straight way from a device to its bus keeps from the bar of another bus. */
const BETWEEN_CLEARANCE = 16;

/** How far from where it was dropped a place is looked for, and how far apart the places tried are. */
export const DROP_REACH = 256;
const DROP_STEP = 4;

/**
 * How many places the picture of the diagram is asked about, the one the
 * nodes were dropped in among them, and how far from a place it said no to
 * the next one asked about is: what is in the way of a connector there is
 * mostly in its way a few pixels on as well.
 */
export const DROP_PICTURES = 12;
export const DROP_PICTURE_APART = 24;

export interface DropOptions<N extends ConnectionNode = ConnectionNode> {
  /** The measured size of each node, by id. A node without one is taken at its size hint. */
  sizes?: ReadonlyMap<string, NodeSize>;
  /** How far apart the places tried are: the grid the nodes snap to. Default 4. */
  step?: number;
  /**
   * The diagram as it was drawn before the move began. A bar counts as long
   * as it was then as well: the lines that drew it out are mostly still
   * there once the diagram is at rest again. And the connector of a device
   * that was not moved counts as it ran then, straight, not as it steps
   * round what is being dropped on it.
   */
  atRest?: ConnectionLayout;
  /**
   * Whether the diagram is drawn with nothing on anything else when its
   * nodes stand as given: the nodes that were dropped, shifted to a place
   * the rules pass, and the others where they are (`drawsClear`). Without
   * it the rules alone decide.
   */
  clear?: (nodes: readonly N[]) => boolean;
  /** How many places `clear` is asked about at the most; default `DROP_PICTURES`. */
  pictures?: number;
  /**
   * The shift that takes the nodes back to where they stood before the
   * move: where they go when `clear` passes no place near where they were
   * dropped.
   */
  back?: { dx: number; dy: number };
}

/**
 * What a node was dropped on: a symbol on or right beside another symbol, a
 * symbol and a bar on each other, two bars too close to each other, a
 * symbol or a bar on a connector, a device beyond the bar of another bus
 * from its own, or a place where a connector or a line would have no way
 * that is clear of everything else (`no-way`).
 */
export type DropObstacle =
  | 'symbol-symbol'
  | 'symbol-bar'
  | 'bar-bar'
  | 'connector'
  | 'bar-between'
  | 'no-way';

/** Where what was dropped comes to stand, as a shift from where it was dropped. */
export interface DropShift {
  dx: number;
  dy: number;
  /** What it was dropped on. */
  onto: DropObstacle;
  /** Set where the shift takes the nodes back to where they stood before the move. */
  back?: true;
}

interface Shape {
  id: string;
  bar: boolean;
  box: Rect;
  /** The devices of a bus, by node id: what its bar may stand right beside. */
  devices: ReadonlySet<string>;
}

/** Whether the run from `a` to `b` passes through `rect`. */
function crosses(a: Point, b: Point, rect: Rect): boolean {
  let from = 0;
  let to = 1;
  const within = (delta: number, near: number, far: number): boolean => {
    if (Math.abs(delta) < 1e-9) return near < 0 && far > 0;
    from = Math.max(from, Math.min(near / delta, far / delta));
    to = Math.min(to, Math.max(near / delta, far / delta));
    return from < to;
  };
  return (
    within(b[0] - a[0], rect.left - a[0], rect.right - a[0]) &&
    within(b[1] - a[1], rect.top - a[1], rect.bottom - a[1])
  );
}

function grown(rect: Rect, across: number, down: number = across): Rect {
  return {
    left: rect.left - across,
    right: rect.right + across,
    top: rect.top - down,
    bottom: rect.bottom + down,
  };
}

function moved(rect: Rect, dx: number, dy: number): Rect {
  return {
    left: rect.left + dx,
    right: rect.right + dx,
    top: rect.top + dy,
    bottom: rect.bottom + dy,
  };
}

/** Whether two boxes are nearer than `across` side by side and nearer than `down` one over the other. */
function near(a: Rect, b: Rect, across: number, down: number = across): boolean {
  return (
    a.left < b.right + across &&
    b.left < a.right + across &&
    a.top < b.bottom + down &&
    b.top < a.bottom + down
  );
}

/**
 * How far the nodes `movedIds` of `nodes`, which stand where they were
 * dropped, are to be shifted to stand clear of the rest. `connections` is
 * the diagram as it was last drawn: the bars as long as they are, and the
 * connectors of the devices, with `edges` saying which device and bus each
 * joins. The answer also says what the nodes were dropped on (`onto`).
 */
export function clearDrop<N extends ConnectionNode>(
  nodes: readonly N[],
  edges: readonly ConnectionEdge[],
  movedIds: ReadonlySet<string>,
  connections: ConnectionLayout,
  options: DropOptions<N> = {},
): DropShift | null {
  if (movedIds.size === 0) return null;
  const step = options.step ?? DROP_STEP;
  const devicesOf = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.type !== 'stub') continue;
    const set = devicesOf.get(edge.target);
    if (set) set.add(edge.source);
    else devicesOf.set(edge.target, new Set([edge.source]));
  }
  const none: ReadonlySet<string> = new Set();
  const shapeOf = (node: ConnectionNode): Shape => {
    const { x, y } = node.position;
    if ((node.type ?? 'bus') === 'bus') {
      const bar = connections.bars.get(node.id);
      const before = options.atRest?.bars.get(node.id);
      return {
        id: node.id,
        devices: devicesOf.get(node.id) ?? none,
        bar: true,
        box: {
          left: x + Math.min(bar?.start ?? 0, before?.start ?? Infinity),
          right: x + Math.max(bar?.end ?? BAR_LENGTH, before?.end ?? -Infinity),
          top: y,
          bottom: y + BAR_THICKNESS,
        },
      };
    }
    const size = options.sizes?.get(node.id);
    return {
      id: node.id,
      devices: none,
      bar: false,
      box: {
        left: x,
        right: x + (size?.width ?? node.initialWidth ?? 0),
        top: y,
        bottom: y + (size?.height ?? node.initialHeight ?? 0),
      },
    };
  };
  const mine: Shape[] = [];
  const others: Shape[] = [];
  for (const node of nodes) (movedIds.has(node.id) ? mine : others).push(shapeOf(node));
  if (mine.length === 0 || others.length === 0) return null;
  // Only what stands within reach of where the nodes were dropped counts.
  const around = grown(
    mine.reduce(
      (all, { box }) => ({
        left: Math.min(all.left, box.left),
        right: Math.max(all.right, box.right),
        top: Math.min(all.top, box.top),
        bottom: Math.max(all.bottom, box.bottom),
      }),
      { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity },
    ),
    DROP_REACH + DROP_ROW,
  );
  const standing = others.filter(({ box }) => near(box, around, 0));
  // The connectors that stay as they are drawn: of a device that was not
  // moved, to a bus that was not. And the ones that go along as they are:
  // of a device that was moved together with its bus.
  const fixed: [Point, Point][] = [];
  // The devices that were moved, each with the bar it is connected to: the
  // ones that went along with their bus, and the ones that were moved
  // without it.
  const carried: { device: Shape; bus: Shape }[] = [];
  const alone: { device: Shape; bus: Shape }[] = [];
  const shapes = new Map([...mine, ...others].map((shape) => [shape.id, shape]));
  for (const edge of edges) {
    if (edge.type !== 'stub') continue;
    const [device, bus] = [shapes.get(edge.source), shapes.get(edge.target)];
    if (movedIds.has(edge.source)) {
      if (device && bus) (movedIds.has(edge.target) ? carried : alone).push({ device, bus });
      continue;
    }
    if (movedIds.has(edge.target)) continue;
    const points = (options.atRest ?? connections).routes.get(edge.id)?.points ?? [];
    for (let i = 1; i < points.length; i += 1) fixed.push([points[i - 1]!, points[i]!]);
  }
  /**
   * The straight way from a device to its bar: from the face of the device
   * that looks at the bar to the nearest place on it.
   */
  const straight = (device: Rect, bar: Rect): [Point, Point] => {
    const middle = (device.left + device.right) / 2;
    const level = (bar.top + bar.bottom) / 2;
    return [
      [middle, level < device.top ? device.top : level > device.bottom ? device.bottom : level],
      [Math.min(bar.right, Math.max(bar.left, middle)), level],
    ];
  };
  const roomFor = ({ bar, box }: Pick<Shape, 'bar' | 'box'>): Rect =>
    grown(box, bar ? CONNECTOR_BAR_CLEARANCE : CONNECTOR_CLEARANCE);
  /** What the moved nodes are on, shifted by `dx`, `dy`; `null` when they are clear. */
  const inTheWayAt = (dx: number, dy: number): DropObstacle | null => {
    for (const own of mine) {
      const box = moved(own.box, dx, dy);
      for (const other of standing) {
        if (own.bar && other.bar) {
          if (near(box, other.box, DROP_ROW_GAP, DROP_ROW - BAR_THICKNESS)) return 'bar-bar';
        } else if (own.bar || other.bar) {
          // A bar that is not the symbol's own, as far as it may be drawn out.
          const foreign = own.bar ? !own.devices.has(other.id) : !other.devices.has(own.id);
          if (near(box, other.box, foreign ? DROP_TIP_ROOM : DROP_OWN_TIP_ROOM, DROP_CLEARANCE)) {
            return 'symbol-bar';
          }
          if (foreign && near(box, other.box, DROP_CLEARANCE, DROP_FOREIGN_ROOM)) {
            return 'symbol-bar';
          }
        } else if (near(box, other.box, DROP_CLEARANCE)) {
          return 'symbol-symbol';
        }
      }
      const room = roomFor({ bar: own.bar, box });
      for (const [a, b] of fixed) if (crosses(a, b, room)) return 'connector';
    }
    for (const { device, bus } of carried) {
      const [p, q] = straight(moved(device.box, dx, dy), moved(bus.box, dx, dy));
      for (const other of standing) if (crosses(p, q, roomFor(other))) return 'connector';
    }
    for (const { device, bus } of alone) {
      const [p, q] = straight(moved(device.box, dx, dy), bus.box);
      for (const other of standing) {
        if (!other.bar || other === bus) continue;
        if (crosses(p, q, grown(other.box, BETWEEN_CLEARANCE))) return 'bar-between';
      }
    }
    return null;
  };
  // Whether the diagram can be drawn with the nodes shifted by `dx`, `dy`:
  // asked of a few places only, and of none right next to one that failed.
  const { clear } = options;
  let pictures = options.pictures ?? DROP_PICTURES;
  const refused: { dx: number; dy: number }[] = [];
  const drawn = (dx: number, dy: number): boolean | null => {
    if (clear === undefined) return true;
    const near = refused.some(
      (at) => Math.max(Math.abs(at.dx - dx), Math.abs(at.dy - dy)) < DROP_PICTURE_APART,
    );
    if (near) return false;
    if (pictures <= 0) return null;
    pictures -= 1;
    const there = nodes.map((node) =>
      movedIds.has(node.id)
        ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } }
        : node,
    );
    if (clear(there)) return true;
    refused.push({ dx, dy });
    return false;
  };
  const rules = inTheWayAt(0, 0);
  if (rules === null && drawn(0, 0) !== false) return null;
  const onto = rules ?? 'no-way';
  // The nearest place first; of two as near, the one that is level with
  // where the nodes were dropped, then the one to the left or above.
  const reach = Math.floor(DROP_REACH / step);
  const tried: { dx: number; dy: number; far: number }[] = [];
  for (let i = -reach; i <= reach; i += 1) {
    for (let k = -reach; k <= reach; k += 1) {
      if (i === 0 && k === 0) continue;
      tried.push({ dx: i * step, dy: k * step, far: Math.hypot(i, k) });
    }
  }
  tried.sort(
    (p, q) => p.far - q.far || Math.abs(p.dy) - Math.abs(q.dy) || p.dy - q.dy || p.dx - q.dx,
  );
  // The nearest place the rules pass, should the picture pass none.
  let byRules: { dx: number; dy: number } | null = null;
  for (const { dx, dy } of tried) {
    if (inTheWayAt(dx, dy) !== null) continue;
    byRules ??= { dx, dy };
    const passed = drawn(dx, dy);
    if (passed === true) return { dx, dy, onto };
    if (passed === null) break;
  }
  if (clear === undefined) return null;
  // No place near where the nodes were dropped can be drawn: back to where
  // they stood, or with nowhere to go back to, where the rules have them.
  if (options.back !== undefined) return { ...options.back, onto, back: true };
  return byRules === null ? null : { ...byRules, onto };
}
