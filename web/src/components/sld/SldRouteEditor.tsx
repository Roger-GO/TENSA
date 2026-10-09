/**
 * Moving a line of the diagram by hand: the handles of the line that is
 * picked, and the bar over the diagram that goes with them.
 *
 * A click on a line, a transformer or the connector of a device picks it
 * (`SldCanvas`), and this draws over it, in the coordinates of the diagram:
 *
 * - the line itself, picked out in the accent colour;
 * - a square on each bend, which is dragged to move the bend (the two runs
 *   that meet there stay level or upright; with Alt or Shift held the
 *   bend moves alone, and so does one that was just put into a straight
 *   run, which is how the line is made to turn there) and double-clicked to
 *   take it out;
 * - a round handle with a plus beside the middle of each run, which is
 *   dragged to pull a new bend out of the run and clicked to put one in
 *   (beside the run and not on it, so that the run can be grabbed anywhere);
 * - the runs themselves, which are dragged to slide them sideways and
 *   double-clicked to put a bend in where they are, so that either half
 *   can then be slid on its own. Each is a band along its run, so that it
 *   has a box of its own and the middle of that box is on the run.
 *
 * Every one of them takes the keyboard focus (Tab goes from one to the
 * next) and has a name that says what it is and what the keys do: the
 * arrow keys move a run or a bend (Shift for bigger steps), Enter puts a
 * bend into a run, Delete takes a bend out, and Escape lets go of the line.
 * The bar has the same as buttons (Add bend and Done always, Remove bend
 * while a bend is picked, Reset route while the route is drawn by hand),
 * says whether the route is drawn by hand, how the handles are used, and
 * what a move was refused for. It is drawn in the row above the diagram,
 * in the place of the line that says what can be done on it (`barSlot`,
 * which `SldCanvasHint` leaves for it), and is no higher than what it takes
 * the place of, so that the diagram does not move when a line is picked.
 * What it says about a move is read whole: a note too long for its one
 * line goes on under it, over the top edge of the diagram, and is not cut
 * off.
 *
 * Nothing on the diagram is drawn over anything else, so a move is held to
 * a check of the route (`routeCheck.ts`) while it is made: where the part
 * that is dragged would put the line on something, the line is drawn at
 * the nearest place where it is on nothing (`settleEdit`), the route it was
 * asked for is drawn dashed in the colour of a refusal, and the bar says
 * what stands in the way. The canvas has the last word on a route that is
 * let go (`onCommit`), and what it says is shown the same way.
 *
 * The geometry of the moves is `routeEdit.ts`; this is pointers, keys and
 * drawing. It is rendered as a child of `<ReactFlow>`, over the diagram and
 * under its controls, and left out of a PNG export.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useReactFlow, useStore } from '@xyflow/react';

import { cn } from '@/lib/cn';
import { routePath, runKind, type Point, type RunKind } from './connections';
import type { RouteCheck } from './routeCheck';
import {
  applyEdit,
  KINK_REASON,
  kinkReason,
  leavesKink,
  MIN_STEP,
  nearestOnRun,
  pointIn,
  removeBend,
  ROUTE_FOCUS_ATTR,
  runIn,
  sameRoute,
  settleEdit,
  slideRun,
  SPLIT_ROOM,
  tidyPoints,
  type EditPart,
  type EditedRoute,
  type RouteEnds,
} from './routeEdit';

/** How far the arrow keys move what is picked, and how many times as far with Shift held (as React Flow moves a node). */
export const NUDGE_STEP = 5;
export const NUDGE_FACTOR = 4;

/** How far the pointer goes, in pixels on screen, before a press on a handle is a drag. */
const DRAG_SLOP_PX = 3;

/** How near, in pixels on screen, a bend that is moved freely comes to being in line before it is put in line. */
const ALIGN_PX = 6;

/** The sizes of what is drawn, in pixels on screen. */
const HANDLE_PX = 9;
const ADD_RADIUS_PX = 5;
const HIT_WIDTH_PX = 14;
/** The shortest run, in pixels on screen, that has a handle for a new bend beside its middle. */
const ADD_ROOM_PX = 36;
/** How far beside its run that handle stands, in pixels on screen. */
const ADD_OFFSET_PX = 13;

/** What the bar says when a part that is moved along a bar can go no further. */
const END_ON_BAR_NOTE =
  'The end of a line stays on the bar of its bus: it is at the tip, and goes no further that way.';

/** What the bar says when a part was moved too little way to make a step of. */
const SHORT_STEP_NOTE = `A step is ${MIN_STEP} px at the least: keep dragging to make one.`;

/** What the bar says once a bend was put into a run. */
const BEND_ADDED_NOTE =
  'Bend added. Drag it, or press the arrow keys, to make the line turn there; drag the run on either side of it for a square step.';

/**
 * How the handles are used and how the line is let go of, as the bar says
 * it while it has nothing else to say: short enough for the one line it
 * has beside an open Inspector, with the rest in its tooltip.
 */
export const ROUTE_EDIT_HINT =
  'Drag the line to slide it, a square to move a bend, a + to add one. Esc to finish.';
export const ROUTE_EDIT_HELP =
  'Drag a run of the blue line to slide it sideways, a square to move a bend, a + to add one. Double-click a run to add a bend, a square to remove it. The arrow keys move the run or the bend you clicked (Shift for bigger steps). Hold Alt or Shift while dragging a bend to move it alone. Nothing changes until you move a part of the line. Press Esc or Done, or click the background, when you have finished.';

/** The height of the one line the note of the bar has, in pixels. */
const NOTE_LINE_PX = 14;

export interface SldRouteEditorProps {
  /** The id of the edge that is picked. */
  edgeId: string;
  /** What it is called: `Line Line_3`, `Connector of PQ_2`. */
  name: string;
  /** Its route as it is drawn. */
  points: readonly Point[];
  /** Whether that route was drawn by hand. */
  manual: boolean;
  /** What its two ends are attached to. */
  ends: RouteEnds;
  /**
   * A check of the routes it could be given, on the diagram as it stands:
   * asked for at the start of a move.
   */
  makeCheck: () => RouteCheck;
  /** The grid a part that is moved lands on, or `null` while Snap to grid is off. */
  grid: number | null;
  /**
   * Keep `points` as the route of the line. `what` names the move for Undo
   * (`slide a run of`), and `coalesce` is set for a move by the keys, which
   * the next one of the same kind is part of. Answers what the diagram
   * refuses the route for, or `null` when it was kept.
   */
  onCommit: (points: Point[], what: string, coalesce: string | null) => string | null;
  /** Give the line back to the automatic routing. */
  onReset: () => void;
  /** Let go of the line. */
  onDone: () => void;
  /**
   * The place in the row above the diagram where the bar is drawn; `null`
   * until that row has been drawn, and the bar with it.
   */
  barSlot: HTMLElement | null;
}

/** What of the route has the focus of the keys: a run by the index of its first point, or a bend. */
interface Picked {
  kind: 'run' | 'bend';
  index: number;
}

/** What the bar says about the last move. */
interface Note {
  text: string;
  tone: 'plain' | 'refused';
}

/** A drag that is under way. */
interface Drag {
  part: EditPart;
  /** Where the pointer went down, on the diagram. */
  start: Point;
  /** The route the drag started from, with the bends that were put in. */
  base: Point[];
  check: RouteCheck | null;
  /** The last route that was clear, and what the place it was asked for was refused for. */
  last: { points: Point[]; edited: EditedRoute; refused: string | null } | null;
  moved: boolean;
}

const KIND_NAME: Record<RunKind, string> = {
  level: 'level',
  upright: 'upright',
  angled: 'slanted',
};

/** Which keys move a run of each kind, for its name and for the note of a key that does nothing. */
const RUN_KEYS: Record<RunKind, string> = {
  level: 'Up and Down arrow keys slide it',
  upright: 'Left and Right arrow keys slide it',
  angled: 'arrow keys move it',
};

/** The move an arrow key asks for; `null` for any other key. */
function arrowMove(key: string, step: number): [number, number] | null {
  switch (key) {
    case 'ArrowLeft':
      return [-step, 0];
    case 'ArrowRight':
      return [step, 0];
    case 'ArrowUp':
      return [0, -step];
    case 'ArrowDown':
      return [0, step];
    default:
      return null;
  }
}

/**
 * The band of a run from `a` to `b`, `width` across with round ends: a
 * rectangle about the middle of the run, turned to lie along it.
 */
function runBand(a: Point, b: Point, width: number) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const turn = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  return {
    x: mx - (length + width) / 2,
    y: my - width / 2,
    width: length + width,
    height: width,
    rx: width / 2,
    transform: `rotate(${turn} ${mx} ${my})`,
  };
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function SldRouteEditor({
  edgeId,
  name,
  points,
  manual,
  ends,
  makeCheck,
  grid,
  onCommit,
  onReset,
  onDone,
  barSlot,
}: SldRouteEditorProps) {
  const rf = useReactFlow();
  const [tx, ty, zoom] = useStore((s) => s.transform);
  /** One pixel on screen, on the diagram. */
  const px = 1 / (zoom > 0 ? zoom : 1);

  // The bends that were put into a run and not moved yet. They are in line
  // with their run, which the route as it is kept has no point for, so they
  // are held here until a move makes a step of one, or the line is let go.
  const [splits, setSplits] = useState<Point[]>([]);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [shown, setShown] = useState<{ points: Point[]; wanted: Point[] | null } | null>(null);
  const dragRef = useRef<Drag | null>(null);
  // The part that takes the focus of the keys once its handle is drawn (below).
  const focusNext = useRef<Picked | null>(null);
  // Another line: nothing of the one before carries over.
  useEffect(() => {
    setSplits([]);
    setPicked(null);
    setNote(null);
    setShown(null);
    dragRef.current = null;
    focusNext.current = null;
  }, [edgeId]);

  // The route with the bends that were put in, each on the run it is in.
  const working = useMemo(() => {
    const out = points.map(([x, y]): Point => [x, y]);
    const apart = (p: Point, q: Point): number => Math.hypot(p[0] - q[0], p[1] - q[1]);
    for (const split of splits) {
      for (let k = 0; k + 1 < out.length; k += 1) {
        const [a, b] = [out[k]!, out[k + 1]!];
        if (apart(nearestOnRun(a, b, split), split) > 0.5) continue;
        if (apart(a, split) > 0.5 && apart(b, split) > 0.5) out.splice(k + 1, 0, split);
        break;
      }
    }
    return out;
  }, [points, splits]);

  /** Whether the bend at `index` is one that was put into a run and not moved yet. */
  const inLine = (index: number): boolean => {
    const p = working[index];
    return (
      p !== undefined && splits.some((split) => Math.hypot(split[0] - p[0], split[1] - p[1]) <= 0.5)
    );
  };

  const handles = useRef(new Map<string, SVGElement>());
  const keyOf = (part: Picked): string => `${part.kind}-${part.index}`;
  const holdRef =
    (part: Picked) =>
    (element: SVGElement | null): void => {
      if (element === null) handles.current.delete(keyOf(part));
      else handles.current.set(keyOf(part), element);
    };
  // After a move by the keys the part that was moved keeps the focus, under
  // the index it has in the route as it is now. The route that was kept
  // comes back from the canvas a render or two later, and a bend that was
  // put in has no handle until it does: the focus waits for the handle.
  useEffect(() => {
    const next = focusNext.current;
    if (next === null) return;
    const handle = handles.current.get(keyOf(next));
    if (handle === undefined) return;
    focusNext.current = null;
    handle.focus();
  });

  /** Where on the diagram the pointer of `event` is. */
  const pointerAt = useCallback(
    (event: { clientX: number; clientY: number }): Point => {
      const at = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      return [at.x, at.y];
    },
    [rf],
  );

  /** What a move of `part` is called in the Edit menu. */
  const moveName = (part: EditPart): string =>
    part.kind === 'run' ? 'slide a run of' : part.kind === 'bend' ? 'move a bend of' : 'bend';

  /**
   * Hand `route`, which the move `edited` came to, to the canvas to keep,
   * and say so when it is refused. `part` is what was moved, which stays
   * picked under the index it has in the route as it is then.
   */
  const keep = (
    route: Point[],
    edited: EditedRoute,
    part: EditPart,
    coalesce: string | null,
  ): boolean => {
    const refusal = onCommit(route, moveName(part), coalesce);
    if (refusal !== null) {
      setNote({ text: `Not moved: ${refusal}.`, tone: 'refused' });
      return false;
    }
    setSplits([]);
    const index =
      part.kind === 'run'
        ? runIn(edited.points, edited.picked, route)
        : pointIn(edited.points, edited.picked, route);
    const next: Picked | null =
      index < 0 ? null : { kind: part.kind === 'run' ? 'run' : 'bend', index };
    setPicked(next);
    focusNext.current = next;
    return true;
  };

  // ---- a drag ----
  const begin = (event: React.PointerEvent<SVGElement>, part: EditPart): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    // The pointer has the line now: no handle waits for the focus of the keys.
    focusNext.current = null;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      part,
      start: pointerAt(event),
      base: working,
      check: null,
      last: null,
      moved: false,
    };
    setPicked(part.kind === 'pull' ? null : { kind: part.kind, index: part.index });
    setNote(null);
  };
  const drag = (event: React.PointerEvent<SVGElement>): void => {
    const held = dragRef.current;
    if (held === null) return;
    const at = pointerAt(event);
    // By whole units of the diagram: a route is kept as it is drawn.
    const by: [number, number] = [
      Math.round(at[0] - held.start[0]),
      Math.round(at[1] - held.start[1]),
    ];
    if (!held.moved && Math.hypot(by[0], by[1]) < DRAG_SLOP_PX * px) return;
    held.moved = true;
    held.check ??= makeCheck();
    // Alt, or Shift: a drag with Alt held moves the window on some desktops.
    // A bend that was put into a straight run and not moved yet moves alone
    // as well: moved with its runs kept square it would only slide the run.
    const free =
      event.altKey || event.shiftKey || (held.part.kind === 'bend' && inLine(held.part.index));
    const settled = settleEdit(held.base, held.part, by, ends, held.check, {
      free,
      grid: grid ?? undefined,
      align: ALIGN_PX * px,
    });
    if (settled === null) {
      // No clear place near: the line stays where it last was, and the
      // route that was asked for shows why.
      const edited = applyEdit(held.base, held.part, by, ends, { free });
      const asked = tidyPoints(edited.points);
      const why =
        kinkReason(held.base, edited, asked) ?? held.check(asked) ?? 'there is no room for it';
      setShown({ points: held.last?.points ?? tidyPoints(held.base), wanted: asked });
      setNote({ text: `Not there: ${why}. No clear place is near.`, tone: 'refused' });
      return;
    }
    held.last = { points: settled.points, edited: settled.edited, refused: settled.refused };
    setShown({ points: settled.points, wanted: settled.wanted });
    setNote(
      settled.stayed === true
        ? // Dragging on makes a step, unless the tip of the bar leaves no room for one.
          settled.refused !== KINK_REASON
          ? { text: `Not there: ${settled.refused}.`, tone: 'refused' }
          : { text: SHORT_STEP_NOTE, tone: 'plain' }
        : settled.refused !== null
          ? {
              text: `Not there: ${settled.refused}. Shown at the nearest clear place.`,
              tone: 'refused',
            }
          : // An end that reached the tip of its bar went less far than the pointer.
            settled.edited.stopped === true
            ? { text: END_ON_BAR_NOTE, tone: 'plain' }
            : null,
    );
  };
  const drop = (event: React.PointerEvent<SVGElement>): void => {
    const held = dragRef.current;
    if (held === null) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
    setShown(null);
    if (!held.moved) {
      // A click on the handle for a new bend puts one in the middle of its run.
      if (held.part.kind === 'pull') split(held.part.index);
      return;
    }
    if (held.last === null) return;
    if (sameRoute(held.last.points, tidyPoints(points))) return;
    if (!keep(held.last.points, held.last.edited, held.part, null)) return;
    setNote(
      held.last.refused === null
        ? null
        : {
            text: `Nearest clear place: where you let go, ${held.last.refused}.`,
            tone: 'plain',
          },
    );
  };
  // The pointer was taken away without being let go (the window lost it):
  // the line stays where it was.
  const cancel = (): void => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    setShown(null);
    setNote(null);
  };

  // ---- the keys, and the buttons that do the same ----
  /** Move `part` by `by`, as the arrow keys do: there, or not at all. */
  const nudge = (part: Picked, by: [number, number]): void => {
    // A bend that was put into a straight run and not moved yet moves alone.
    const fresh = part.kind === 'bend' && inLine(part.index);
    const options = { grid: grid ?? undefined, free: fresh };
    let edited = applyEdit(working, part, by, ends, options);
    let route = tidyPoints(edited.points);
    if (fresh && sameRoute(route, tidyPoints(working))) {
      // Along its run: the bend goes there, and the line is as it was.
      const [a, to, b] = [
        working[part.index - 1],
        edited.points[part.index],
        working[part.index + 1],
      ];
      const room = (q: Point | undefined): boolean =>
        to !== undefined && q !== undefined && Math.hypot(to[0] - q[0], to[1] - q[1]) >= SPLIT_ROOM;
      const from = working[part.index];
      if (to === undefined || from === undefined || !room(a) || !room(b)) {
        setNote({ text: 'The bend is at the end of its run: it goes no further.', tone: 'plain' });
        return;
      }
      setSplits((held) =>
        held.map((p) => (Math.hypot(p[0] - from[0], p[1] - from[1]) <= 0.5 ? to : p)),
      );
      focusNext.current = part;
      setNote(null);
      return;
    }
    if (leavesKink(working, route) && Math.hypot(by[0], by[1]) < MIN_STEP) {
      // A step that small is no step: the shortest one that is, the same way.
      const scale = MIN_STEP / Math.hypot(by[0], by[1]);
      edited = applyEdit(working, part, [by[0] * scale, by[1] * scale], ends, options);
      route = tidyPoints(edited.points);
    }
    if (sameRoute(route, tidyPoints(working))) {
      const a = working[part.index];
      const b = working[part.index + 1];
      const kind = part.kind === 'run' && a && b ? runKind(a, b) : null;
      // The key was for the way this run does not slide, or its end is at
      // the tip of the bar.
      const across = (kind === 'level' && by[1] === 0) || (kind === 'upright' && by[0] === 0);
      setNote({
        text: across
          ? kind === 'level'
            ? 'A level run slides up and down: press the Up or Down arrow key.'
            : 'An upright run slides left and right: press the Left or Right arrow key.'
          : edited.stopped === true
            ? END_ON_BAR_NOTE
            : 'It cannot move that way.',
        tone: 'plain',
      });
      return;
    }
    const why = kinkReason(working, edited, route) ?? makeCheck()(route);
    if (why !== null) {
      setNote({ text: `Not moved: ${why}.`, tone: 'refused' });
      return;
    }
    if (keep(route, edited, part, `route:${edgeId}:${part.kind}`)) setNote(null);
  };
  /** Put a bend into the run at `run`, at `at` or in its middle. */
  const split = (run: number, at?: Point): void => {
    const [a, b] = [working[run], working[run + 1]];
    if (a === undefined || b === undefined) return;
    const near = nearestOnRun(a, b, at ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    // On a whole unit of the diagram along a level or an upright run.
    const on: Point = [
      Math.abs(a[1] - b[1]) <= 0.5 ? Math.round(near[0]) : near[0],
      Math.abs(a[0] - b[0]) <= 0.5 ? Math.round(near[1]) : near[1],
    ];
    const room = 6 * px;
    if (
      Math.hypot(on[0] - a[0], on[1] - a[1]) < room ||
      Math.hypot(on[0] - b[0], on[1] - b[1]) < room
    ) {
      setNote({ text: 'This run is too short for another bend.', tone: 'plain' });
      return;
    }
    setSplits((held) => [...held, on]);
    const next: Picked = { kind: 'bend', index: run + 1 };
    setPicked(next);
    focusNext.current = next;
    setNote({ text: BEND_ADDED_NOTE, tone: 'plain' });
  };
  /** Take the bend at `bend` out. */
  const remove = (bend: number): void => {
    const p = working[bend];
    if (p === undefined || bend <= 0 || bend >= working.length - 1) return;
    const added = splits.findIndex((s) => Math.hypot(s[0] - p[0], s[1] - p[1]) <= 0.5);
    if (added >= 0) {
      // One that was put in and never moved: nothing of the line changes.
      setSplits((held) => held.filter((_, i) => i !== added));
      setPicked(null);
      setNote({ text: 'Bend removed.', tone: 'plain' });
      return;
    }
    const without = removeBend(working, bend);
    if (without === null) return;
    const route = tidyPoints(without);
    const why = makeCheck()(route);
    if (why !== null) {
      setNote({ text: `Not removed: without this bend ${why}.`, tone: 'refused' });
      return;
    }
    const refusal = onCommit(route, 'remove a bend of', null);
    if (refusal !== null) {
      setNote({ text: `Not removed: ${refusal}.`, tone: 'refused' });
      return;
    }
    setSplits([]);
    setPicked(null);
    setNote({ text: 'Bend removed.', tone: 'plain' });
  };
  const onKeyDown = (event: React.KeyboardEvent<SVGElement>, part: Picked): void => {
    const step = (grid ?? NUDGE_STEP) * (event.shiftKey ? NUDGE_FACTOR : 1);
    const by = arrowMove(event.key, step);
    if (by !== null) {
      event.preventDefault();
      event.stopPropagation();
      nudge(part, by);
      return;
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      onDone();
    } else if (part.kind === 'run' && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      event.stopPropagation();
      split(part.index);
    } else if (part.kind === 'bend' && (event.key === 'Delete' || event.key === 'Backspace')) {
      event.preventDefault();
      event.stopPropagation();
      remove(part.index);
    }
  };

  // The longest run, which Add bend bends when no run is picked.
  const longestRun = useMemo(() => {
    let best = 0;
    let most = -1;
    for (let k = 0; k + 1 < working.length; k += 1) {
      const length = Math.hypot(
        working[k + 1]![0] - working[k]![0],
        working[k + 1]![1] - working[k]![1],
      );
      if (length > most) [best, most] = [k, length];
    }
    return best;
  }, [working]);
  // The run the keys are handed when the line is picked from away from it
  // (its row in the Lines table, the Inspector, Enter on the line): one a
  // first press of an arrow key moves. A middle run before an end run, since
  // the end of a line stays on its bar and one that is at the tip already
  // goes nowhere; the longer before the shorter; and of those the first that
  // slides either way.
  const focusRun = useMemo(() => {
    const count = working.length - 1;
    const length = (k: number): number =>
      Math.hypot(working[k + 1]![0] - working[k]![0], working[k + 1]![1] - working[k]![1]);
    const atEnd = (k: number): number => (k === 0 || k === count - 1 ? 1 : 0);
    const order = Array.from({ length: Math.max(count, 0) }, (_, k) => k).sort(
      (a, b) => atEnd(a) - atEnd(b) || length(b) - length(a),
    );
    const base = tidyPoints(working);
    const slides = (k: number): boolean => {
      const upright = runKind(working[k]!, working[k + 1]!) !== 'level';
      return [MIN_STEP, -MIN_STEP].some((step) => {
        const edited = slideRun(working, k, upright ? [step, 0] : [0, step], ends);
        return edited.stopped !== true && !sameRoute(tidyPoints(edited.points), base);
      });
    };
    return order.find(slides) ?? longestRun;
  }, [working, ends, longestRun]);
  const pickedBend =
    picked?.kind === 'bend' && picked.index > 0 && picked.index < working.length - 1
      ? picked.index
      : null;
  const pickedRun =
    picked?.kind === 'run' && picked.index < working.length - 1 ? picked.index : null;

  // Whether what the bar says about a move takes more than its one line:
  // it then goes on under the line, and is set off from the diagram there.
  const noteRef = useRef<HTMLParagraphElement | null>(null);
  const [noteWraps, setNoteWraps] = useState(false);
  useLayoutEffect(() => {
    const wraps = note !== null && (noteRef.current?.scrollHeight ?? 0) > NOTE_LINE_PX + 1;
    if (wraps !== noteWraps) setNoteWraps(wraps);
  }, [note, noteWraps]);

  const dragging = shown !== null;
  const drawnPoints = shown?.points ?? working;
  const half = (HANDLE_PX / 2) * px;
  const runs = working
    .slice(1)
    .map((b, k) => ({ a: working[k]!, b, kind: runKind(working[k]!, b) }));
  const total = runs.length;

  return (
    <>
      <svg
        data-testid="sld-route-editor"
        data-edge-id={edgeId}
        data-manual={manual ? 'true' : 'false'}
        data-route={JSON.stringify(drawnPoints)}
        data-export-ignore=""
        className="pointer-events-none absolute inset-0 h-full w-full overflow-visible select-none"
        style={{ zIndex: 4 }}
        // A double-click on a handle is the handle's: it selects no text of the page.
        onMouseDown={(event) => {
          if (event.detail > 1) event.preventDefault();
        }}
      >
        <g transform={`translate(${tx},${ty}) scale(${zoom})`}>
          {/* Where the line was, while it is dragged somewhere else. */}
          {dragging ? (
            <path
              d={routePath(working)}
              fill="none"
              stroke="var(--color-muted-foreground)"
              strokeWidth={1.5 * px}
              strokeDasharray={`${4 * px} ${4 * px}`}
            />
          ) : null}
          {/* The route that was asked for and refused. */}
          {shown?.wanted ? (
            <path
              data-testid="sld-route-refused"
              d={routePath(shown.wanted)}
              fill="none"
              stroke="var(--color-danger)"
              strokeWidth={1.5 * px}
              strokeDasharray={`${3 * px} ${3 * px}`}
            />
          ) : null}
          <path
            data-testid="sld-route-line"
            d={routePath(drawnPoints)}
            fill="none"
            stroke="var(--color-primary)"
            strokeWidth={Math.max(3, 2.5 * px)}
            strokeLinejoin="round"
          />
          {/* The runs: dragged to slide, double-clicked for a bend. */}
          {runs.map(({ a, b, kind }, k) => (
            // A band along the run, as wide as the pointer needs: a shape with
            // a box of its own, which a line that is level or upright has not,
            // so that what clicks the middle of an element (an assistive tool,
            // a test) finds the run and clicks it.
            <rect
              key={`run-${k}`}
              ref={holdRef({ kind: 'run', index: k })}
              data-testid={`sld-route-run-${k}`}
              data-kind={kind}
              data-picked={pickedRun === k ? 'true' : undefined}
              {...(k === focusRun ? { [ROUTE_FOCUS_ATTR]: '' } : {})}
              role="button"
              tabIndex={0}
              aria-label={`Run ${k + 1} of ${total} of ${name}, ${KIND_NAME[kind]}: drag it to slide it, or the ${RUN_KEYS[kind]}. Enter adds a bend in its middle.`}
              {...runBand(a, b, HIT_WIDTH_PX * px)}
              fill={pickedRun === k && !dragging ? 'var(--color-primary)' : 'transparent'}
              fillOpacity={0.3}
              strokeWidth={1.5 * px}
              className="nodrag nopan focus:outline-none focus-visible:[stroke:var(--color-ring)]"
              style={{
                pointerEvents: 'all',
                cursor: kind === 'level' ? 'ns-resize' : kind === 'upright' ? 'ew-resize' : 'move',
              }}
              onPointerDown={(event) => begin(event, { kind: 'run', index: k })}
              onPointerMove={drag}
              onPointerUp={drop}
              onPointerCancel={cancel}
              onLostPointerCapture={cancel}
              onDoubleClick={(event) => {
                event.stopPropagation();
                split(k, pointerAt(event));
              }}
              onFocus={() => setPicked({ kind: 'run', index: k })}
              onKeyDown={(event) => onKeyDown(event, { kind: 'run', index: k })}
            >
              <title>
                {`Drag to slide this run ${kind === 'level' ? 'up or down' : kind === 'upright' ? 'left or right' : ''}. Double-click to add a bend here.`}
              </title>
            </rect>
          ))}
          {/* A new bend: beside the middle of each run, so that the run
              itself is free to be grabbed anywhere and slid. Dragged, it
              pulls a bend out of the run; clicked, it puts one in. */}
          {runs.map(({ a, b, kind }, k) => {
            const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (length < ADD_ROOM_PX * px) return null;
            const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
            // Off the run: over a level one, right of an upright one.
            const off = ADD_OFFSET_PX * px;
            const [nx, ny] =
              kind === 'level'
                ? [0, -1]
                : kind === 'upright'
                  ? [1, 0]
                  : [(b[1] - a[1]) / length, -(b[0] - a[0]) / length];
            const [cx, cy] = [mx + nx * off, my + ny * off];
            const arm = (ADD_RADIUS_PX - 2) * px;
            return (
              <g
                key={`add-${k}`}
                data-testid={`sld-route-add-${k}`}
                role="button"
                tabIndex={-1}
                aria-label={`New bend in run ${k + 1} of ${total} of ${name}: drag it to where the line should turn, or click it to put a bend in the middle of the run.`}
                opacity={dragging ? 0 : 1}
                className="nodrag nopan"
                // It is pressed, never tabbed to: no ring is left where it was while it is dragged.
                style={{ pointerEvents: 'all', cursor: 'copy', outline: 'none' }}
                onPointerDown={(event) => begin(event, { kind: 'pull', index: k, at: [cx, cy] })}
                onPointerMove={drag}
                onPointerUp={drop}
                onPointerCancel={cancel}
                onLostPointerCapture={cancel}
              >
                <title>
                  Drag to pull a new bend out of this run, or click to put one in its middle.
                </title>
                {/* What ties it to its run; a press on the run is the run's. */}
                <path
                  d={`M${mx},${my} L${cx},${cy}`}
                  stroke="var(--color-primary)"
                  strokeWidth={1 * px}
                  style={{ pointerEvents: 'none' }}
                />
                <circle
                  cx={cx}
                  cy={cy}
                  r={ADD_RADIUS_PX * px}
                  fill="var(--color-background)"
                  stroke="var(--color-primary)"
                  strokeWidth={1.25 * px}
                />
                <path
                  d={`M${cx - arm},${cy} L${cx + arm},${cy} M${cx},${cy - arm} L${cx},${cy + arm}`}
                  stroke="var(--color-primary)"
                  strokeWidth={1.25 * px}
                />
              </g>
            );
          })}
          {/* The bends. */}
          {working.slice(1, -1).map(([x, y], i) => {
            const bend = i + 1;
            return (
              <rect
                key={`bend-${bend}`}
                ref={holdRef({ kind: 'bend', index: bend })}
                data-testid={`sld-route-bend-${bend}`}
                data-picked={pickedBend === bend ? 'true' : undefined}
                role="button"
                tabIndex={0}
                aria-label={`Bend ${bend} of ${working.length - 2} of ${name}: drag it to move it (hold Alt or Shift to move it alone), or the arrow keys. Delete removes it.`}
                x={x - half}
                y={y - half}
                width={2 * half}
                height={2 * half}
                rx={1.5 * px}
                opacity={dragging ? 0 : 1}
                fill={pickedBend === bend ? 'var(--color-primary)' : 'var(--color-background)'}
                stroke="var(--color-primary)"
                strokeWidth={1.5 * px}
                className="nodrag nopan focus:outline-none focus-visible:[stroke:var(--color-ring)]"
                style={{ pointerEvents: 'all', cursor: 'move' }}
                onPointerDown={(event) => begin(event, { kind: 'bend', index: bend })}
                onPointerMove={drag}
                onPointerUp={drop}
                onPointerCancel={cancel}
                onLostPointerCapture={cancel}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  remove(bend);
                }}
                onFocus={() => setPicked({ kind: 'bend', index: bend })}
                onKeyDown={(event) => onKeyDown(event, { kind: 'bend', index: bend })}
              >
                <title>
                  Drag to move this bend (hold Alt or Shift to move it alone). Double-click to
                  remove it.
                </title>
              </rect>
            );
          })}
          {/* The two ends, which stay attached. */}
          {[drawnPoints[0], drawnPoints[drawnPoints.length - 1]].map((end, i) =>
            end === undefined ? null : (
              <circle
                key={`end-${i}`}
                cx={end[0]}
                cy={end[1]}
                r={3.5 * px}
                fill="var(--color-primary)"
              />
            ),
          )}
        </g>
      </svg>
      {barSlot === null
        ? null
        : createPortal(
            <div
              role="toolbar"
              aria-label={`Route of ${name}`}
              data-testid="sld-route-bar"
              className="flex min-w-0 flex-col text-xs"
            >
              <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                <span
                  className="text-foreground truncate font-semibold"
                  data-testid="sld-route-name"
                  title={capital(name)}
                >
                  {capital(name)}
                </span>
                <span
                  data-testid="sld-route-status"
                  className={cn(
                    'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium',
                    manual ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
                  )}
                  title={
                    manual
                      ? 'You drew this route. Tidy diagram leaves it as it is, and it follows its ends when they are moved.'
                      : 'The diagram made this route. Moving a part of it makes it yours: a tidy then leaves it alone.'
                  }
                >
                  {manual ? 'Routed by hand' : 'Routed automatically'}
                </span>
                <BarButton
                  testId="sld-route-add-bend"
                  title="Puts a bend into the run that is picked (the longest run when none is), where it can then be made into a step."
                  onClick={() => split(pickedRun ?? longestRun)}
                >
                  Add bend
                </BarButton>
                {/* Shown while there is something for them to act on, so
                    that neither is ever there and greyed out. */}
                {pickedBend !== null ? (
                  <BarButton
                    testId="sld-route-remove-bend"
                    title="Takes the picked bend out: the line runs straight between the two beside it."
                    onClick={() => remove(pickedBend)}
                  >
                    Remove bend
                  </BarButton>
                ) : null}
                {manual ? (
                  <BarButton
                    testId="sld-route-reset"
                    title="Gives this line back to the automatic routing. Undo brings your route back."
                    onClick={onReset}
                  >
                    Reset route
                  </BarButton>
                ) : null}
                <BarButton
                  testId="sld-route-done"
                  title="Lets go of the line (Esc, or a click on the background)."
                  onClick={onDone}
                >
                  Done
                </BarButton>
              </div>
              {/* One line of the bar, whatever the note says. The hint is
                  cut to it (its tooltip has the rest). What is said about a
                  move is not: it goes on under the line, over the top edge
                  of the diagram, where it takes no click. */}
              <div className="relative" style={{ height: NOTE_LINE_PX }}>
                <p
                  ref={noteRef}
                  role="status"
                  aria-live="polite"
                  data-testid="sld-route-note"
                  data-tone={note?.tone ?? 'hint'}
                  data-wraps={noteWraps ? 'true' : undefined}
                  title={note?.text ?? ROUTE_EDIT_HELP}
                  className={cn(
                    'absolute inset-x-0 top-0 z-10 text-[11px] leading-[14px]',
                    note === null
                      ? 'text-muted-foreground truncate'
                      : cn(
                          'bg-background pointer-events-none',
                          note.tone === 'refused' ? 'text-danger font-medium' : 'text-foreground',
                        ),
                    noteWraps &&
                      'border-border -mx-1 rounded-b border-x border-b px-1 pb-0.5 shadow-md',
                  )}
                >
                  {note?.text ?? ROUTE_EDIT_HINT}
                </p>
              </div>
            </div>,
            barSlot,
          )}
    </>
  );
}

/** A button of the bar: small enough for the bar to be no higher than the line it takes the place of. */
function BarButton({
  testId,
  title,
  onClick,
  children,
}: {
  testId: string;
  title: string;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      title={title}
      onClick={onClick}
      className={cn(
        'border-border bg-background text-foreground hover:bg-muted/60 h-[18px] shrink-0 rounded border',
        'px-1.5 text-[11px] leading-none font-medium whitespace-nowrap',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
      )}
    >
      {children}
    </button>
  );
}
