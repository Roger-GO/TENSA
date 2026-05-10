import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/**
 * EmptyState (Unit 13 of the v2.0 polish plan).
 *
 * Canonical empty-state surface. Used wherever a panel has no content
 * to show yet — pre-PF Results table, no-element-selected Inspector,
 * no-runs History drawer, no-snapshots Load dialog, no-disturbances
 * panel, pre-EIG/CPF/SE Analyze sub-modes, etc.
 *
 * Visual contract per ``docs/interaction-states.md``:
 *
 * - Centered fill of the parent region (``flex h-full w-full
 *   items-center justify-center``).
 * - Optional large icon above the title (``text-muted-foreground/70``).
 *   Icons are inline SVG matching the codebase house style — see
 *   ``ThemeToggle``'s ``SunGlyph`` and ``RunButton``'s ``Spinner`` for
 *   the inline-SVG ``aria-hidden="true"`` pattern.
 * - Title in foreground colour, sentence case.
 * - Description in muted-foreground colour, single sentence preferred.
 * - Optional CTA — a ``<Button>`` rendered with the project's
 *   ``primary`` variant. Clicking it fires the supplied ``onClick``.
 * - ``role="status"`` so assistive tech announces the empty state.
 *
 * Migration history: Unit 8 introduced a placeholder ``EmptyState``
 * under ``components/shell/EmptyState.tsx`` that took ``action: ReactNode``.
 * Unit 13 promotes the component to ``components/ui/EmptyState.tsx``
 * (the canonical UI surface) and tightens the action contract to
 * ``{ label, onClick }`` so every empty state surfaces a clear,
 * uniformly-styled CTA. The shell module re-exports from here so
 * existing call sites that still import from ``@/components/shell/EmptyState``
 * keep working.
 */
export interface EmptyStateAction {
  /** Button label. Sentence case, short. */
  label: string;
  /** Click handler. */
  onClick: () => void;
}

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'action'> {
  /** Optional icon node. Sized by the caller — typical 24-40 px. */
  icon?: ReactNode;
  /** Headline. Short. Sentence case. */
  title: string;
  /** Supporting text under the title. Single sentence preferred. */
  description?: string;
  /** Optional CTA — typed ``{ label, onClick }``. */
  action?: EmptyStateAction;
  /** Class merged onto the root container. */
  className?: string;
  /**
   * Optional scoping key for tests + targeted queries. Surfaced as
   * ``data-empty-state-key="..."`` on the root so e.g. an inspector
   * test can scope ``screen.getByTestId('empty-state')`` when several
   * empty states might share the page.
   */
  emptyStateKey?: string;
}

export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { icon, title, description, action, className, emptyStateKey, children, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      role="status"
      data-testid="empty-state"
      data-empty-state-key={emptyStateKey}
      className={cn(
        'flex h-full w-full flex-col items-center justify-center gap-3.5',
        'p-6 text-center',
        'text-muted-foreground',
        className,
      )}
      {...props}
    >
      {icon ? (
        <div aria-hidden="true" className="text-muted-foreground/60 mb-0.5">
          {icon}
        </div>
      ) : null}
      <p className="text-foreground text-[15px] font-semibold tracking-tight">{title}</p>
      {description ? (
        <p className="text-muted-foreground max-w-xs text-[13px] leading-relaxed">{description}</p>
      ) : null}
      {action ? (
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={action.onClick}
          data-testid="empty-state-action"
          className="mt-1"
        >
          {action.label}
        </Button>
      ) : null}
      {children}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Inline SVG icons matching the codebase house style (ThemeToggle's
// SunGlyph, RunButton's Spinner). Stroke uses ``currentColor`` so the
// icon inherits ``text-muted-foreground/70`` from the parent wrapper.
// ---------------------------------------------------------------------------

interface GlyphProps {
  className?: string;
}

/** Folder icon — case picker / file empty states. */
export function FolderIcon({ className }: GlyphProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-10 w-10', className)}
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

/** Inbox icon — generic "nothing here yet". */
export function InboxIcon({ className }: GlyphProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-10 w-10', className)}
    >
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

/** Chart-line icon — pre-PF results / pre-EIG / pre-CPF / pre-SE. */
export function ChartLineIcon({ className }: GlyphProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-10 w-10', className)}
    >
      <path d="M3 3v18h18" />
      <path d="m7 14 4-4 4 4 5-6" />
    </svg>
  );
}

/** Cursor / pointer icon — "no element selected". */
export function CursorIcon({ className }: GlyphProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-10 w-10', className)}
    >
      <path d="m3 3 7 19 2-8 8-2z" />
    </svg>
  );
}

/** Bolt icon — disturbances. */
export function BoltIcon({ className }: GlyphProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-10 w-10', className)}
    >
      <path d="M13 2 3 14h7l-1 8 10-12h-7z" />
    </svg>
  );
}

/** History/clock icon — runs history. */
export function HistoryIcon({ className }: GlyphProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-10 w-10', className)}
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}

/** Snapshot/save icon — snapshot empty states. */
export function SnapshotIcon({ className }: GlyphProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-10 w-10', className)}
    >
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M17 21v-8H7v8" />
      <path d="M7 3v5h8" />
    </svg>
  );
}
