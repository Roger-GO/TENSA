import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { usePflowStore } from '@/store/pflow';
import { ServerError } from '@/api/client';
import { cn } from '@/lib/cn';

/**
 * RuntimeCrashModal. The one allowed non-destructive modal per R18 +
 * R8 mapping (parse error → banner / non-convergence → overlay /
 * runtime crash → modal).
 *
 * Surfaces when `pflow.error` is a `ServerError` (5xx). Locked
 * backdrop: no Esc, no overlay-click close. The user must explicitly
 * choose Reload or Copy report; both then dismiss the dialog.
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
  const open = error instanceof ServerError;

  const onReload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  const onCopy = async () => {
    if (!error) return;
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

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        className={className}
        // Lock the backdrop — the user MUST pick a recovery path.
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        data-testid="runtime-crash-modal"
      >
        <DialogHeader>
          <DialogTitle>Something went wrong on the server.</DialogTitle>
          <DialogDescription>
            The substrate worker reported an unexpected error. Reloading the page usually clears it;
            if it persists, copy the error report and file an issue.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 flex flex-col gap-2 text-sm">
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
          {showDetail && error ? (
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
        </div>

        <DialogFooter>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
