import { Fragment, memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { cn } from '@/lib/cn';
import { usePflowStore } from '@/store/pflow';
import { useUiStore } from '@/store/ui';
import { useIsPendingDependent } from '@/store/pendingDependents';
import { useRunsStore } from '@/store/runs';
import { useFrameBusOverlay } from '@/store/animation';
import { colorClassForBand, getBusOverlayState } from '../overlay';
import { SOURCE_HANDLE, TARGET_HANDLE, type Side } from '../graph';

/**
 * Shape of `data` for an IEC 60617 SLD node. Shared across BusNode +
 * the device nodes (LineNode is the rare case where a "node" is really
 * a midpoint marker; transformers / generators / loads / shunts are
 * proper devices anchored to a bus).
 *
 * `voltage` / `angle` are reserved for Unit 9 — the canvas has no PF
 * data in Unit 8 scope and these fields stay undefined here.
 */
export interface SldNodeData extends Record<string, unknown> {
  idx: string;
  name: string;
  kind: string;
  voltage?: number;
  angle?: number;
  /**
   * Unit 11 — true when this bus node is the active selection driven
   * via the SLD search popover or an inspector-row click. The flag is
   * stamped onto `node.data` by `SldCanvas.nodesWithSelection` so the
   * highlight survives a click that originated outside React Flow's
   * own selection model.
   */
  sldSelected?: boolean;
}

const SIDES: Array<{ side: Side; position: Position }> = [
  { side: 'north', position: Position.Top },
  { side: 'east', position: Position.Right },
  { side: 'south', position: Position.Bottom },
  { side: 'west', position: Position.Left },
];

/**
 * Busbar fill by voltage band. Traditional one-line busbars are drawn as
 * a solid dark bar; we keep that for normal/unsolved buses and only tint
 * the bar amber / red when a voltage limit is breached, so a violation
 * reads at a glance without making every bus a different colour.
 */
const BAR_BG_BY_BAND: Record<string, string> = {
  danger: 'bg-[var(--color-danger)]',
  warning: 'bg-[var(--color-warning)]',
  success: 'bg-foreground',
  neutral: 'bg-foreground',
};

/**
 * Bus node — drawn as a traditional one-line **busbar**: a thick
 * horizontal bar that feeders (lines, transformers, generators, loads)
 * tap onto, with the name + voltage/angle label offset below. The bar
 * itself is the electrical bus and the connection target for every
 * branch edge.
 *
 * Four cardinal Handle pairs (source + target) sit ON the bar so each
 * line can pick a unique side. Edges set `sourceHandle`/`targetHandle`
 * to one of `<side>-source` / `<side>-target` (see `graph.ts`'s
 * `SOURCE_HANDLE` / `TARGET_HANDLE`); strides fan multiple feeders out
 * along the bar so they don't stack on one point.
 *
 * Unit 9: subscribes to `pflow.lastRun` + `ui.hideLabels` and consumes
 * `getBusOverlayState` to tint the bar on a limit violation + show a
 * voltage / angle label below it when post-PF.
 */
export const BusNode = memo(function BusNode({ data, selected }: NodeProps) {
  const d = data as SldNodeData;
  const pflowResult = usePflowStore((s) => s.lastRun);
  const hideLabels = useUiStore((s) => s.hideLabels);
  const pflowOverlay = getBusOverlayState(d.idx, pflowResult, hideLabels);
  const isPendingDependent = useIsPendingDependent(d.kind, d.idx);

  // v0.2 Unit 5: streaming-overlay layer.
  //
  // When a TDS run is active (or a finished run is being scrubbed), the
  // animation slice carries this bus's per-frame band, written by the
  // single rAF loop in :func:`useSldFrameOverlay`. We layer that on top
  // of the v0.1 PF-result overlay:
  //
  // - Streaming overlay present → use its band + color, but keep the
  //   v0.1 voltage/angle labels (they show the steady-state PF reading;
  //   the streaming reading lives in the plot. Numeric SLD labels
  //   during streaming are deferred — they'd require their own slower
  //   write cadence to avoid visual noise).
  // - Streaming overlay absent → fall back to ``pflowOverlay`` exactly
  //   as v0.1 behaved.
  //
  // The selector returns a stable null reference when no run is active,
  // so the component doesn't re-render on every animation tick of an
  // OTHER bus — Zustand's default reference equality on a returned
  // ``null`` is no-op.
  const activeRunId = useRunsStore((s) => s.activeRunId);
  const frameOverlay = useFrameBusOverlay(activeRunId, d.idx);
  const effectiveBand = frameOverlay !== null ? frameOverlay.band : pflowOverlay.band;
  const effectiveColorClass =
    frameOverlay !== null ? colorClassForBand(frameOverlay.band) : pflowOverlay.color_class;

  // Unit 11 — `sldSelected` lights the same border/ring as React Flow's
  // own `selected` flag. Both go through the same Tailwind branch via
  // a `data-[selected=true]` selector so the visual stays in lockstep.
  const isSldSelected = d.sldSelected === true;
  const visuallySelected = selected || isSldSelected;
  const barBg = BAR_BG_BY_BAND[effectiveBand] ?? 'bg-foreground';
  // `effectiveColorClass` (border-success/...) is retained on the node so
  // existing band-colour assertions keep working AND assistive tooling can
  // read the band off the wrapper; it's visually inert (no border drawn).
  return (
    <div
      data-testid={`bus-node-${d.idx}`}
      data-kind="bus"
      data-idx={d.idx}
      data-band={effectiveBand}
      data-streaming={frameOverlay !== null ? 'true' : undefined}
      data-pending-dependent={isPendingDependent ? 'true' : undefined}
      data-selected={visuallySelected ? 'true' : undefined}
      className={cn(
        'group flex w-[92px] cursor-pointer flex-col items-center select-none',
        effectiveColorClass,
      )}
    >
      {/* Busbar — a thick horizontal bar. Handles sit on it (it is a
          `position: relative` box so the cardinal handles land on the bar,
          not the wider wrapper that also holds the label). */}
      <div className="relative w-full" style={{ height: 6 }}>
        {SIDES.map(({ side, position }) => (
          <Fragment key={side}>
            <Handle
              type="target"
              position={position}
              id={TARGET_HANDLE[side]}
              className="!h-0 !min-h-0 !w-0 !min-w-0 !border-0 !bg-transparent"
            />
            <Handle
              type="source"
              position={position}
              id={SOURCE_HANDLE[side]}
              className="!h-0 !min-h-0 !w-0 !min-w-0 !border-0 !bg-transparent"
            />
          </Fragment>
        ))}
        <div
          data-testid={`bus-bar-${d.idx}`}
          className={cn(
            'h-full w-full rounded-full',
            barBg,
            // Subtle depth so the bar reads as a physical busbar.
            'shadow-[0_1px_2px_rgba(0,0,0,0.18)]',
            // Selection / pending highlight as a ring around the bar.
            visuallySelected ? 'ring-2 ring-[var(--color-ring)] ring-offset-1' : '',
            isPendingDependent ? 'ring-warning/70 ring-2 ring-offset-1' : '',
            'ring-offset-background',
          )}
          // Voltage-band colour transition on the bar fill (Unit 19).
          style={{
            transition: 'background-color var(--duration-base) var(--ease-out-quart)',
          }}
        />
      </div>
      {/* Label block, offset below the bar. A faint backing keeps the text
          legible where a feeder line passes behind it. */}
      <div className="bg-background/70 mt-1 flex flex-col items-center gap-0 rounded px-1 leading-tight">
        <span className="text-foreground font-mono text-[10px] leading-tight font-medium">
          {d.name || d.idx}
        </span>
        {pflowOverlay.voltage_label !== null ? (
          <span
            data-testid={`bus-voltage-${d.idx}`}
            className="text-foreground font-mono text-[10px] leading-tight"
          >
            {pflowOverlay.voltage_label}
          </span>
        ) : null}
        {pflowOverlay.angle_label !== null ? (
          <span
            data-testid={`bus-angle-${d.idx}`}
            className="text-muted-foreground font-mono text-[9px] leading-tight"
          >
            {pflowOverlay.angle_label}
          </span>
        ) : null}
      </div>
    </div>
  );
});
