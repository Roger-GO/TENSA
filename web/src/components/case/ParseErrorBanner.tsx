import { useState } from 'react';
import { cn } from '@/lib/cn';
import { ProblemDetailsError } from '@/api/client';

/**
 * ParseErrorBanner. Inline banner used by `CaseNav` / `WorkspaceFilePicker`
 * to surface parse errors from `POST /sessions/{id}/case` (R8 taxonomy:
 * parse error → inline banner above the picker).
 *
 * Visual treatment matches the interaction-states matrix Case-Nav
 * "Parse error" cell: `bg-danger/10`, `border-danger/30`, `text-foreground`,
 * with a "view raw error" disclosure exposing the raw ProblemDetails JSON
 * + a dismiss control.
 *
 * Lives in `case/` rather than a generic `ui/error-banner` because the
 * surface (parse error from case load) is case-nav-specific. Unit 9 may
 * extract a shared banner if non-convergence overlay reuses the same
 * disclosure pattern.
 */
export interface ParseErrorBannerProps {
  /** The error to surface. Either a `ProblemDetailsError` (preferred) or any Error. */
  error: Error;
  /** Called when the user dismisses the banner. */
  onDismiss: () => void;
  /** Optional class override. */
  className?: string;
}

export function ParseErrorBanner({ error, onDismiss, className }: ParseErrorBannerProps) {
  const [showRaw, setShowRaw] = useState<boolean>(false);

  // Prefer the structured `detail` field for the headline message — this is
  // the substrate's parse-error message text. Fall back to `message` for
  // non-ProblemDetails errors so the banner still says something useful.
  const isProblem = error instanceof ProblemDetailsError;
  const headline = isProblem ? error.title : 'Could not load case';
  const detail = isProblem ? (error.detail ?? error.message) : error.message;
  const rawJson = isProblem ? JSON.stringify(error.raw, null, 2) : error.message;

  return (
    <div
      role="alert"
      className={cn(
        'border-danger/30 bg-danger/10 text-foreground',
        'rounded-[var(--radius-md)] border p-3',
        'flex flex-col gap-2 text-sm',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <p className="font-medium">{headline}</p>
          {detail ? <p className="text-muted-foreground text-xs">{detail}</p> : null}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss error"
          className={cn(
            'text-muted-foreground hover:text-foreground',
            'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)]',
            'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
            'transition-colors duration-[var(--duration-fast)]',
          )}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M4 4 L12 12 M12 4 L4 12" />
          </svg>
        </button>
      </div>

      <button
        type="button"
        onClick={() => setShowRaw((v) => !v)}
        className={cn(
          'text-muted-foreground hover:text-foreground',
          'self-start text-xs underline',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        )}
      >
        {showRaw ? 'Hide raw error' : 'View raw error'}
      </button>

      {showRaw ? (
        <pre
          className={cn(
            'bg-muted text-foreground',
            'overflow-auto rounded-[var(--radius-sm)] p-2',
            'font-mono text-xs whitespace-pre-wrap',
            'max-h-48',
          )}
        >
          {rawJson}
        </pre>
      ) : null}
    </div>
  );
}
