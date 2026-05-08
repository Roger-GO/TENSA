import { Fragment, memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { iconForModel } from '@/icons/iec60617/manifest';
import { cn } from '@/lib/cn';
import { usePflowStore } from '@/store/pflow';
import { useUiStore } from '@/store/ui';
import { getBusOverlayState } from '../overlay';
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
  const overlay = getBusOverlayState(d.idx, pflowResult, hideLabels);
  return (
    <div
      data-testid={`bus-node-${d.idx}`}
      data-kind="bus"
      data-idx={d.idx}
      data-band={overlay.band}
      className={cn(
        'group flex flex-col items-center gap-0.5 px-2.5 py-1.5',
        'bg-background text-foreground',
        'rounded-[var(--radius-md)] border-2',
        selected
          ? 'border-[var(--color-ring)] ring-2 ring-[var(--color-ring)]'
          : overlay.color_class,
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
            className="!h-0 !w-0 !min-h-0 !min-w-0 !border-0 !bg-transparent"
          />
          <Handle
            type="source"
            position={position}
            id={SOURCE_HANDLE[side]}
            className="!h-0 !w-0 !min-h-0 !min-w-0 !border-0 !bg-transparent"
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
      {overlay.voltage_label !== null ? (
        <span
          data-testid={`bus-voltage-${d.idx}`}
          className="text-foreground font-mono text-[10px] leading-tight"
        >
          {overlay.voltage_label}
        </span>
      ) : null}
      {overlay.angle_label !== null ? (
        <span
          data-testid={`bus-angle-${d.idx}`}
          className="text-muted-foreground font-mono text-[9px] leading-tight"
        >
          {overlay.angle_label}
        </span>
      ) : null}
    </div>
  );
});
