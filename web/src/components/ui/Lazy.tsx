import { Suspense, useState } from 'react';
import type { ReactNode } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';

/**
 * Pieces for code that loads on demand (see ``lazyNamed`` in
 * ``@/lib/lazyNamed``): a component whose chunk has not arrived yet, a region
 * whose chunk could not be fetched, and a mount that waits for its trigger.
 */

/** Placeholder for a region (a drawer tab, the canvas) while its chunk loads. */
export function LoadingPanel() {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="lazy-loading"
      className="text-muted-foreground flex h-full min-h-16 w-full items-center justify-center p-4 text-xs"
    >
      Loading…
    </div>
  );
}

/**
 * Stands in for a region whose chunk failed to load. The usual cause is a page
 * left open across an upgrade or a server restart: the hashed file it asks for
 * is gone, and only a reload fetches the new ones.
 */
export function LazyLoadFailed() {
  return (
    <EmptyState
      title="This part of the app did not load"
      description="The page may be out of date. Reload it to continue."
      action={{ label: 'Reload page', onClick: () => window.location.reload() }}
      emptyStateKey="lazy-load-failed"
    />
  );
}

export interface LazyMountProps {
  /** When true, the children mount. They stay mounted once they have. */
  when: boolean;
  children: ReactNode;
  /** Shown while the children's chunks load. Nothing by default (dialogs). */
  fallback?: ReactNode;
}

/**
 * Mount ``children`` (lazy components) the first time ``when`` is true, so
 * their chunks are not fetched before they are wanted, and keep them mounted
 * afterwards. Keeping them is what a dialog that is always mounted and shows
 * itself from a store flag did before it was split out: its close animation
 * still runs and nothing else about it changes.
 */
export function LazyMount({ when, children, fallback = null }: LazyMountProps) {
  const [wanted, setWanted] = useState(when);
  if (when && !wanted) setWanted(true);
  return wanted ? <Suspense fallback={fallback}>{children}</Suspense> : null;
}
