import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { useBlankSystem } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { ProblemDetailsError } from '@/api/client';

/**
 * NewSystemButton — workspace-picker affordance that creates a blank
 * `andes.System()` and switches the canvas to the empty-state prompt.
 *
 * Behavior:
 *
 * - With no current case: clicking fires `useBlankSystem()` directly.
 * - With a loaded case: shows a destructive-confirmation modal first
 *   (per R18 — discarding the loaded system loses PF results).
 * - On 409 from the substrate (a System is already loaded): the
 *   substrate's contract; the modal flow guards against this so the
 *   error path is rarely reached.
 */
export interface NewSystemButtonProps {
  className?: string;
}

export function NewSystemButton({ className }: NewSystemButtonProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const selection = useCaseStore((s) => s.selection);
  const setCase = useCaseStore((s) => s.setCase);
  const blank = useBlankSystem();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasLoadedCase = selection !== null;

  const fireBlank = () => {
    if (!sessionId) return;
    setError(null);
    blank.mutate(sessionId, {
      onSuccess: () => {
        setCase({ primaryPath: null, addfiles: [], blank: true });
      },
      onError: (err) => {
        if (err instanceof ProblemDetailsError && err.status === 409) {
          setError('A system is already loaded; discard it first or open a fresh tab.');
        } else if (err instanceof Error) {
          setError(err.message);
        }
      },
    });
  };

  const handleClick = () => {
    if (hasLoadedCase) {
      setConfirmOpen(true);
      return;
    }
    fireBlank();
  };

  return (
    <>
      <div className={className}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleClick}
          disabled={!sessionId || blank.isPending}
          data-testid="new-system-button"
          className="w-full"
        >
          {blank.isPending ? 'Creating…' : '+ New system'}
        </Button>
        {error ? (
          <p role="alert" data-testid="new-system-error" className="text-danger mt-1 text-[10px]">
            {error}
          </p>
        ) : null}
      </div>
      <Dialog
        open={confirmOpen}
        onOpenChange={(next) => {
          if (!next) setConfirmOpen(false);
        }}
      >
        <DialogContent>
          <DialogTitle>Discard current system?</DialogTitle>
          <DialogDescription className="mt-2">
            Starting a new blank system will discard the loaded case + any PF results. This cannot
            be undone.
          </DialogDescription>
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>
              Keep current
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => {
                setConfirmOpen(false);
                fireBlank();
              }}
              data-testid="new-system-confirm"
            >
              Discard &amp; start blank
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
