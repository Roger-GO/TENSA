import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { iconForModel } from '@/icons/iec60617/manifest';
import { cn } from '@/lib/cn';
import { usePflowStore } from '@/store/pflow';
import { useUiStore } from '@/store/ui';
import { useIsPendingDependent } from '@/store/pendingDependents';
import { getLineOverlayState } from '../overlay';
import type { SldNodeData } from './BusNode';

/**
 * Line node. Used in the rare case the SLD wants to render a Line as
 * an inline midpoint device (e.g., to attach a per-line label) rather
 * than as a pure edge between two buses. Default Unit 8 rendering puts
 * the line on the edge layer (`TopologyEdge`), so this component is
 * mainly here for completeness + future-compat with the inspector
 * cross-pane click flow.
 */
export const LineNode = memo(function LineNode({ data, selected }: NodeProps) {
  const d = data as SldNodeData;
  const pflowResult = usePflowStore((s) => s.lastRun);
  const hideLabels = useUiStore((s) => s.hideLabels);
  const overlay = getLineOverlayState(d.idx, pflowResult, hideLabels);
  const isPendingDependent = useIsPendingDependent(d.kind, d.idx);
  return (
    <div
      data-testid={`line-node-${d.idx}`}
      data-kind="line"
      data-idx={d.idx}
      data-direction={overlay.direction}
      data-pending-dependent={isPendingDependent ? 'true' : undefined}
      className={cn(
        'flex flex-col items-center gap-1 px-2 py-1',
        'bg-background text-foreground',
        'rounded-[var(--radius-md)] border',
        selected ? 'border-[var(--color-ring)] ring-2 ring-[var(--color-ring)]' : 'border-border',
        isPendingDependent ? 'ring-warning/60 ring-2' : '',
        'transition-colors duration-[var(--duration-fast)]',
        'cursor-pointer select-none',
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-foreground/40" />
      <Handle type="source" position={Position.Bottom} className="!bg-foreground/40" />
      <img
        src={iconForModel(d.kind)}
        alt=""
        aria-hidden="true"
        className="h-6 w-6 object-contain"
        draggable={false}
      />
      <span className="text-foreground font-mono text-[10px] leading-none">{d.name || d.idx}</span>
      {overlay.p_label !== null ? (
        <span
          data-testid={`line-flow-${d.idx}`}
          className="text-foreground font-mono text-[10px] leading-tight"
        >
          {overlay.direction === 'forward' ? '→' : overlay.direction === 'reverse' ? '←' : ''}{' '}
          {overlay.p_label}
        </span>
      ) : null}
    </div>
  );
});
