import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { usePflowStore } from '@/store/pflow';
import { ServerError } from '@/api/client';
import { cn } from '@/lib/cn';
import { ProblemDetailsErrorSurface } from '@/components/error/ProblemDetailsErrorSurface';

/**
 * RuntimeCrashModal. The one allowed non-destructive modal per R18 + R8
 * mapping (parse error → banner / non-convergence → overlay / runtime crash →
 * modal). v3.1 Unit 9: now a THIN WRAPPER around the single
 * `<ProblemDetailsErrorSurface>` primitive's `modal` variant.
 *
 * Surfaces when `pflow.error` is a `ServerError` (5xx). Locked backdrop (no
 * Esc, no overlay-click close) is the primitive's modal default. The bespoke
 * modal had NO neutral "Close" — the user MUST pick Reload or Copy report —
 * so the wrapper passes `hideModalClose` and supplies both buttons via
 * `actions`. The technical-detail disclosure rides in `extras` (the generic
 * raw-JSON disclosure is suppressed) to preserve the bespoke testids + copy.
 */

interface RuntimeCrashModalProps {
  className?: string;
}

export function RuntimeCrashModal({ className }: RuntimeCrashModalProps) {
  const error = usePflowStore((s) => s.error);
  const setError = usePflowStore((s) => s.setError);
  const [showDetail, setShowDetail] = useState(false);
  const [copied, setCopied] = useState(false);

  // Open only on a 5xx (the ServerError subclass; ProblemDetailsError
  // alone covers 4xx like 422 which we route to the convergence panel).
  if (!(error instanceof ServerError)) return null;

  const onReload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  const onCopy = async () => {
    const report = JSON.stringify(
      {
        type: error.type,
        title: error.title,
        status: error.status,
        detail: error.detail,
        instance: error.instance,
        timestamp: new Date().toISOString(),
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      },
      null,
      2,
    );
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(report);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may not be available (insecure context, jsdom). Fall
      // back to a transient log so users can copy from the console.
      console.error('Could not copy error report:', report);
      setCopied(false);
    }
  };

  const onDismiss = () => {
    // The user has acknowledged the crash by clicking Reload or Copy.
    // We clear the error from the store so the dialog closes cleanly
    // even if the page didn't actually reload (e.g., test environment).
    setError(null);
    setShowDetail(false);
  };

  const detailDisclosure = (
    <>
      <button
        type="button"
        onClick={() => setShowDetail((v) => !v)}
        aria-expanded={showDetail}
        className={cn(
          'text-muted-foreground hover:text-foreground',
          'self-start text-xs underline',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        )}
      >
        {showDetail ? 'Hide technical detail' : 'View technical detail'}
      </button>
      {showDetail ? (
        <pre
          data-testid="runtime-crash-detail"
          className={cn(
            'bg-muted text-foreground',
            'overflow-auto rounded-[var(--radius-sm)] p-2',
            'font-mono text-xs whitespace-pre-wrap',
            'max-h-48',
          )}
        >
          {JSON.stringify(error.raw, null, 2)}
        </pre>
      ) : null}
    </>
  );

  return (
    <ProblemDetailsErrorSurface
      variant="modal"
      className={className}
      testId="runtime-crash-modal"
      hideModalClose
      hideRawDisclosure
      error={{
        title: 'Something went wrong on the server.',
        detail:
          'The substrate worker reported an unexpected error. Reloading the page usually clears it; if it persists, copy the error report and file an issue.',
        recovery: null,
      }}
      extras={detailDisclosure}
      actions={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void onCopy();
            }}
            data-testid="runtime-crash-copy"
          >
            {copied ? 'Copied' : 'Copy error report'}
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              onDismiss();
              onReload();
            }}
            data-testid="runtime-crash-reload"
          >
            Reload the page
          </Button>
        </>
      }
    />
  );
}
