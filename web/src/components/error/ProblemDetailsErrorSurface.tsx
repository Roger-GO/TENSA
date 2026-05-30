/**
 * `<ProblemDetailsErrorSurface>` (v3.1 Phase 3, Unit 7).
 *
 * The SINGLE error UI primitive used everywhere. Three variants:
 *
 * - `banner` — inline alert (the case-load parse-error surface): title +
 *   detail + a collapsible raw-JSON disclosure + dismiss + the recovery
 *   action.
 * - `modal` — the one allowed non-destructive PF-crash-style modal (mirrors
 *   `RuntimeCrashModal`): Radix dialog, locked backdrop, a single Close
 *   affordance + the recovery action.
 * - `toast` — transient; routes through `lib/toast` with the recovery as the
 *   toast `action` per the `web/AGENTS.md` toast policy. Renders nothing in
 *   the React tree — the sonner portal owns the surface.
 *
 * Every variant renders title + detail + an OPTIONAL recovery action
 * (`<RecoveryActionButton>`). `recovery == null` (or `kind === 'none'`) →
 * no CTA.
 *
 * Tokens: `bg-danger` / `text-danger` / `border-danger` (+ danger
 * foreground). NEVER `destructive` — those classes silently no-op in this
 * codebase (the destructive→danger sweep is Unit 10).
 *
 * This is additive: the existing bespoke error components are NOT migrated
 * here (Units 8/9 do that). This unit builds the primitive + tests only.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import { ProblemDetailsError } from '@/api/client';
import { parseRecoveryDescriptor, type RecoveryDescriptor } from '@/lib/recovery';
import { RecoveryActionButton } from './RecoveryActionButton';

export type ErrorSurfaceVariant = 'banner' | 'modal' | 'toast';

/**
 * A ProblemDetails-shaped error. Accepts either a live `ProblemDetailsError`
 * (preferred) or a plain object carrying the RFC-7807 fields plus any raw
 * extras (e.g. `dependents` for a delete-blocked 422, or a `recovery`
 * descriptor). Both flow through the same normaliser.
 */
export interface ProblemDetailsShape {
  title?: string;
  detail?: string | null;
  status?: number;
  recovery?: RecoveryDescriptor | null;
  /** Any raw extra fields (e.g. `dependents`) — surfaced in the disclosure. */
  [extra: string]: unknown;
}

export interface ProblemDetailsErrorSurfaceProps {
  /** The error to surface: a `ProblemDetailsError`, a plain `Error`, or a
   *  ProblemDetails-shaped object. */
  error: ProblemDetailsError | Error | ProblemDetailsShape;
  /** Which surface to render. */
  variant: ErrorSurfaceVariant;
  /** Called when the user dismisses the surface (banner dismiss / modal
   *  Close). The toast variant fires it on action / auto-dismiss. */
  onDismiss?: () => void;
  /** `retry`-kind re-run callback, threaded to `<RecoveryActionButton>`. */
  onRetry?: () => void;
  /** In-flight job id for `wait-for-*` recoveries. */
  jobId?: string;
  /** Optional className passthrough (banner / modal content). */
  className?: string;
  /** data-testid root; defaults to `problem-error-surface`. */
  testId?: string;
}

/** Normalised view of the error every variant renders from. */
interface NormalisedError {
  title: string;
  detail: string | null;
  recovery: RecoveryDescriptor | null;
  /** Pretty-printed raw body for the disclosure. */
  rawJson: string;
}

/**
 * Collapse an arbitrary error / ProblemDetails shape into the fields every
 * variant needs. Prefers the structured `title` / `detail`; pulls `recovery`
 * off a `ProblemDetailsError` getter or a raw object's `recovery` field;
 * serialises the fullest raw body available for the disclosure.
 */
function normaliseError(error: ProblemDetailsErrorSurfaceProps['error']): NormalisedError {
  if (error instanceof ProblemDetailsError) {
    return {
      title: error.title,
      detail: error.detail ?? error.message ?? null,
      recovery: error.recovery,
      rawJson: JSON.stringify(error.rawBody ?? error.raw, null, 2),
    };
  }
  if (error instanceof Error) {
    return {
      title: error.name || 'Error',
      detail: error.message || null,
      recovery: null,
      rawJson: JSON.stringify({ name: error.name, message: error.message }, null, 2),
    };
  }
  // Plain ProblemDetails-shaped object.
  const obj = error;
  return {
    title: typeof obj.title === 'string' ? obj.title : 'Error',
    detail: typeof obj.detail === 'string' ? obj.detail : null,
    recovery: parseRecoveryDescriptor(obj.recovery),
    rawJson: JSON.stringify(obj, null, 2),
  };
}

/** Whether a recovery descriptor should render a CTA at all. */
function hasCta(recovery: RecoveryDescriptor | null): boolean {
  return recovery !== null && recovery.kind !== 'none';
}

/** Shared raw-JSON disclosure (banner + modal). */
function RawDisclosure({ rawJson, testId }: { rawJson: string; testId: string }) {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setShowRaw((v) => !v)}
        aria-expanded={showRaw}
        className={cn(
          'text-muted-foreground hover:text-foreground',
          'self-start text-xs underline',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        )}
        data-testid={`${testId}-raw-toggle`}
      >
        {showRaw ? 'Hide raw error' : 'View raw error'}
      </button>
      {showRaw ? (
        <pre
          data-testid={`${testId}-raw`}
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
    </>
  );
}

/** Inline banner variant — the case-load parse-error surface. */
function BannerSurface({
  normalised,
  onDismiss,
  onRetry,
  jobId,
  className,
  testId,
}: {
  normalised: NormalisedError;
  onDismiss?: () => void;
  onRetry?: () => void;
  jobId?: string;
  className?: string;
  testId: string;
}) {
  const { title, detail, recovery, rawJson } = normalised;
  return (
    <div
      role="alert"
      data-testid={testId}
      className={cn(
        'border-danger/30 bg-danger/10 text-foreground',
        'rounded-[var(--radius-md)] border p-3',
        'flex flex-col gap-2 text-sm',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <p className="text-danger font-medium">{title}</p>
          {detail ? <p className="text-muted-foreground text-xs">{detail}</p> : null}
        </div>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss error"
            data-testid={`${testId}-dismiss`}
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
        ) : null}
      </div>

      <RawDisclosure rawJson={rawJson} testId={testId} />

      {hasCta(recovery) ? (
        <div className="self-start">
          <RecoveryActionButton recovery={recovery} onRetry={onRetry} jobId={jobId} />
        </div>
      ) : null}
    </div>
  );
}

/** Modal variant — mirrors `RuntimeCrashModal`. Locked backdrop. */
function ModalSurface({
  normalised,
  onDismiss,
  onRetry,
  jobId,
  className,
  testId,
}: {
  normalised: NormalisedError;
  onDismiss?: () => void;
  onRetry?: () => void;
  jobId?: string;
  className?: string;
  testId: string;
}) {
  const { title, detail, recovery, rawJson } = normalised;
  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        className={className}
        // Lock the backdrop — the user MUST pick a path (Close or recovery).
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        data-testid={testId}
      >
        <DialogHeader>
          <DialogTitle className="text-danger">{title}</DialogTitle>
          {detail ? <DialogDescription>{detail}</DialogDescription> : null}
        </DialogHeader>

        <div className="mt-4 flex flex-col gap-2 text-sm">
          <RawDisclosure rawJson={rawJson} testId={testId} />
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onDismiss}
            data-testid={`${testId}-close`}
          >
            Close
          </Button>
          {hasCta(recovery) ? (
            <RecoveryActionButton
              recovery={recovery}
              onRetry={onRetry}
              jobId={jobId}
              testId={`${testId}-recovery`}
            />
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Toast variant. Fires exactly once on mount via `lib/toast`, passing the
 * recovery (when present + actionable) as the `action` field per the
 * AGENTS.md toast policy: a `toast.error` carrying a recovery MUST set
 * `action`. Renders nothing in the React tree.
 *
 * The toast action button cannot host a full `<RecoveryActionButton>` (sonner
 * renders its own button), so the action's `onClick` defers to the same
 * routing the button uses by surfacing the descriptor to the caller-supplied
 * `onRetry` for `retry`, and otherwise dismissing. For non-`retry` kinds the
 * inline banner / modal variants are the right surface; the toast variant is
 * for transient confirmations where the recovery is a `retry`.
 */
function ToastSurface({
  normalised,
  onDismiss,
  onRetry,
}: {
  normalised: NormalisedError;
  onDismiss?: () => void;
  onRetry?: () => void;
}) {
  const { title, detail, recovery } = normalised;
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    const opts: Parameters<typeof toast.error>[1] = {};
    if (detail) opts.description = detail;
    if (hasCta(recovery) && recovery) {
      // Policy: a toast.error carrying a recovery MUST set `action`.
      opts.action = {
        label: recovery.label,
        onClick: () => {
          if (recovery.kind === 'retry') onRetry?.();
          onDismiss?.();
        },
      };
    }
    toast.error(title, opts);
    // Mount-once: the deps are intentionally empty — re-firing on every
    // render would spam the toast surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

export function ProblemDetailsErrorSurface({
  error,
  variant,
  onDismiss,
  onRetry,
  jobId,
  className,
  testId = 'problem-error-surface',
}: ProblemDetailsErrorSurfaceProps) {
  const normalised = normaliseError(error);

  if (variant === 'toast') {
    return <ToastSurface normalised={normalised} onDismiss={onDismiss} onRetry={onRetry} />;
  }
  if (variant === 'modal') {
    return (
      <ModalSurface
        normalised={normalised}
        onDismiss={onDismiss}
        onRetry={onRetry}
        jobId={jobId}
        className={className}
        testId={testId}
      />
    );
  }
  return (
    <BannerSurface
      normalised={normalised}
      onDismiss={onDismiss}
      onRetry={onRetry}
      jobId={jobId}
      className={className}
      testId={testId}
    />
  );
}
