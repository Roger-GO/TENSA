import { memo } from 'react';
import { cn } from '@/lib/cn';
import { useTooSmallZoomPercent } from './zoom';

/**
 * What the diagram offers that nothing on it shows: the drag, the arrow keys,
 * connecting by a drop on a bus, moving a line by hand, picking several at
 * once, taking a move back, and the right-click menu, and that an
 * arrangement is kept.
 */
const INTERACTION_HINT =
  'Drag a bus or device to move it, or click it and press the arrow keys. Drop a component from the Components tab on a bus to connect it there; Draw line (top left) joins two buses. Click a line or a device connector to move its route by hand; a line can also be picked by its row in the Lines table. Shift+drag a box to pick several; Ctrl+Z takes a move back. Your layout is saved with the case. Right-click a bus, line or the background for more actions.';

/**
 * What the line says while a device that hangs off a bus is selected: how
 * it is moved to another bus (the ring that does it is small, and nothing
 * else says it is there), or, with `blocked`, why it cannot be now, which
 * is why the ring is greyed out.
 */
function movableHint(name: string, blocked: string | null): string {
  const selected = `${name.charAt(0).toUpperCase()}${name.slice(1)} is selected.`;
  return blocked !== null
    ? `${selected} It cannot be moved to another bus now, which is why the ring on its bar is greyed out. ${blocked}`
    : `${selected} To move it to another bus, drag the ring where its connector meets the bar onto that bus, or click the ring and then the bus. Drag the symbol itself to move it on the diagram, or press the arrow keys.`;
}

export interface SldCanvasHintProps {
  /** The lock button of the controls is on: nothing can be dragged or selected. */
  locked: boolean;
  /**
   * The name of the selected bus or device, which the zoom button goes to;
   * `null` when none is selected, and the button zooms in where the view is.
   */
  selectedName: string | null;
  /** Show the diagram at full size, on the selected node when there is one. */
  onZoomIn: () => void;
  /**
   * Set while a line of the diagram is picked to be moved by hand: the
   * place of the usual line is left to the bar of that line
   * (`SldRouteEditor`), and this is handed the element it is drawn in.
   */
  routeBarSlot?: ((slot: HTMLDivElement | null) => void) | null;
  /**
   * The name of the selected device or draft whose connector has a ring at
   * its bar end, to drag to another bus: the line then says how. `null`
   * with none.
   */
  movable?: string | null;
  /** Why that device cannot be moved to another bus now, or `null` when it can. */
  movableBlocked?: string | null;
}

/**
 * The line above the diagram, and the button that goes with it.
 *
 * It says what can be done on the diagram (`INTERACTION_HINT`), or what stands
 * in the way of that: the lock, or a diagram too small to read. A diagram is
 * fitted to its pane when it opens, and in a short pane the fit leaves a bus a
 * few pixels long, where a drag cannot be aimed and a connector cannot be
 * followed. The line then gives the zoom and says how to get closer (to
 * full size in one press, or a step at a time with the zoom buttons of the
 * diagram and the wheel, which is how to get to a size in between), and a
 * button beside it zooms to full size in one press: on the selected bus or
 * device when there is one, which the button names, and where the view is
 * otherwise. The lock does not stop the zoom, so the button stays while the
 * lock notice is shown. While a line is picked to be moved by hand, the
 * place of the line is the bar of that line's (`routeBarSlot`): as high as
 * the two lines it takes the place of, so that the diagram does not move
 * when a line is picked. The bar comes before the notice of a diagram that
 * is too small to read: it is where a move of the line is answered, and the
 * zoom button stays beside it. The same place is the bar's that says which
 * bus to pick while something is connected by a drag (`SldWiring`). While a
 * device is selected whose connector can be taken to another bus, the line
 * says how that is done (`movable`), or why it cannot be done now
 * (`movableBlocked`).
 */
export const SldCanvasHint = memo(function SldCanvasHint({
  locked,
  selectedName,
  onZoomIn,
  routeBarSlot = null,
  movable = null,
  movableBlocked = null,
}: SldCanvasHintProps) {
  const tooSmallPercent = useTooSmallZoomPercent();
  const zoomLabel = selectedName !== null ? `Zoom to ${selectedName}` : 'Zoom to 100%';
  // Short enough for the two lines beside the longest button the row gets.
  const tooSmall = `The diagram is zoomed out to ${tooSmallPercent ?? 0}%, too small to read.`;
  const wayCloser = `Press ${zoomLabel}, zoom in by steps with the + button at the bottom left or the mouse wheel, or pick a bus, a device or a line in a table below to zoom to it.`;
  return (
    <>
      {/* Two lines at most, which is the height the buttons beside it give
          the row anyway; the title has the whole text where it is cut. */}
      {locked ? (
        <p
          role="status"
          data-testid="sld-canvas-locked"
          className="text-foreground line-clamp-2 min-w-0 flex-1 text-xs"
        >
          <span className="font-semibold">The diagram is locked.</span> Nothing can be dragged or
          selected until you press the padlock button at the bottom left of the diagram again.
        </p>
      ) : routeBarSlot !== null ? (
        <div ref={routeBarSlot} data-testid="sld-canvas-route-slot" className="min-w-0 flex-1" />
      ) : tooSmallPercent !== null ? (
        <p
          data-testid="sld-canvas-too-small"
          data-zoom-percent={tooSmallPercent}
          title={`${tooSmall} ${wayCloser}`}
          className="text-foreground line-clamp-2 min-w-0 flex-1 text-xs"
        >
          <span className="font-semibold">{tooSmall}</span> {wayCloser}
        </p>
      ) : movable !== null ? (
        <p
          data-testid="sld-canvas-hint"
          data-hint={movableBlocked !== null ? 'immovable' : 'movable'}
          title={movableHint(movable, movableBlocked)}
          className="text-foreground line-clamp-2 min-w-0 flex-1 text-xs"
        >
          {movableHint(movable, movableBlocked)}
        </p>
      ) : (
        <p
          data-testid="sld-canvas-hint"
          title={INTERACTION_HINT}
          className="text-muted-foreground line-clamp-2 min-w-0 flex-1 text-xs"
        >
          {INTERACTION_HINT}
        </p>
      )}
      {tooSmallPercent !== null ? (
        <button
          type="button"
          data-testid="sld-zoom-readable"
          onClick={onZoomIn}
          title={
            selectedName !== null
              ? `Show ${selectedName} at full size (100%)`
              : 'Show the middle of this view at full size (100%)'
          }
          className={cn(
            'max-w-[14rem] shrink-0 truncate rounded border px-2 py-0.5 text-xs font-medium',
            'border-border bg-background text-primary',
            'hover:bg-muted/40',
            'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          )}
        >
          {zoomLabel}
        </button>
      ) : null}
    </>
  );
});
