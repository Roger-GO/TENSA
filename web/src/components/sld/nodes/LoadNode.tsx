import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { iconForModel } from '@/icons/iec60617/manifest';
import { cn } from '@/lib/cn';
import { useIsPendingDependent } from '@/store/pendingDependents';
import type { SldNodeData } from './BusNode';
import { DevicePorts } from './DevicePorts';
import { DeviceValueLabel } from './DeviceValueLabel';

/**
 * Load node. Renders the IEC 60617 load glyph; covers PQ and ZIP load
 * models per the icon manifest. Placed south of its bus by default; the
 * stub edge leaves from the port on the face that points at the bus
 * (`DevicePorts`) and lands on a tap of the bar. After a converged PF it
 * carries its P / Q readout (`DeviceValueLabel`).
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
        'relative flex flex-col items-center gap-0.5 px-1.5 py-0.5',
        'bg-background text-foreground',
        'rounded-[var(--radius-md)] border',
        selected ? 'border-[var(--color-ring)] ring-2 ring-[var(--color-ring)]' : 'border-border',
        isPendingDependent ? 'ring-warning/60 ring-2' : '',
        'transition-colors duration-[var(--duration-fast)]',
        'cursor-pointer select-none',
      )}
    >
      <DevicePorts />
      <img
        src={iconForModel(d.kind)}
        alt=""
        aria-hidden="true"
        className="h-6 w-6 object-contain"
        draggable={false}
      />
      <span className="text-foreground font-mono text-[9px] leading-none">{d.name || d.idx}</span>
      <DeviceValueLabel kind="load" data={d} />
    </div>
  );
});
