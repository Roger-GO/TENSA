import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { iconForModel } from '@/icons/iec60617/manifest';
import { cn } from '@/lib/cn';
import type { SldNodeData } from './BusNode';

/**
 * Transformer node. Like LineNode, used when the SLD wants to render a
 * transformer as an explicit device with its own click target. ANDES
 * v0.1 cases generally model transformers within the Line bucket, so
 * this component is mostly a placeholder that exercises the IEC 60617
 * 2-winding glyph for future cases that emit a separate Transformer
 * kind.
 */
export const TransformerNode = memo(function TransformerNode({ data, selected }: NodeProps) {
  const d = data as SldNodeData;
  return (
    <div
      data-testid={`transformer-node-${d.idx}`}
      data-kind="transformer"
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
      <Handle type="source" position={Position.Bottom} className="!bg-foreground/40" />
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
