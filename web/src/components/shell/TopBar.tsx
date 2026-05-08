import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * TopBar. Fixed-height (~44px) bar with three slots — left, center, right —
 * exposed as ReactNode props so other units can inject controls without the
 * shell needing to know about them.
 *
 * The three-prop shape was chosen over a children-with-data-slot or
 * subcomponent pattern because:
 *
 * - It keeps the public API trivially type-checked (each slot is just
 *   ReactNode).
 * - It avoids the runtime work of `React.Children.toArray` + filtering.
 * - It composes naturally with conditional rendering (`right={isLoaded ? …
 *   : null}`) without callers needing to remember a wrapper component.
 *
 * Per R18, the top bar is intentionally thin — it hosts the case label
 * (left), title or breadcrumbs (center), and run controls + view toggles
 * (right). All three slots are optional; an empty top bar still renders so
 * that the shell layout collapses predictably.
 */
export interface TopBarProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
}

export const TopBar = forwardRef<HTMLElement, TopBarProps>(function TopBar(
  { left, center, right, className, ...props },
  ref,
) {
  return (
    <header
      ref={ref}
      role="banner"
      aria-label="Application top bar"
      className={cn(
        // 44px tall, full-width strip with a hairline border below
        'flex h-11 w-full shrink-0 items-center gap-2 px-3',
        'border-border bg-background border-b',
        // ensure the focus ring of any contained interactive element
        // isn't clipped at the top
        'relative z-10',
        className,
      )}
      {...props}
    >
      <div data-slot="left" className="flex min-w-0 flex-1 items-center justify-start gap-2">
        {left}
      </div>
      <div data-slot="center" className="flex min-w-0 flex-1 items-center justify-center gap-2">
        {center}
      </div>
      <div data-slot="right" className="flex min-w-0 flex-1 items-center justify-end gap-2">
        {right}
      </div>
    </header>
  );
});
