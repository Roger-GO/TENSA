/**
 * Where a draft that is dropped on the diagram comes to stand: with the
 * middle of its box where the pointer was let go, or at the nearest place to
 * that where it is on nothing.
 *
 * A draft is a symbol like any other to the diagram, so its place is found
 * the way the place of a device that was dragged and dropped is
 * (`clearDrop`): by the rules about the boxes, and by the picture the
 * diagram gives with the draft there. Two things differ. A draft leaves the
 * lines as they run: a device dragged onto a line has the line routed round
 * it, but a draft dropped on one stands beside it (`drawsUndisturbed`), and
 * only where no such place is near does a line give way to it
 * (`drawsClear`). And a draft that is dropped was not on the diagram
 * before, so there is nowhere for it to go back to: with no clear place
 * near, it stands where the rules have it.
 *
 * `settledPlaces` and `connectedPlace` are for a draft that was not dropped
 * where it stands now: one that something came to stand on, and one that
 * was given its bus in its form, whose connector the picture was never
 * asked about.
 *
 * Pure: no React, nothing read but the arguments. `SldCanvas` calls them
 * with the diagram as it was last drawn, and the tests that hold a diagram
 * with drafts on it to the no-overlap rule place their drafts by them.
 */
import {
  BAR_LENGTH,
  BAR_THICKNESS,
  type ConnectionEdge,
  type ConnectionLayout,
  type NodeSize,
} from './connections';
import {
  DROP_PICTURES,
  DROP_PICTURE_APART,
  clearDrop,
  inTheWay,
  type DropShift,
} from './dropPlace';
import { DRAFT_NODE_SIZE, DRAFT_NODE_TYPE } from './drafts';
import type { LabelNode } from './labels';
import {
  connectorDrawn,
  drawsClear,
  drawsUndisturbed,
  type ConnectorDrawn,
  type PictureOptions,
} from './picture';
import { GRID_STEP, MAX_OVERHANG } from './tidy';

/**
 * How many times as many places the picture is asked about for a draft to
 * stand beside the lines, as for a dropped device to stand clear
 * (`DropOptions.pictures`).
 */
const BESIDE_A_LINE = 3;

/** The id of the node that stands in for the draft while its place is asked about. */
const PROBE_ID = '\u0000draft';

export interface DraftPlaceOptions {
  /** The grid the nodes snap to, while they do: the draft is put on it. */
  step?: number;
  /** The measured size of each node, by id. */
  sizes?: ReadonlyMap<string, NodeSize>;
  /** The diagram as it was drawn at rest (`DropOptions.atRest`). */
  atRest?: ConnectionLayout;
  /** What the picture of the diagram is made with. Without it the rules about the boxes alone decide. */
  picture?: PictureOptions;
  /** How many places the picture is asked about at the most. */
  pictures?: number;
}

export interface DraftPlace {
  /** The top left corner of the draft's box. */
  position: { x: number; y: number };
  /** How far that is from where it was dropped, and what it was dropped on; `null` where it stands as dropped. */
  shift: DropShift | null;
}

/**
 * The place of a draft dropped with its middle at `centre`, on the diagram
 * whose nodes are `nodes` and whose edges are `edges`, drawn as
 * `connections` has it.
 */
export function draftPlace(
  nodes: readonly LabelNode[],
  edges: readonly ConnectionEdge[],
  centre: { x: number; y: number },
  connections: ConnectionLayout,
  options: DraftPlaceOptions = {},
): DraftPlace {
  const { step } = options;
  const onGrid = (value: number) => (step === undefined ? value : Math.round(value / step) * step);
  const dropped = {
    x: onGrid(centre.x - DRAFT_NODE_SIZE.width / 2),
    y: onGrid(centre.y - DRAFT_NODE_SIZE.height / 2),
  };
  const probe: LabelNode = {
    id: PROBE_ID,
    type: DRAFT_NODE_TYPE,
    position: dropped,
    initialWidth: DRAFT_NODE_SIZE.width,
    initialHeight: DRAFT_NODE_SIZE.height,
    data: {},
  };
  const placed = (
    clear?: (there: readonly LabelNode[]) => boolean,
    pictures = options.pictures,
  ): DraftPlace => {
    const shift = clearDrop([...nodes, probe], edges, new Set([PROBE_ID]), connections, {
      sizes: options.sizes,
      step,
      atRest: options.atRest,
      clear,
      pictures,
    });
    return {
      position: shift === null ? dropped : { x: dropped.x + shift.dx, y: dropped.y + shift.dy },
      shift,
    };
  };
  if (options.picture === undefined) return placed();
  // The nearest place where no line has to give way. It is looked for a
  // little farther than a place for a dropped device is (`BESIDE_A_LINE`): a
  // draft is wider than the room between two lines, and has to get past one.
  // `clearDrop` stops at the first place the picture passes, so the last
  // answer says whether it found one.
  const undisturbed = drawsUndisturbed(nodes, edges, options.picture);
  let aside = false;
  const beside = placed(
    (there) => (aside = undisturbed(there)),
    BESIDE_A_LINE * (options.pictures ?? DROP_PICTURES),
  );
  return aside ? beside : placed(drawsClear(nodes, edges, options.picture));
}

/**
 * Where the nodes `ids` of a diagram at rest have to stand for each to be on
 * nothing: a draft that something came to stand on (a re-layout, an element
 * that was added, an arrangement put back by Undo), and an element that just
 * took the place of its draft, whose box is not the draft's. Each goes to the
 * nearest place where it is clear, one after the other, by the rules about
 * the boxes alone: the lines and the labels go round what stands on the
 * diagram, and two symbols on each other they can do nothing about. A node
 * is held to its box here and not to the straight way of its connector,
 * which goes round what is in its way (`connections.ts`): only a drag asks
 * more of it. So a draft does not jump when it is given a bus on the far
 * side of another bar, and one that was dropped beside its own bar stays
 * where the drop left it.
 *
 * Answers the nodes that have to move, each with its place; empty when all
 * stand clear.
 */
export function settledPlaces(
  nodes: readonly LabelNode[],
  edges: readonly ConnectionEdge[],
  ids: readonly string[],
  connections: ConnectionLayout,
  options: Pick<DraftPlaceOptions, 'sizes' | 'step'> = {},
): Map<string, { x: number; y: number }> {
  const moves = new Map<string, { x: number; y: number }>();
  let standing = nodes;
  for (const id of ids) {
    const node = standing.find((n) => n.id === id);
    if (node === undefined) continue;
    const shift = clearDrop(standing, edges, new Set([id]), connections, {
      ...options,
      boxesOnly: true,
    });
    if (shift === null) continue;
    const to = { x: node.position.x + shift.dx, y: node.position.y + shift.dy };
    moves.set(id, to);
    standing = standing.map((n) => (n.id === id ? { ...n, position: to } : n));
  }
  return moves;
}

/**
 * How far over its bar, or under it, a draft that is brought to its bus is
 * put: the room the devices the diagram places itself are given there.
 */
const OVER_ITS_BAR = 2 * GRID_STEP;

/**
 * How long the connector of a draft may be when it is given its bus where
 * it stands: about as far as a place is looked for around a drop
 * (`DROP_REACH`). A draft farther from its bus than that was not put down
 * with that bus in mind.
 */
export const CONNECTOR_REACH = 256;

/**
 * How far off level or upright the connector of a draft may run where it
 * was dropped, and the draft still be left there when it is given its bus:
 * one put down beside its bar, by hand, is seldom level with it to the
 * pixel. Past this the connector reads as a diagonal.
 */
const SLANT_LEFT_ALONE = GRID_STEP / 2;

export interface ConnectedPlaceOptions extends DraftPlaceOptions {
  picture: PictureOptions;
  /**
   * The draft was just given this bus: it was not dragged to where it
   * stands with its connector in view, so a connector that crosses other
   * lines from there is reason enough to bring it to its bus.
   */
  given: boolean;
}

/**
 * Where the draft `id`, which is connected to a bus from where it stands
 * (the bus was picked in its form), has to go for its connector to be drawn
 * well: `null` where it does already, which is the usual case for one that
 * was dropped near its bus.
 *
 * A device that is dragged is held to the picture of the diagram where it
 * is dropped (`clearDrop`); a draft that is connected from its form was
 * not dropped anywhere, so the same is asked here. Two things move it:
 *
 * - its connector, or its symbol, is on something (a bar the connector runs
 *   along, a symbol it has no way round): nothing on the diagram may be;
 * - it was just given its bus (`given`), and from where it stands its
 *   connector crosses other lines or is longer than `CONNECTOR_REACH`: a
 *   load dropped at the edge of the diagram and then given a bus in the
 *   middle of it is meant to be on that bus, not to reach for it across
 *   everything between. One whose connector only steps round something on
 *   its way, or runs to the bar as a diagonal, goes to the row of its bus
 *   as well, when that has a place where the connector drops square onto
 *   the bar; it stays otherwise.
 *
 * It goes beside its bus (`beside`): into the row the devices of a bus
 * stand in, over the bar or else under it, as near the middle of the bar as
 * there is a place where its connector runs straight to the bar, crosses
 * nothing, and no line has to be routed again to go round it; or, with none
 * in either row, the first of those places where a line has to. With no
 * such place either, one that has to move goes to the nearest place to the
 * bar where the connector is straight, or crosses nothing, or is at least
 * clear. One that was not just given its bus (a
 * re-layout moved things under its connector) stays as near as it can to
 * where it stands. With no place found it stays: no place is better known
 * than the one it was put in.
 */
export function connectedPlace(
  nodes: readonly LabelNode[],
  edges: readonly ConnectionEdge[],
  id: string,
  connections: ConnectionLayout,
  options: ConnectedPlaceOptions,
): { position: { x: number; y: number }; beside: boolean } | null {
  const draft = nodes.find((n) => n.id === id);
  const stub = edges.find((edge) => edge.type === 'stub' && edge.source === id);
  const bus = stub === undefined ? undefined : nodes.find((n) => n.id === stub.target);
  if (draft === undefined || stub === undefined || bus === undefined) return null;
  const standingAt = (position: { x: number; y: number }): LabelNode[] =>
    nodes.map((n) => (n.id === id ? { ...n, position } : n));
  const drawn = (there: readonly LabelNode[]) =>
    connectorDrawn(there, edges, options.picture, id, stub.id);
  const now = drawn(nodes);
  // What has to move it: something drawn over something, or, for one that
  // was just given its bus, a connector that reaches far or across lines.
  const reaches = now.crossings > 0 || now.length > CONNECTOR_REACH;
  const must = now.over || (options.given && reaches);
  // What only makes a place in the row of its bus worth looking for: a
  // connector that steps round something on its way (a bend more than its
  // style has of itself), or runs to the bar at an angle.
  const bent =
    now.bends > (options.picture.connectorStyle === 'elbow' ? 1 : 0) ||
    now.slant > SLANT_LEFT_ALONE;
  if (!must && !(options.given && bent)) return null;
  // The nearest place to `from` that the rules pass and `good` says yes to, or `null`.
  const near = (
    from: { x: number; y: number },
    good: (as: ConnectorDrawn) => boolean,
  ): { x: number; y: number } | null => {
    const clear = (there: readonly LabelNode[]) => good(drawn(there));
    const shift = clearDrop(standingAt(from), edges, new Set([id]), connections, {
      sizes: options.sizes,
      step: options.step,
      atRest: options.atRest,
      clear,
      pictures: options.pictures,
    });
    const to = shift === null ? from : { x: from.x + shift.dx, y: from.y + shift.dy };
    // `clearDrop` answers the nearest place its rules pass when the picture
    // passed none: that one is not taken.
    return clear(standingAt(to)) ? to : null;
  };
  const clear = (as: ConnectorDrawn) => !as.over;
  const uncrossed = (as: ConnectorDrawn) => !as.over && as.crossings === 0;
  const straight = (as: ConnectorDrawn) => uncrossed(as) && as.bends === 0 && as.slant <= 0.5;
  // And in no line's way: every route the diagram keeps still holds.
  const aside = (as: ConnectorDrawn) => straight(as) && as.rerouted === 0;
  if (!options.given) {
    const nearby = near(draft.position, clear);
    if (nearby !== null) return { position: nearby, beside: false };
  }
  const bar = connections.bars.get(bus.id);
  const middle = bus.position.x + ((bar?.start ?? 0) + (bar?.end ?? BAR_LENGTH)) / 2;
  const size = options.sizes?.get(id);
  const width = size?.width ?? draft.initialWidth ?? DRAFT_NODE_SIZE.width;
  const height = size?.height ?? draft.initialHeight ?? DRAFT_NODE_SIZE.height;
  const { step } = options;
  const onGrid = (value: number) => (step === undefined ? value : Math.round(value / step) * step);
  const level = bus.position.y + BAR_THICKNESS / 2;
  const overBar = { x: onGrid(middle - width / 2), y: onGrid(level - OVER_ITS_BAR - height) };
  const underBar = { x: overBar.x, y: onGrid(level + OVER_ITS_BAR) };
  // In the row the devices of a bus stand in, over its bar and then under
  // it, from the middle of the bar outwards: the first place the rules pass
  // where the picture has the connector straight and in no line's way.
  const reach = ((bar?.end ?? BAR_LENGTH) - (bar?.start ?? 0)) / 2 + MAX_OVERHANG;
  let pictures = options.pictures ?? DROP_PICTURES;
  const refused: { x: number; y: number }[] = [];
  // The first place among them where the connector is straight though a
  // line has to give way: taken when none is in no line's way.
  let inAWay: { x: number; y: number } | null = null;
  for (const row of [overBar, underBar]) {
    for (let out = 0; out <= reach && pictures > 0; out += GRID_STEP) {
      for (const x of out === 0 ? [row.x] : [row.x - out, row.x + out]) {
        const place = { x, y: row.y };
        const there = standingAt(place);
        if (pictures <= 0) break;
        if (refused.some((at) => at.y === place.y && Math.abs(at.x - x) < DROP_PICTURE_APART)) {
          continue;
        }
        if (inTheWay(there, edges, new Set([id]), connections, options) !== null) continue;
        pictures -= 1;
        const as = drawn(there);
        if (aside(as)) return { position: place, beside: true };
        if (straight(as)) inAWay ??= place;
        else refused.push(place);
      }
    }
  }
  if (inAWay !== null) return { position: inAWay, beside: true };
  // No place of that kind in either row. One that stands clear, with a
  // connector that only bends or slants, is as well off where it is.
  if (!must) return null;
  const beside = near(overBar, uncrossed) ?? near(overBar, clear);
  if (beside !== null) return { position: beside, beside: true };
  // Just given its bus, with no place beside it: as near as it can stay.
  const nearby = options.given && now.over ? near(draft.position, clear) : null;
  return nearby === null ? null : { position: nearby, beside: false };
}
