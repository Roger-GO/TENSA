import { forwardRef, useCallback, useEffect, useState } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { EmptyState } from './EmptyState';

/**
 * LeftRail. Collapsible left rail (240px expanded, 48px icon-only) that
 * hosts the case nav (Unit 7) and view-mode toggles. Per R18 the rail is
 * thin — it is a navigation surface, not a docked editor panel.
 *
 * Collapsed state is persisted to localStorage under
 * `andes-app:layout:left-rail-collapsed` so the user's preference survives
 * reloads. We read the persisted value lazily inside the initializer so
 * SSR/jsdom environments without `localStorage` still mount safely.
 *
 * For Unit 4 the rail's content is empty — Unit 7 fills the populated
 * region with the workspace file picker + case nav. When `children` is
 * omitted the rail renders an `EmptyState` so the empty layout reads
 * deliberately.
 */
const STORAGE_KEY = 'andes-app:layout:left-rail-collapsed';

function readCollapsed(): boolean {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return false;
  }
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // Safari private mode or quota errors — default to expanded.
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    // Persisting collapsed state is best-effort; ignore quota / private mode.
  }
}

export interface LeftRailProps extends HTMLAttributes<HTMLElement> {
  /** Optional: forced-collapsed override (used by viewport-too-small fallback). */
  forceCollapsed?: boolean;
  /** Populated content (case nav, view toggles). When omitted, an EmptyState is rendered. */
  children?: ReactNode;
  /** Optional content rendered in the collapsed (icon-only) state. Unit 7 supplies the icon stack. */
  collapsedContent?: ReactNode;
}

export const LeftRail = forwardRef<HTMLElement, LeftRailProps>(function LeftRail(
  { forceCollapsed, children, collapsedContent, className, ...props },
  ref,
) {
  const [userCollapsed, setUserCollapsed] = useState<boolean>(() => readCollapsed());

  useEffect(() => {
    writeCollapsed(userCollapsed);
  }, [userCollapsed]);

  const toggle = useCallback(() => {
    setUserCollapsed((c) => !c);
  }, []);

  const collapsed = forceCollapsed ?? userCollapsed;

  return (
    <aside
      ref={ref}
      aria-label="Case navigation"
      data-collapsed={collapsed ? 'true' : 'false'}
      className={cn(
        'flex h-full shrink-0 flex-col',
        'border-border bg-background border-r',
        'transition-[width] duration-[var(--duration-base)] ease-[var(--ease-out-spring)]',
        collapsed ? 'w-12' : 'w-60',
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          'border-border flex h-9 shrink-0 items-center border-b px-1',
          collapsed ? 'justify-center' : 'justify-end',
        )}
      >
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? 'Expand left rail' : 'Collapse left rail'}
          aria-expanded={!collapsed}
          aria-controls="left-rail-content"
          title={collapsed ? 'Expand left rail' : 'Collapse left rail'}
          className={cn(
            'inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)]',
            'text-muted-foreground hover:bg-muted hover:text-foreground',
            'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
            'transition-colors duration-[var(--duration-fast)]',
          )}
        >
          {/* Inline chevron — flips orientation based on collapsed state.
              Inline avoids pulling an icon dep for one glyph. */}
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn(
              'transition-transform duration-[var(--duration-fast)]',
              collapsed ? 'rotate-180' : 'rotate-0',
            )}
          >
            <path d="M10 4 L6 8 L10 12" />
          </svg>
        </button>
      </div>

      <div id="left-rail-content" className="flex min-h-0 flex-1 flex-col">
        {collapsed ? (
          // Icon-only stack. Unit 7 fills with collapsedContent; for now we
          // render a small placeholder so the collapsed rail isn't empty.
          <div className="flex flex-col items-center gap-1 p-1">{collapsedContent}</div>
        ) : children ? (
          children
        ) : (
          <EmptyState
            title="Workspace"
            description="Case files appear here once a workspace is loaded."
          />
        )}
      </div>
    </aside>
  );
});
