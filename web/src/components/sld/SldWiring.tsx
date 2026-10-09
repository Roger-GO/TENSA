/**
 * Connecting on the diagram by a drag: what is drawn over the diagram for
 * it, and the pointers and keys that go with it.
 *
 * Three things are drawn here, in the coordinates of the diagram:
 *
 * - the bus a drop would land on, marked: the bar of the bus under the
 *   pointer while a row of the palette or a draft is dragged over the
 *   diagram (`target`), and while a line is drawn or the end of a connector
 *   is dragged;
 * - the ring at the bar end of the connector of the device that is selected
 *   (`grip`). Dragged onto another bus, it moves the device there; pressed
 *   and let go, or Enter with the focus on it, it asks for the bus to be
 *   picked. The canvas hands none while a route is moved by hand, whose
 *   handles lie where the ring would;
 * - while a bus is being picked (`mode`: a line or a transformer that is
 *   drawn, a device that is moved to another bus, a draft that is given
 *   one), a place to press over the bar of every bus, and a dashed line
 *   from where the connection starts to the pointer.
 *
 * A bus is picked by a press on it and by a drag that ends on it, so a line
 * is drawn either by dragging from one bus to the other or by clicking the
 * two in turn. Every place to press is a button with a name that says what
 * a press does (`Start the line at bus 5`), which takes the keyboard focus
 * and Enter: a pointer that cannot drag, and whatever drives the page by
 * the names of its controls, connect the same way. The bar that says what
 * to do next, with Cancel, is drawn in the row above the diagram, in the
 * place of the line that says what can be done on it (`barSlot`), as the
 * bar of a line that is moved by hand is.
 *
 * Which bus a place is on is `wiring.ts`; what a connection changes is the
 * canvas's (`SldCanvas`). This is pointers, keys and drawing. It is
 * rendered as a child of `<ReactFlow>`, over the diagram and under its
 * controls, and left out of a PNG export.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useReactFlow, useStore } from '@xyflow/react';

import { ClampedText } from '@/components/ui/ClampedText';
import { cn } from '@/lib/cn';
import type { Point } from './connections';
import {
  BRANCH_NOUN,
  BUS_HIT_PX,
  busAt,
  busTitle,
  nearestOnBar,
  wiringHint,
  wiringTitle,
  type BusBar,
  type WiringMode,
} from './wiring';

/** The end of the connector of a device, which is dragged to move the device to another bus. */
export interface WiringGrip {
  nodeId: string;
  /** What the device is called. */
  name: string;
  /** Where the connector lands on the bar: where the ring is drawn. */
  at: Point;
  /** The bus it lands on. */
  bus: string;
  /** Why the device cannot be moved now, or `null` when it can. */
  blocked: string | null;
}

export interface SldWiringProps {
  mode: WiringMode | null;
  /** The bars of the buses, as they are drawn. */
  bars: readonly BusBar[];
  /** The bus under what is dragged over the diagram from outside this overlay, or `null`. */
  target: string | null;
  grip: WiringGrip | null;
  /** Where the line to the pointer starts while a device is moved: the port its connector leaves by. */
  anchor: Point | null;
  /** The ring was pressed: a bus is to be picked for its device. */
  onGrab: (nodeId: string) => void;
  /** The ring of a device that cannot be moved was pressed. */
  onBlocked: (reason: string) => void;
  /** The bus a line that is drawn starts from was picked. */
  onFrom: (bus: string) => void;
  /** A line was drawn from the bus `from` to the bus `to`. */
  onDraw: (from: string, to: string) => void;
  /** The device or draft `nodeId` was put on `bus`. */
  onMove: (nodeId: string, bus: string) => void;
  onCancel: () => void;
  /**
   * The place in the row above the diagram where the bar is drawn; `null`
   * until that row has been drawn, and the bar with it.
   */
  barSlot: HTMLElement | null;
}

/** How far the pointer goes, in pixels on screen, before a press is a drag. */
const DRAG_SLOP_PX = 4;

/** The sizes of what is drawn, in pixels on screen. */
const GRIP_RADIUS_PX = 7;
const OUTLINE_PX = 5;

/** A press that is under way. */
interface Press {
  /** Where it began, on screen. */
  x: number;
  y: number;
  /** The bus that was pressed; `null` for the ring. */
  bus: string | null;
  /** The bus a line started from before this press, if one was picked already. */
  fromBefore: string | null;
  moved: boolean;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function SldWiring({
  mode,
  bars,
  target,
  grip,
  anchor,
  onGrab,
  onBlocked,
  onFrom,
  onDraw,
  onMove,
  onCancel,
  barSlot,
}: SldWiringProps) {
  const rf = useReactFlow();
  const [tx, ty, zoom] = useStore((s) => s.transform);
  /** One pixel on screen, on the diagram. */
  const px = 1 / (zoom > 0 ? zoom : 1);
  const reach = BUS_HIT_PX * px;

  // Where the pointer is on the diagram while a bus is being picked.
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  // What the bar says about the last press that picked nothing.
  const [note, setNote] = useState<string | null>(null);
  const pressRef = useRef<Press | null>(null);
  const picking = mode !== null;
  // Another thing to connect, or none: nothing of the one before carries over.
  const modeKey =
    mode === null ? '' : mode.kind === 'draw' ? `draw:${mode.model}` : `move:${mode.nodeId}`;
  useEffect(() => {
    setNote(null);
    if (modeKey === '') {
      setPointer(null);
      pressRef.current = null;
    }
  }, [modeKey]);

  const flowAt = useCallback(
    (event: { clientX: number; clientY: number }) =>
      rf.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
    [rf],
  );

  // The line to the pointer follows it wherever it is over the page: the
  // places to press only hear of it while it is over one of them.
  useEffect(() => {
    if (!picking) return;
    const follow = (event: PointerEvent) => setPointer(flowAt(event));
    window.addEventListener('pointermove', follow);
    return () => window.removeEventListener('pointermove', follow);
  }, [picking, flowAt]);

  // The bus a line that is drawn starts from, and the one the device is on:
  // neither is one to end on.
  const startBus = mode === null ? null : mode.kind === 'draw' ? mode.from : mode.bus;
  const over = pointer === null ? null : busAt(pointer, bars, reach);
  const hover = over !== null && over !== startBus ? over : null;
  const marked = picking ? hover : target;

  const noun = mode?.kind === 'draw' ? BRANCH_NOUN[mode.model] : '';
  const named = (id: string): string => {
    const bar = bars.find((b) => b.id === id);
    return bar === undefined ? `bus ${id}` : busTitle(bar);
  };

  /** A bus was picked, by a press on it or by a drag that ended on it. */
  const pick = (bus: string, fromBefore: string | null): void => {
    if (mode === null) return;
    if (mode.kind === 'draw') {
      if (fromBefore === null) {
        setNote(null);
        return;
      }
      if (bus === fromBefore) {
        setNote(`A ${noun} runs between two buses: click another bus than ${named(bus)}.`);
        return;
      }
      onDraw(fromBefore, bus);
      return;
    }
    if (bus === mode.bus) {
      setNote(`${capital(mode.name)} is on ${named(bus)} already: click another bus.`);
      return;
    }
    onMove(mode.nodeId, bus);
  };

  // ---- a press on a bus ----
  const pressBus = (event: React.PointerEvent<SVGElement>, bus: string): void => {
    if (event.button !== 0 || mode === null) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const fromBefore = mode.kind === 'draw' ? mode.from : null;
    pressRef.current = { x: event.clientX, y: event.clientY, bus, fromBefore, moved: false };
    setPointer(flowAt(event));
    // A line starts at the bus that is pressed first, whether the pointer
    // is then dragged to the other bus or let go and the other clicked.
    if (mode.kind === 'draw' && fromBefore === null) onFrom(bus);
  };
  const track = (event: React.PointerEvent<SVGElement>): void => {
    const press = pressRef.current;
    if (press === null) return;
    setPointer(flowAt(event));
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) >= DRAG_SLOP_PX) {
      press.moved = true;
    }
  };
  const releaseBus = (event: React.PointerEvent<SVGElement>): void => {
    const press = pressRef.current;
    if (press === null || press.bus === null || mode === null) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    pressRef.current = null;
    if (!press.moved) {
      pick(press.bus, press.fromBefore);
      return;
    }
    // A drag: from the bus that was pressed to the one it was let go on.
    const to = busAt(flowAt(event), bars, reach);
    if (mode.kind === 'draw') {
      const from = press.fromBefore ?? press.bus;
      if (to !== null && to !== from) onDraw(from, to);
      else if (to === null) {
        setNote(
          `Let go on a bus to end the ${noun} there. It still starts at ${named(from)}: click the bus it goes to.`,
        );
      }
      return;
    }
    if (to !== null) pick(to, null);
  };

  // ---- the ring at the end of a connector ----
  const pressGrip = (event: React.PointerEvent<SVGElement>): void => {
    if (event.button !== 0 || grip === null) return;
    event.stopPropagation();
    if (grip.blocked !== null) {
      onBlocked(grip.blocked);
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pressRef.current = {
      x: event.clientX,
      y: event.clientY,
      bus: null,
      fromBefore: null,
      moved: false,
    };
    setPointer(flowAt(event));
    onGrab(grip.nodeId);
  };
  const releaseGrip = (event: React.PointerEvent<SVGElement>): void => {
    const press = pressRef.current;
    if (press === null || press.bus !== null || grip === null) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    pressRef.current = null;
    // Pressed and let go: the bus is picked by a click on it.
    if (!press.moved) return;
    const to = busAt(flowAt(event), bars, reach);
    if (to !== null && to !== grip.bus) onMove(grip.nodeId, to);
    // Let go on no bus, or on its own: it stays where it is.
    else onCancel();
  };
  // The pointer was taken away without being let go: nothing is connected.
  const lost = (): void => {
    pressRef.current = null;
  };

  // Where the line to the pointer starts and ends.
  const fromBar = mode?.kind === 'draw' && mode.from !== null ? mode.from : null;
  const fromBox = fromBar === null ? undefined : bars.find((b) => b.id === fromBar)?.box;
  const hoverBox = hover === null ? undefined : bars.find((b) => b.id === hover)?.box;
  const bandEnd: Point | null =
    pointer === null
      ? null
      : hoverBox !== undefined
        ? nearestOnBar(hoverBox, pointer)
        : [pointer.x, pointer.y];
  const bandStart: Point | null =
    pointer === null || mode === null
      ? null
      : mode.kind === 'draw'
        ? fromBox === undefined
          ? null
          : nearestOnBar(fromBox, pointer)
        : anchor;

  const outline = OUTLINE_PX * px;
  const markedBox = marked === null ? undefined : bars.find((b) => b.id === marked)?.box;
  /** What a press on the bus `bar` does, as the name of its button. */
  const pressName = (bar: BusBar): string => {
    if (mode === null) return '';
    if (mode.kind === 'draw') {
      if (mode.from === null) return `Start the ${noun} at ${busTitle(bar)}`;
      return bar.id === mode.from
        ? `The ${noun} starts at ${busTitle(bar)}`
        : `End the ${noun} at ${busTitle(bar)}`;
    }
    if (bar.id === mode.bus) return `${capital(mode.name)} is on ${busTitle(bar)}`;
    return mode.bus === null
      ? `Connect ${mode.name} to ${busTitle(bar)}`
      : `Move ${mode.name} to ${busTitle(bar)}`;
  };

  return (
    <>
      <svg
        data-testid="sld-wiring"
        data-mode={mode?.kind}
        data-export-ignore=""
        className="pointer-events-none absolute inset-0 h-full w-full overflow-visible select-none"
        style={{ zIndex: 5 }}
      >
        <g transform={`translate(${tx},${ty}) scale(${zoom})`}>
          {/* Every bus that can be picked, while one is being picked. */}
          {picking
            ? bars.map((bar) => (
                <g key={bar.id}>
                  <rect
                    x={bar.box.left - outline}
                    y={bar.box.top - outline}
                    width={bar.box.right - bar.box.left + 2 * outline}
                    height={bar.box.bottom - bar.box.top + 2 * outline}
                    rx={outline}
                    fill="none"
                    stroke="var(--color-primary)"
                    strokeOpacity={bar.id === startBus ? 0.9 : 0.45}
                    strokeWidth={(bar.id === startBus ? 2 : 1) * px}
                    strokeDasharray={bar.id === startBus ? undefined : `${4 * px} ${3 * px}`}
                  />
                  <rect
                    data-testid={`sld-wire-bus-${bar.id}`}
                    data-bus={bar.id}
                    role="button"
                    tabIndex={0}
                    aria-label={pressName(bar)}
                    x={bar.box.left - reach}
                    y={bar.box.top - reach}
                    width={bar.box.right - bar.box.left + 2 * reach}
                    height={bar.box.bottom - bar.box.top + 2 * reach}
                    fill="transparent"
                    strokeWidth={1.5 * px}
                    className="nodrag nopan focus:outline-none focus-visible:[stroke:var(--color-ring)]"
                    style={{ pointerEvents: 'all', cursor: 'crosshair' }}
                    onPointerDown={(event) => pressBus(event, bar.id)}
                    onPointerMove={track}
                    onPointerUp={releaseBus}
                    onPointerCancel={lost}
                    onLostPointerCapture={lost}
                    // The press did what a click does: the click that follows is not the diagram's.
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      event.stopPropagation();
                      const fromBefore = mode?.kind === 'draw' ? mode.from : null;
                      if (mode?.kind === 'draw' && fromBefore === null) onFrom(bar.id);
                      else pick(bar.id, fromBefore);
                    }}
                  >
                    <title>{pressName(bar)}</title>
                  </rect>
                </g>
              ))
            : null}
          {/* The bus a drop would land on. */}
          {markedBox !== undefined ? (
            <rect
              data-testid="sld-wire-target"
              data-bus={marked}
              x={markedBox.left - outline}
              y={markedBox.top - outline}
              width={markedBox.right - markedBox.left + 2 * outline}
              height={markedBox.bottom - markedBox.top + 2 * outline}
              rx={outline}
              fill="var(--color-primary)"
              fillOpacity={0.22}
              stroke="var(--color-primary)"
              strokeWidth={2.5 * px}
            />
          ) : null}
          {/* From where the connection starts to the pointer. */}
          {bandStart !== null && bandEnd !== null ? (
            <path
              data-testid="sld-wire-band"
              d={`M${bandStart[0]},${bandStart[1]} L${bandEnd[0]},${bandEnd[1]}`}
              fill="none"
              stroke="var(--color-primary)"
              strokeWidth={2 * px}
              strokeDasharray={`${6 * px} ${4 * px}`}
              strokeLinecap="round"
            />
          ) : null}
          {/* The end of the connector of the device that is selected. */}
          {grip !== null ? (
            <g
              data-testid="sld-wire-grip"
              data-node={grip.nodeId}
              data-bus={grip.bus}
              data-blocked={grip.blocked !== null ? 'true' : undefined}
              role="button"
              tabIndex={0}
              aria-disabled={grip.blocked !== null ? true : undefined}
              aria-label={
                grip.blocked !== null
                  ? `Move ${grip.name} to another bus: not now. ${grip.blocked}`
                  : `Move ${grip.name} to another bus: drag this end of its connector onto the bus, or press Enter and then pick the bus`
              }
              className="nodrag nopan focus:outline-none focus-visible:[&>circle:first-of-type]:[stroke:var(--color-ring)]"
              style={{
                pointerEvents: 'all',
                cursor: grip.blocked !== null ? 'not-allowed' : 'grab',
              }}
              onPointerDown={pressGrip}
              onPointerMove={track}
              onPointerUp={releaseGrip}
              onPointerCancel={lost}
              onLostPointerCapture={lost}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                if (grip.blocked !== null) onBlocked(grip.blocked);
                else onGrab(grip.nodeId);
              }}
            >
              <title>
                {grip.blocked ??
                  `Drag onto another bus to move ${grip.name} there, or click and then pick the bus.`}
              </title>
              <circle
                cx={grip.at[0]}
                cy={grip.at[1]}
                r={GRIP_RADIUS_PX * px}
                fill="var(--color-background)"
                stroke={
                  grip.blocked !== null ? 'var(--color-muted-foreground)' : 'var(--color-primary)'
                }
                strokeWidth={2 * px}
              />
              <circle
                cx={grip.at[0]}
                cy={grip.at[1]}
                r={(GRIP_RADIUS_PX - 4) * px}
                fill={
                  grip.blocked !== null ? 'var(--color-muted-foreground)' : 'var(--color-primary)'
                }
              />
            </g>
          ) : null}
        </g>
      </svg>
      {mode === null || barSlot === null
        ? null
        : createPortal(
            <div
              role="toolbar"
              aria-label={wiringTitle(mode)}
              data-testid="sld-wire-bar"
              className="flex min-w-0 flex-col text-xs"
            >
              <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                <span
                  className="text-foreground truncate font-semibold"
                  data-testid="sld-wire-name"
                  title={wiringTitle(mode)}
                >
                  {wiringTitle(mode)}
                </span>
                <button
                  type="button"
                  data-testid="sld-wire-cancel"
                  title="Stops without connecting anything (Esc)."
                  onClick={onCancel}
                  className={cn(
                    'border-border bg-background text-foreground hover:bg-muted/60 h-[18px] shrink-0 rounded border',
                    'px-1.5 text-[11px] leading-none font-medium whitespace-nowrap',
                    'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                  )}
                >
                  Cancel
                </button>
              </div>
              {/* One line, with the rest of a hint that does not fit behind More. */}
              <ClampedText
                role="status"
                testId="sld-wire-note"
                attributes={{
                  'aria-live': 'polite',
                  'data-tone': note === null ? 'hint' : 'refused',
                }}
                text={note ?? wiringHint(mode, bars)}
                moreLabel="Show the whole instruction"
                rowClassName="items-center"
                className={cn(
                  'truncate text-[11px] leading-[14px]',
                  note === null ? 'text-muted-foreground' : 'text-danger font-medium',
                )}
              />
            </div>,
            barSlot,
          )}
    </>
  );
}
