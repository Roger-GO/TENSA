import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { ElementKindGlyph } from '@/components/elements/ElementKindGlyph';
import { cn } from '@/lib/cn';
import { DRAFT_NODE_SIZE, type DraftNodeData } from '../drafts';
import { DevicePorts } from './DevicePorts';

/**
 * Draft node: an element that was placed on the diagram and is not in the
 * system yet (`store/drafts.ts`).
 *
 * It is drawn as no element of the system is: a dashed, hatched box with the
 * symbol of its kind, the model and idx it has now, and a badge that says
 * whether it can be added (`Ready`) or still lacks something (`Incomplete`;
 * the title of the node and the Inspector say what). The colour follows the
 * badge, and the badge says the same in words. The box has one size for
 * every kind (`DRAFT_NODE_SIZE`), which is what it was dropped clear by.
 *
 * A draft that names its bus is connected to it like a device: by the port
 * on the face that looks at the bus (`DevicePorts`), with a dashed connector
 * (`StubEdge`).
 */
const HATCH = (token: string): string =>
  `repeating-linear-gradient(135deg, color-mix(in oklch, var(${token}) 16%, transparent) 0 3px, transparent 3px 9px)`;

export const DraftNode = memo(function DraftNode({ data, selected }: NodeProps) {
  const d = data as DraftNodeData;
  return (
    <div
      data-testid={`draft-node-${d.idx}`}
      data-kind="draft"
      data-draft-kind={d.kind}
      data-ready={d.ready ? 'true' : 'false'}
      title={`Draft ${d.name}: ${d.summary}. Not in the system yet.`}
      style={{
        width: DRAFT_NODE_SIZE.width,
        height: DRAFT_NODE_SIZE.height,
        backgroundImage: HATCH(d.ready ? '--color-success' : '--color-warning'),
      }}
      className={cn(
        'box-border flex flex-col items-center justify-center gap-1 px-1',
        'bg-background text-foreground',
        'rounded-[var(--radius-md)] border-[1.5px] border-dashed',
        d.ready ? 'border-success' : 'border-warning',
        selected ? 'ring-2 ring-[var(--color-ring)]' : '',
        'transition-colors duration-[var(--duration-fast)]',
        'cursor-pointer select-none',
      )}
    >
      <DevicePorts />
      <span className="text-muted-foreground flex h-5 items-center">
        <ElementKindGlyph kind={d.kind} className="h-5 w-5" />
      </span>
      <span className="text-foreground max-w-full truncate font-mono text-[9px] leading-tight">
        {d.caption}
      </span>
      <span
        data-testid={`draft-badge-${d.idx}`}
        className={cn(
          'rounded-[var(--radius-sm)] px-1 py-px',
          'text-[8px] leading-none font-semibold tracking-[0.06em] uppercase',
          d.ready ? 'bg-success text-success-foreground' : 'bg-warning text-warning-foreground',
        )}
      >
        {d.ready ? 'Ready' : 'Incomplete'}
      </span>
    </div>
  );
});
