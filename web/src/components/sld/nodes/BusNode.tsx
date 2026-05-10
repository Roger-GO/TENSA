import { Fragment, memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { iconForModel } from '@/icons/iec60617/manifest';
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
 * Bus node. Renders the IEC 60617 bus icon (a horizontal stroke) above
 * a small idx + name label. Bus is the connection target for every
 * branch edge.
 *
 * Unit 1 exposes 4 cardinal Handle pairs (source + target) so each
 * line can pick a unique cardinal corner. Edges set `sourceHandle`
 * and `targetHandle` to one of `<side>-source` / `<side>-target` (see
 * `graph.ts`'s `SOURCE_HANDLE` / `TARGET_HANDLE` maps). When an edge
 * leaves no handle pick, React Flow falls back to the first source-
 * type handle on the node, which is the v0.1 behaviour.
 *
 * Unit 9: subscribes to `pflow.lastRun` + `ui.hideLabels` and consumes
 * `getBusOverlayState` to apply a limit-violation border color + a
 * voltage / angle label below the icon when post-PF.
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
        'group flex flex-col items-center gap-0.5 px-2.5 py-1.5',
        'bg-background text-foreground',
        'rounded-[var(--radius-md)] border-2',
        visuallySelected
          ? 'border-[var(--color-ring)] ring-2 ring-[var(--color-ring)]'
          : effectiveColorClass,
        // Tailwind data-attribute hook — keeps the selection ring in
        // sync even if a parent wrapper later overwrites the inline
        // border classes. Belt-and-braces with the conditional above.
        'data-[selected=true]:border-[var(--color-ring)] data-[selected=true]:ring-2 data-[selected=true]:ring-[var(--color-ring)]',
        isPendingDependent ? 'ring-warning/60 ring-2' : '',
        'cursor-pointer select-none',
      )}
      // Unit 19 — voltage band colour transition. We layer the transition
      // on `border-color` (the visual carrier of the band) AND
      // `background-color` for theme-token swaps. The cubic-out easing
      // (`--ease-out-quart`) lands the new colour without overshoot;
      // 200ms keeps the feedback tight on 60 Hz TDS playback.
      //
      // Reduced-motion: globals.css collapses transition-duration to 0ms
      // under `@media (prefers-reduced-motion: reduce)`, so users that
      // request reduced motion get instant updates with no extra wiring.
      //
      // We use inline `style` rather than a Tailwind utility because v4
      // doesn't expose an arbitrary `transition-timing-function` shorthand
      // backed by a CSS variable; the inline style is a single line and
      // co-locates the easing with the property list.
      style={{
        transition:
          'border-color var(--duration-base) var(--ease-out-quart), ' +
          'background-color var(--duration-base) var(--ease-out-quart)',
      }}
    >
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
      <img
        src={iconForModel(d.kind)}
        alt=""
        aria-hidden="true"
        className="h-6 w-12 object-contain"
        draggable={false}
      />
      <span className="text-foreground font-mono text-[10px] leading-none">{d.name || d.idx}</span>
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
  );
});
