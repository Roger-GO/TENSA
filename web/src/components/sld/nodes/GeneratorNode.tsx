import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { iconForModel } from '@/icons/iec60617/manifest';
import { cn } from '@/lib/cn';
import type { SldNodeData } from './BusNode';

/**
 * Generator node. Renders the IEC 60617 generator glyph (a circle with
 * a tilde or "G"); the static-vs-synchronous distinction is encoded in
 * the icon manifest (`PV`/`Slack` → `generator.svg`; `GENROU`/`GENCLS`
 * → `generator-syngen.svg`).
 *
 * Anchored to its bus via React Flow's `parentId` mechanism (set by
 * `SldCanvas` when constructing nodes). The handle on top connects up
 * to the bus.
 */
export const GeneratorNode = memo(function GeneratorNode({ data, selected }: NodeProps) {
  const d = data as SldNodeData;
  return (
    <div
      data-testid={`generator-node-${d.idx}`}
      data-kind="generator"
      data-idx={d.idx}
      className={cn(
        'flex flex-col items-center gap-1 px-2 py-1',
        'bg-background text-foreground',
        'rounded-[var(--radius-md)] border',
        selected ? 'border-[var(--color-ring)] ring-2 ring-[var(--color-ring)]' : 'border-border',
        'transition-colors duration-[var(--duration-fast)]',
        'cursor-pointer select-none',
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-foreground/40" />
      <img
        src={iconForModel(d.kind)}
        alt=""
        aria-hidden="true"
        className="h-8 w-8 object-contain"
        draggable={false}
      />
      <span className="text-foreground font-mono text-[10px] leading-none">{d.name || d.idx}</span>
    </div>
  );
});
