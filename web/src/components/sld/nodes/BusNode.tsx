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

  return (
    <div
      data-testid={`bus-node-${d.idx}`}
      data-kind="bus"
      data-idx={d.idx}
      data-band={effectiveBand}
      data-streaming={frameOverlay !== null ? 'true' : undefined}
      data-pending-dependent={isPendingDependent ? 'true' : undefined}
      className={cn(
        'group flex flex-col items-center gap-0.5 px-2.5 py-1.5',
        'bg-background text-foreground',
        'rounded-[var(--radius-md)] border-2',
        selected
          ? 'border-[var(--color-ring)] ring-2 ring-[var(--color-ring)]'
          : effectiveColorClass,
        isPendingDependent ? 'ring-warning/60 ring-2' : '',
        'transition-colors duration-[var(--duration-fast)]',
        'cursor-pointer select-none',
      )}
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
