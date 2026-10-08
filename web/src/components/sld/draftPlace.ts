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
 * it, but a draft dropped on one stands beside it, off every line and
 * every transformer (`DropOptions.offLines`, and `drawsUndisturbed` for
 * what only the picture knows). It is bound to nothing yet, so free ground
 * is looked for well past where a place for a device is (`DRAFT_REACH`),
 * and only with none there does a line give way to it (`drawsClear`), for
 * as long as it stands there (`draftRoutes.ts`). And a draft that is
 * dropped was not on the diagram before, so there is nowhere for it to go
 * back to: with no clear place near, it stands where the rules have it.
 *
 * `settledPlaces` and `connectedPlace` are for a draft that was not dropped
 * where it stands now: one that something came to stand on, and one that
 * was given its bus in its form, whose connector the picture was never
 * asked about. `draftDrop` is for one that was dragged and let go.
 * `connectedPlace` is also where a generator, load or shunt of the system
 * goes that was moved to another bus (`wiring.ts`): it reads nothing of its
 * node that is a draft's alone.
 *
 * Pure: no React, nothing read but the arguments. `SldCanvas` calls them
 * with the diagram as it was last drawn, and the tests that hold a diagram
 * with drafts on it to the no-overlap rule place their drafts by them.
 */
import {
  BAR_LENGTH,
  BAR_THICKNESS,
  TAP_SPACING,
  type ConnectionEdge,
  type ConnectionLayout,
  type NodeSize,
  type Rect,
} from './connections';
import {
  DROP_PICTURES,
  DROP_PICTURE_APART,
  DROP_REACH,
  clearDrop,
  dropRules,
  type DropOptions,
  type DropShift,
  type RuleOptions,
} from './dropPlace';
import { DRAFT_NODE_SIZE, DRAFT_NODE_TYPE } from './drafts';
import type { LabelNode } from './labels';
import {
  connectorDrawn,
  drawnWith,
  drawsClear,
  drawsUndisturbed,
  longerThanKept,
  routesOf,
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

/**
 * How far from where it was dropped free ground is looked for, for a draft
 * to stand on with no line in its way: twice as far as a place for a device
 * that was dragged (`DROP_REACH`). Where the lines run close together, as
 * in the middle of a diagram, the nearest room for a box of its size is
 * often a bus or two away.
 */
export const DRAFT_REACH = 2 * DROP_REACH;

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
  /** The symbols of the transformers where the diagram has them, which a draft keeps off where it is put. */
  symbols?: readonly Rect[];
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
  // Beside the lines: off every one of them and off the symbols of the
  // transformers, as far away as `DRAFT_REACH`. Or, with `giveWay`, where a
  // device that was dragged may stand, which a line is routed round.
  const placed = (
    giveWay: boolean,
    clear?: (there: readonly LabelNode[]) => boolean,
    pictures = options.pictures,
  ): DraftPlace => {
    const shift = clearDrop([...nodes, probe], edges, new Set([PROBE_ID]), connections, {
      sizes: options.sizes,
      step,
      atRest: options.atRest,
      clear,
      pictures,
      ...(giveWay ? {} : { offLines: true, keepOff: options.symbols, reach: DRAFT_REACH }),
    });
    return {
      position: shift === null ? dropped : { x: dropped.x + shift.dx, y: dropped.y + shift.dy },
      shift,
    };
  };
  if (options.picture === undefined) return placed(false);
  // The nearest place where no line has to give way. The rules keep it off
  // the lines as they are drawn; whether one has to be routed again all the
  // same (its tap moved along a bar, a label that has no other place), only
  // the picture says. It is asked about more places than for a dropped
  // device (`BESIDE_A_LINE`): a draft is wider than the room between two
  // lines, and has to get past one. `clearDrop` stops at the first place the
  // picture passes, so the last answer says whether it found one.
  const undisturbed = drawsUndisturbed(nodes, edges, options.picture);
  let aside = false;
  const beside = placed(
    false,
    (there) => (aside = undisturbed(there)),
    BESIDE_A_LINE * (options.pictures ?? DROP_PICTURES),
  );
  return aside ? beside : placed(true, drawsClear(nodes, edges, options.picture));
}

export interface DraftDropOptions extends Pick<
  DropOptions<LabelNode>,
  'sizes' | 'step' | 'atRest' | 'pictures' | 'back'
> {
  /** What the picture of the diagram is made with. */
  picture: PictureOptions;
  /** The nodes as they stood before the drag (`drawsClear`). */
  before: readonly LabelNode[];
}

/**
 * How far the drafts `movedIds` of `nodes`, which were dragged and stand
 * where they were let go, are to be shifted (`clearDrop`), or `null` where
 * they stand well.
 *
 * A device that is dropped on a line has the line routed round it, and so
 * has a draft, for as long as it stands there. But a draft is a placeholder
 * and leaves the lines as they run where it can: so first the nearest place
 * is looked for where no line of the system is routed again for it, but the
 * ones that are without it as well, and for a draft with a connector the
 * end of a line that moves a tap along its bar for it (`TAP_ROOM`). That
 * place is a little way from where it was let go, or none: as many places
 * are asked about as for any drop, each a little way from the last. With
 * none of them, the draft is dropped as a device is, where the picture has
 * nothing on anything else, and the lines go round it.
 */
export function draftDrop(
  nodes: readonly LabelNode[],
  edges: readonly ConnectionEdge[],
  movedIds: ReadonlySet<string>,
  connections: ConnectionLayout,
  options: DraftDropOptions,
): DropShift | null {
  const { picture, before, back, ...rules } = options;
  // The diagram without what was dragged: what is on what in it whatever
  // comes to stand where, and how far round its lines go as it is.
  let alone: ReturnType<typeof drawnWith> | null = null;
  const without = () =>
    (alone ??= drawnWith(
      nodes.filter((n) => !movedIds.has(n.id)),
      edges.filter((edge) => !movedIds.has(edge.source) && !movedIds.has(edge.target)),
      picture,
    ));
  // One with a connector takes a tap on its bar, which may move the end of
  // a line along it; one without changes nothing about any line.
  const wired = edges.some((edge) => edge.type === 'stub' && movedIds.has(edge.source));
  const asWithout = (line: string, by: number): boolean => {
    if (wired && by <= TAP_ROOM) return true;
    const was = without().longer.get(line);
    return was === undefined ? false : by <= was + TAP_ROOM;
  };
  let calm = false;
  const leavesLines = (there: readonly LabelNode[]): boolean => {
    const now = drawnWith(there, edges, picture);
    calm =
      (now.overlaps.length === 0 || now.overlaps.every((o) => without().overlaps.includes(o))) &&
      [...now.longer].every(([line, by]) => asWithout(line, by));
    return calm;
  };
  const beside = clearDrop(nodes, edges, movedIds, connections, { ...rules, clear: leavesLines });
  // `clearDrop` stops at the first place the picture passes, so the last
  // answer says whether it found one. What the picture refused there with
  // the rules passed is a line that would have had to go round.
  if (calm) return beside?.onto === 'no-way' ? { ...beside, onto: 'line' } : beside;
  return clearDrop(nodes, edges, movedIds, connections, {
    ...rules,
    clear: drawsClear(before, edges, picture),
    back,
  });
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
 * How much longer a line may get for a draft that is given its bus, and
 * still count as left where it ran: the end of a line that shares the bar
 * moves a tap along it to make room for the connector, which takes a step
 * out of the line and back.
 */
const TAP_ROOM = 2 * TAP_SPACING;

/**
 * How far apart the places in the row of a bus are that are tried for the
 * one where the lines go the least way round a draft: what is in the way
 * at one of them is mostly in the way a grid step on as well.
 */
const ROW_STRIDE = 2 * GRID_STEP;

/**
 * How far off level or upright the connector of a draft may run where it
 * was dropped, and the draft still be left there when it is given its bus:
 * one put down beside its bar, by hand, is seldom level with it to the
 * pixel. Past this the connector reads as a diagonal.
 */
const SLANT_LEFT_ALONE = GRID_STEP / 2;

/**
 * The same for what was put on its bus on the diagram, which no hand put
 * down beside that bus: a connector that runs straight, to the half pixel
 * the routes are worked out in (`ConnectedPlaceOptions.slant`).
 */
export const SLANT_PUT_ON_BUS = 0.5;

export interface ConnectedPlaceOptions extends DraftPlaceOptions {
  picture: PictureOptions;
  /**
   * The draft was just given this bus: it was not dragged to where it
   * stands with its connector in view, so a connector that crosses other
   * lines from there is reason enough to bring it to its bus.
   */
  given: boolean;
  /**
   * How far off level or upright its connector may run from where it
   * stands for it to be left there: `SLANT_LEFT_ALONE` unless it says
   * otherwise. One that was put on its bus on the diagram (dropped on the
   * bar, or moved there by the end of its connector) was not put down
   * beside that bus by hand, so it is given a place where its connector
   * drops square whenever the row of its bus has one.
   */
  slant?: number;
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
 *   connector crosses other lines, is longer than `CONNECTOR_REACH`, or
 *   lands where a line has to go round for it (the tap it takes on the bar
 *   can put the end of a line out): a load dropped at the edge of the
 *   diagram and then given a bus in the middle of it is meant to be on
 *   that bus, not to reach for it across everything between. One whose
 *   connector only steps round something on its way, or runs to the bar as
 *   a diagonal (off level or upright by more than `slant`), goes to the row
 *   of its bus as well, when that has a place where the connector drops
 *   square onto the bar; it stays otherwise.
 *
 * It goes beside its bus (`beside`), and stands off the lines there as one
 * that is dropped does: a draft is a placeholder, and where the diagram
 * puts it no line of the system goes round it while free ground is in
 * reach. First into the row the devices of a bus stand in, over the bar or
 * else under it, as near the middle of the bar as there is a place off the
 * lines where its connector runs straight to the bar, crosses nothing, and
 * no line is made to go round (`square`). Where the lines of the bus leave
 * no such place in either row, one that has to move goes to the free
 * ground nearest to the bar from which its connector reaches it over
 * nothing and across no line, within `CONNECTOR_REACH`, though at an angle.
 * Only with none of that either does it go where lines have to go round
 * it: into the row of its bus, at the place among a few where they go the
 * least way round, or else the nearest place to the bar where the connector
 * crosses nothing, or is at least clear. They go round it only for as long
 * as it stands there (`draftRoutes.ts`). One that was not just given its
 * bus (a re-layout moved things under its connector) stays as near as it
 * can to where it stands. With no place found it stays: no place is better
 * known than the one it was put in.
 */
export function connectedPlace(
  nodes: readonly LabelNode[],
  edges: readonly ConnectionEdge[],
  id: string,
  connections: ConnectionLayout,
  options: ConnectedPlaceOptions,
): { position: { x: number; y: number }; beside: boolean; square?: boolean } | null {
  const draft = nodes.find((n) => n.id === id);
  const stub = edges.find((edge) => edge.type === 'stub' && edge.source === id);
  const bus = stub === undefined ? undefined : nodes.find((n) => n.id === stub.target);
  if (draft === undefined || stub === undefined || bus === undefined) return null;
  const standingAt = (position: { x: number; y: number }): LabelNode[] =>
    nodes.map((n) => (n.id === id ? { ...n, position } : n));
  const drawn = (there: readonly LabelNode[]) =>
    connectorDrawn(there, edges, options.picture, id, stub.id);
  const now = drawn(nodes);
  // In no line's way: no line is made to go round for it. One whose end
  // only moves along its bar to make room for the tap of the connector does
  // not count (`TAP_ROOM`), and neither does one that goes as far round
  // without this draft: the pictures are made from the routes the diagram
  // keeps, so a line that goes round another draft is routed again in every
  // one of them (`draftRoutes.ts`).
  //
  // The diagram without this draft says how far round they go without it,
  // and where the lines run that a place for it is held off: a connector
  // that reaches across the diagram has the lines on its way routed round
  // it, for as long as it does.
  let alone: {
    connections: ConnectionLayout;
    longer: ReadonlyMap<string, number>;
  } | null = null;
  const without = () => {
    if (alone === null) {
      const others = edges.filter((edge) => edge.id !== stub.id);
      const routed = routesOf(
        nodes.filter((n) => n.id !== id),
        others,
        options.picture,
      );
      alone = { connections: routed.connections, longer: longerThanKept(others, routed.changed) };
    }
    return alone;
  };
  const calm = (as: ConnectorDrawn): boolean => {
    for (const [line, by] of as.longer) {
      if (by > TAP_ROOM && by > (without().longer.get(line) ?? 0) + TAP_ROOM) return false;
    }
    return true;
  };
  /** How far round the lines go for it, all together. */
  const wayRound = (as: ConnectorDrawn): number => {
    let round = 0;
    for (const [line, by] of as.longer) {
      round += Math.max(0, by - (without().longer.get(line) ?? 0));
    }
    return round;
  };
  // What has to move it: something drawn over something, or, for one that
  // was just given its bus, a connector that reaches far or across lines,
  // or lands where a line has to go round for it.
  const reaches = now.crossings > 0 || now.length > CONNECTOR_REACH;
  const must = now.over || (options.given && (reaches || !calm(now)));
  // What only makes a place in the row of its bus worth looking for: a
  // connector that steps round something on its way (a bend more than its
  // style has of itself), or runs to the bar at an angle.
  const bent =
    now.bends > (options.picture.connectorStyle === 'elbow' ? 1 : 0) ||
    now.slant > (options.slant ?? SLANT_LEFT_ALONE);
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
  const aside = (as: ConnectorDrawn) => straight(as) && calm(as);
  if (!options.given) {
    const nearby = near(draft.position, clear);
    if (nearby !== null) return { position: nearby, beside: false };
  }
  // Its bar as long as it is without the tap of this connector.
  const bar = without().connections.bars.get(bus.id);
  const span = {
    left: bus.position.x + (bar?.start ?? 0),
    right: bus.position.x + (bar?.end ?? BAR_LENGTH),
  };
  const middle = (span.left + span.right) / 2;
  const size = options.sizes?.get(id);
  const width = size?.width ?? draft.initialWidth ?? DRAFT_NODE_SIZE.width;
  const height = size?.height ?? draft.initialHeight ?? DRAFT_NODE_SIZE.height;
  const { step } = options;
  const onGrid = (value: number) => (step === undefined ? value : Math.round(value / step) * step);
  const level = bus.position.y + BAR_THICKNESS / 2;
  const overBar = { x: onGrid(middle - width / 2), y: onGrid(level - OVER_ITS_BAR - height) };
  const underBar = { x: overBar.x, y: onGrid(level + OVER_ITS_BAR) };
  // What the rules say of a place around its bus: off the symbols and the
  // bars, and off the lines and the symbols of the transformers.
  const held: RuleOptions<LabelNode> = {
    sizes: options.sizes,
    atRest: without().connections,
    offLines: true,
    keepOff: options.symbols,
    reach: CONNECTOR_REACH + (span.right - span.left) / 2 + width,
  };
  const rulesAt = dropRules(standingAt(overBar), edges, new Set([id]), without().connections, held);
  const free = (place: { x: number; y: number }): boolean =>
    rulesAt === null || rulesAt(place.x - overBar.x, place.y - overBar.y) === null;
  // What the picture says of a place, asked once.
  const asked = new Map<string, ConnectorDrawn>();
  const ask = (place: { x: number; y: number }): ConnectorDrawn => {
    const key = `${place.x},${place.y}`;
    let as = asked.get(key);
    if (as === undefined) asked.set(key, (as = drawn(standingAt(place))));
    return as;
  };
  // In the row the devices of a bus stand in, over its bar and then under
  // it, from the middle of the bar outwards: the first place the rules pass
  // where the picture has the connector straight and in no line's way.
  const reach = (span.right - span.left) / 2 + MAX_OVERHANG;
  let pictures = options.pictures ?? DROP_PICTURES;
  const refused: { x: number; y: number }[] = [];
  // The place where the connector is straight though a line has to go round
  // for it, and of several the one where the lines go the least way round:
  // taken when no place is in no line's way.
  let inAWay: { place: { x: number; y: number }; round: number } | null = null;
  const orInAWay = (place: { x: number; y: number }, as: ConnectorDrawn): void => {
    const round = wayRound(as);
    if (inAWay === null || round < inAWay.round) inAWay = { place, round };
  };
  for (const row of [overBar, underBar]) {
    for (let out = 0; out <= reach && pictures > 0; out += GRID_STEP) {
      for (const x of out === 0 ? [row.x] : [row.x - out, row.x + out]) {
        const place = { x, y: row.y };
        if (pictures <= 0) break;
        if (refused.some((at) => at.y === place.y && Math.abs(at.x - x) < DROP_PICTURE_APART)) {
          continue;
        }
        if (!free(place)) continue;
        pictures -= 1;
        const as = ask(place);
        if (aside(as)) return { position: place, beside: true, square: true };
        if (straight(as)) orInAWay(place, as);
        else refused.push(place);
      }
    }
  }
  // No place of that kind in either row. One that stands clear and in no
  // line's way, with a connector that only bends or slants, is as well off
  // where it is.
  if (!must) return null;
  // On free ground beside the bus then, the nearest to the bar first: where
  // the connector reaches the bar over nothing and across no line, and no
  // line has to give way, though it runs there at an angle.
  const within = (as: ConnectorDrawn) => uncrossed(as) && as.length <= CONNECTOR_REACH && calm(as);
  const around: { x: number; y: number; far: number; under: boolean; off: number }[] = [];
  const across = Math.ceil(held.reach! / GRID_STEP);
  const down = Math.ceil((CONNECTOR_REACH + height + OVER_ITS_BAR) / GRID_STEP);
  for (let i = -across; i <= across; i += 1) {
    for (let k = -down; k <= down; k += 1) {
      const place = { x: overBar.x + i * GRID_STEP, y: overBar.y + k * GRID_STEP };
      // Over the bar or under it: level with it the connector would run along it.
      const under = place.y > level;
      if (!under && place.y + height > level) continue;
      const centre = place.x + width / 2;
      const off = Math.abs(centre - Math.min(span.right, Math.max(span.left, centre)));
      const far = Math.hypot(off, under ? place.y - level : level - place.y - height);
      if (far <= CONNECTOR_REACH) around.push({ ...place, far, under, off });
    }
  }
  around.sort(
    (p, q) => p.far - q.far || Number(p.under) - Number(q.under) || p.off - q.off || p.x - q.x,
  );
  pictures = options.pictures ?? DROP_PICTURES;
  const passed: { x: number; y: number }[] = [];
  for (const { x, y } of around) {
    if (pictures <= 0) break;
    const tooNear = passed.some(
      (at) => Math.max(Math.abs(at.x - x), Math.abs(at.y - y)) < DROP_PICTURE_APART,
    );
    if (tooNear || !free({ x, y })) continue;
    if (!asked.has(`${x},${y}`)) pictures -= 1;
    if (within(ask({ x, y }))) return { position: { x, y }, beside: true, square: false };
    passed.push({ x, y });
  }
  // No free ground in reach that it can be connected from: the lines of
  // its bus leave none. It goes into the row of its bus then, on a line or
  // not, where the lines that have to go round it go the least way round:
  // over the bar and under it by turns, from the middle outwards.
  const plainAt = dropRules(standingAt(overBar), edges, new Set([id]), without().connections, {
    sizes: options.sizes,
    atRest: without().connections,
    reach: held.reach,
  });
  pictures = options.pictures ?? DROP_PICTURES;
  for (let out = 0; out <= reach && pictures > 0; out += ROW_STRIDE) {
    for (const row of [overBar, underBar]) {
      for (const x of out === 0 ? [row.x] : [row.x - out, row.x + out]) {
        if (pictures <= 0) break;
        const place = { x, y: row.y };
        if (plainAt !== null && plainAt(x - overBar.x, row.y - overBar.y) !== null) continue;
        if (!asked.has(`${x},${row.y}`)) pictures -= 1;
        const as = ask(place);
        if (straight(as)) orInAWay(place, as);
      }
    }
  }
  const way = inAWay as { place: { x: number; y: number } } | null;
  if (way !== null) return { position: way.place, beside: true, square: true };
  const beside = near(overBar, uncrossed) ?? near(overBar, clear);
  if (beside !== null) return { position: beside, beside: true, square: false };
  // Just given its bus, with no place beside it: as near as it can stay.
  const nearby = options.given && now.over ? near(draft.position, clear) : null;
  return nearby === null ? null : { position: nearby, beside: false };
}
