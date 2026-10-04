import { Suspense, createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { toast } from '@/lib/toast';

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

/** What a ``LazyMount`` tells the overlay inside it when that overlay failed to load. */
interface LazyMountState {
  when: boolean;
  onLoadFailed: (() => void) | undefined;
}

const LazyMountContext = createContext<LazyMountState | null>(null);

/**
 * Stands in for an overlay (a dialog, drawer or palette) whose chunk failed to
 * load. An overlay has no region of its own to put a message in, so this
 * renders nothing and toasts instead, and it does so each time the overlay is
 * asked for (each time its ``LazyMount`` gets ``when`` true), because the failed
 * result is kept for the life of the page and a second attempt must not be
 * silent. It then calls the mount's ``onLoadFailed`` so the owner can drop the
 * open flag it set.
 */
export function LazyLoadFailedQuietly(): null {
  const mount = useContext(LazyMountContext);
  const asked = mount?.when ?? true;
  const onLoadFailed = useRef(mount?.onLoadFailed);
  onLoadFailed.current = mount?.onLoadFailed;
  useEffect(() => {
    if (!asked) return;
    toast.error('Part of the app could not be loaded', {
      description: 'The page may be out of date. Reload it and try again.',
    });
    onLoadFailed.current?.();
  }, [asked]);
  return null;
}

export interface LazyMountProps {
  /** When true, the children mount. They stay mounted once they have. */
  when: boolean;
  children: ReactNode;
  /** Shown while the children's chunks load. Nothing by default (dialogs). */
  fallback?: ReactNode;
  /**
   * Called when a lazy overlay among the children could not be loaded (it has
   * said so in a toast). Pass what clears the flag that made ``when`` true:
   * nothing is on screen to close it, and a flag left set turns the next click
   * on the trigger into a no-op.
   */
  onLoadFailed?: () => void;
}

/**
 * Mount ``children`` (lazy components) the first time ``when`` is true, so
 * their chunks are not fetched before they are wanted, and keep them mounted
 * afterwards. Keeping them is what a dialog that is always mounted and shows
 * itself from a store flag did before it was split out: its close animation
 * still runs and nothing else about it changes.
 */
export function LazyMount({ when, children, fallback = null, onLoadFailed }: LazyMountProps) {
  const [wanted, setWanted] = useState(when);
  if (when && !wanted) setWanted(true);
  if (!wanted) return null;
  return (
    <LazyMountContext.Provider value={{ when, onLoadFailed }}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </LazyMountContext.Provider>
  );
}
