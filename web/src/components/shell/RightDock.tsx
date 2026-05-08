import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { cn } from '@/lib/cn';
import { EmptyState } from './EmptyState';

/**
 * RightDock. The dockable right region from R18, vertically split between
 * the inspector (top, ~60% default) and the results table (bottom, ~40%
 * default).
 *
 * Both sub-regions accept arbitrary children. When children are omitted,
 * the dock renders an EmptyState fallback so the empty shell still reads
 * deliberately. The vertical resize handle's position is persisted to
 * localStorage via `react-resizable-panels`'s `autoSaveId`.
 *
 * The dock itself is hosted inside the AppShell's main horizontal
 * `PanelGroup`; the AppShell controls the dock's outer width and
 * collapse state. This component owns only the vertical sub-split.
 */
export interface RightDockProps extends Omit<HTMLAttributes<HTMLElement>, 'results'> {
  /** Inspector content (top region). Unit 9 supplies the populated component. */
  inspector?: ReactNode;
  /** Results table content (bottom region). Unit 9 supplies the populated component. */
  results?: ReactNode;
  /** Optional overlay banner pinned above both regions (PF non-convergence per R8). */
  overlay?: ReactNode;
}

export const RightDock = forwardRef<HTMLElement, RightDockProps>(function RightDock(
  { inspector, results, overlay, className, ...props },
  ref,
) {
  return (
    <aside
      ref={ref}
      aria-label="Inspector and results dock"
      className={cn(
        'flex h-full min-w-0 flex-1 flex-col',
        'border-border bg-background border-l',
        className,
      )}
      {...props}
    >
      {overlay ? (
        <div role="region" aria-label="Dock overlay">
          {overlay}
        </div>
      ) : null}

      <PanelGroup
        direction="vertical"
        autoSaveId="andes-app:layout:right-dock"
        className="flex min-h-0 flex-1 flex-col"
      >
        <Panel
          id="right-dock-inspector"
          order={1}
          defaultSize={60}
          minSize={20}
          maxSize={85}
          className="flex min-h-0 flex-col"
        >
          <section aria-label="Inspector" className="flex h-full min-h-0 flex-col">
            {inspector ?? (
              <EmptyState
                title="No element selected"
                description="Click an element on the diagram to inspect it."
              />
            )}
          </section>
        </Panel>

        <PanelResizeHandle
          aria-label="Resize inspector and results"
          className={cn(
            'group relative flex h-1 shrink-0 items-center justify-center',
            'bg-border hover:bg-[var(--color-ring)]',
            'transition-colors duration-[var(--duration-fast)]',
            'data-[resize-handle-state=drag]:bg-[var(--color-ring)]',
            'focus-visible:bg-[var(--color-ring)] focus-visible:outline-none',
          )}
        >
          {/* Visual grip — subtle horizontal bar that grows on hover. */}
          <span
            aria-hidden="true"
            className={cn(
              'block h-px w-6 rounded-full',
              'bg-muted-foreground/40 group-hover:bg-background',
              'transition-colors duration-[var(--duration-fast)]',
            )}
          />
        </PanelResizeHandle>

        <Panel
          id="right-dock-results"
          order={2}
          defaultSize={40}
          minSize={15}
          maxSize={80}
          className="flex min-h-0 flex-col"
        >
          <section
            aria-label="Results table"
            className="border-border flex h-full min-h-0 flex-col border-t"
          >
            {results ?? (
              <EmptyState title="No results yet" description="Run power flow to see results." />
            )}
          </section>
        </Panel>
      </PanelGroup>
    </aside>
  );
});
