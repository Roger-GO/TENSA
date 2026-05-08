import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * EmptyState. Generic placeholder used by inner regions (SLD canvas,
 * inspector, results table, case nav) before they have content.
 *
 * Per the interaction-states matrix (`web/docs/interaction-states.md`),
 * empty states are centered with optional illustration + caption + optional
 * CTA. The shell's inner regions all share this affordance, so the component
 * lives in `shell/` rather than `ui/`.
 *
 * Visual treatment is restrained on purpose — empty states should read as
 * "the surface is intentionally blank and the user knows how to populate it",
 * not as a marketing splash.
 */
export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Optional small icon or illustration above the title. */
  icon?: ReactNode;
  /** Headline. Short. Sentence case. */
  title?: ReactNode;
  /** Supporting text under the title. Single sentence preferred. */
  description?: ReactNode;
  /** Optional CTA — typically a button or link. */
  action?: ReactNode;
}

export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { icon, title, description, action, className, children, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      role="status"
      className={cn(
        // centered fill of the parent region
        'flex h-full w-full flex-col items-center justify-center gap-3',
        'p-6 text-center',
        'text-muted-foreground',
        className,
      )}
      {...props}
    >
      {icon ? (
        <div aria-hidden="true" className="text-muted-foreground/70">
          {icon}
        </div>
      ) : null}
      {title ? <p className="text-foreground text-sm font-medium">{title}</p> : null}
      {description ? (
        <p className="text-muted-foreground max-w-xs text-xs leading-relaxed">{description}</p>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
      {children}
    </div>
  );
});
