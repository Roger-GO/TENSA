import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { iconForModel } from '@/icons/iec60617/manifest';
import { cn } from '@/lib/cn';
import { usePflowStore } from '@/store/pflow';
import { useUiStore } from '@/store/ui';
import { getBusOverlayState } from '../overlay';

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

/**
 * Bus node. Renders the IEC 60617 bus icon (a horizontal stroke) above
 * a small idx + name label. Bus is the connection target for every
 * branch edge; React Flow `<Handle>` exposes the connection points on
 * the top + bottom + left + right so ELK's orthogonal routing has
 * something to anchor to from any direction.
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
        'group flex flex-col items-center gap-1 px-2 py-1',
        'bg-background text-foreground',
        'rounded-[var(--radius-md)] border-2',
        selected
          ? 'border-[var(--color-ring)] ring-2 ring-[var(--color-ring)]'
          : overlay.color_class,
        'transition-colors duration-[var(--duration-fast)]',
        'cursor-pointer select-none',
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-foreground/40" />
      <Handle type="source" position={Position.Bottom} className="!bg-foreground/40" />
      <Handle type="target" position={Position.Left} id="left" className="!bg-foreground/40" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-foreground/40" />
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
