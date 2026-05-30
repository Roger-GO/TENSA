import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { cn } from '@/lib/cn';
import type { ControllerSubKind } from '@/lib/controllers';
import { ControllerGlyph } from './ControllerGlyph';
import type { SldNodeData } from './BusNode';

/**
 * Controller node (v3.1 Unit 19).
 *
 * Renders a small docked badge beside the device a dynamic controller
 * references (exciter / governor / PSS / renewable / measurement / profile).
 * `graph.ts` anchors it at a fixed offset off the parent device and stamps a
 * `connectorDx/Dy` vector (controller origin → parent origin) onto the node
 * data so this component can draw an exact tether back to the device — valid
 * for any stack row, unlike a fixed CSS nub.
 *
 * The glyph is discriminated by `subKind` (an inline IEC-flavoured line
 * symbol; per-class IEC 60617 art is deferred). Click to inspect — the
 * canvas's `onNodeClick` maps a controller click back to a `'controller'`
 * `SelectedElement` carrying the sub-kind.
 *
 * Handle-free by design: controllers emit no React Flow edges (the tether is
 * drawn here), so the node needs no Handle and renders without a
 * ReactFlowProvider context.
 */

interface ControllerNodeData extends SldNodeData {
  subKind: ControllerSubKind;
  orphan?: boolean;
  connectorDx?: number;
  connectorDy?: number;
}

export const ControllerNode = memo(function ControllerNode({ data, selected }: NodeProps) {
  const d = data as ControllerNodeData;
  const dx = d.connectorDx ?? 0;
  const dy = d.connectorDy ?? 0;
  const hasTether = !d.orphan && (dx !== 0 || dy !== 0);
  return (
    <div
      data-testid={`controller-node-${d.idx}`}
      data-kind="controller"
      data-idx={d.idx}
      data-sub-kind={d.subKind}
      data-orphan={d.orphan ? 'true' : undefined}
      className="relative"
    >
      {/* Tether back to the parent device. Anchored at the badge's top-left
          (the node origin) and drawn to the parent origin; overflow-visible +
          pointer-events-none so it never blocks a click on the badge. */}
      {hasTether ? (
        <svg
          aria-hidden="true"
          className="text-border pointer-events-none absolute top-0 left-0 overflow-visible"
          width="0"
          height="0"
        >
          <line
            x1={6}
            y1={8}
            x2={dx + 12}
            y2={dy + 8}
            stroke="currentColor"
            strokeWidth={1}
            strokeDasharray="2 2"
          />
        </svg>
      ) : null}
      <div
        className={cn(
          'flex items-center gap-1 px-1.5 py-0.5',
          'bg-background text-foreground',
          'rounded-[var(--radius-sm)] border',
          selected
            ? 'border-[var(--color-ring)] ring-2 ring-[var(--color-ring)]'
            : 'border-border',
          d.orphan ? 'border-warning/70 ring-warning/40 ring-1' : '',
          'transition-colors duration-[var(--duration-fast)]',
          'cursor-pointer select-none',
        )}
        title={
          d.orphan
            ? `${d.kind} ${d.idx} — parent device not found on the diagram`
            : `${d.kind} ${d.idx}`
        }
      >
        <span className="text-muted-foreground flex items-center" aria-hidden="true">
          <ControllerGlyph subKind={d.subKind} />
        </span>
        <span className="text-foreground font-mono text-[9px] leading-none">{d.idx}</span>
        {d.orphan ? (
          <span className="text-warning text-[10px] leading-none" aria-hidden="true">
            !
          </span>
        ) : null}
      </div>
    </div>
  );
});
