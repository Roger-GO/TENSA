import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { iconForModel } from '@/icons/iec60617/manifest';
import { cn } from '@/lib/cn';
import { useIsPendingDependent } from '@/store/pendingDependents';
import type { SldNodeData } from './BusNode';

/**
 * Load node. Renders the IEC 60617 load glyph; covers PQ and ZIP load
 * models per the icon manifest. Anchored south of its parent bus; the
 * stub edge connects the north handle (id `bus-anchor`) up to the bus's
 * `south-target` handle.
 */
export const LoadNode = memo(function LoadNode({ data, selected }: NodeProps) {
  const d = data as SldNodeData;
  const isPendingDependent = useIsPendingDependent(d.kind, d.idx);
  return (
    <div
      data-testid={`load-node-${d.idx}`}
      data-kind="load"
      data-idx={d.idx}
      data-pending-dependent={isPendingDependent ? 'true' : undefined}
      className={cn(
        'flex flex-col items-center gap-0.5 px-1.5 py-0.5',
        'bg-background text-foreground',
        'rounded-[var(--radius-md)] border',
        selected ? 'border-[var(--color-ring)] ring-2 ring-[var(--color-ring)]' : 'border-border',
        isPendingDependent ? 'ring-warning/60 ring-2' : '',
        'transition-colors duration-[var(--duration-fast)]',
        'cursor-pointer select-none',
      )}
    >
      <Handle
        type="source"
        position={Position.Top}
        id="bus-anchor"
        className="!h-0 !min-h-0 !w-0 !min-w-0 !border-0 !bg-transparent"
      />
      <img
        src={iconForModel(d.kind)}
        alt=""
        aria-hidden="true"
        className="h-6 w-6 object-contain"
        draggable={false}
      />
      <span className="text-foreground font-mono text-[9px] leading-none">{d.name || d.idx}</span>
    </div>
  );
});
