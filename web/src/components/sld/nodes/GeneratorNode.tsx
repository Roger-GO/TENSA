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
 * Anchored to its parent bus via a stub edge from the south handle
 * (id `bus-anchor`); the stub's other end terminates at the bus's
 * `north-target` handle. Click to inspect.
 */
export const GeneratorNode = memo(function GeneratorNode({ data, selected }: NodeProps) {
  const d = data as SldNodeData;
  return (
    <div
      data-testid={`generator-node-${d.idx}`}
      data-kind="generator"
      data-idx={d.idx}
      className={cn(
        'flex flex-col items-center gap-0.5 px-1.5 py-0.5',
        'bg-background text-foreground',
        'rounded-[var(--radius-md)] border',
        selected ? 'border-[var(--color-ring)] ring-2 ring-[var(--color-ring)]' : 'border-border',
        'transition-colors duration-[var(--duration-fast)]',
        'cursor-pointer select-none',
      )}
    >
      <Handle
        type="source"
        position={Position.Bottom}
        id="bus-anchor"
        className="!h-0 !w-0 !min-h-0 !min-w-0 !border-0 !bg-transparent"
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
