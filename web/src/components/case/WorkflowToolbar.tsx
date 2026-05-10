import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCurrentTopology, useReloadCase, useUndoLastEdit } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { ProblemDetailsError } from '@/api/client';
import { cn } from '@/lib/cn';

/**
 * Workflow toolbar (Unit 12): "Reload" reverts to the on-disk case (or
 * the empty-blank state); "Undo last" drops the most recent add().
 *
 * Sits in the top-bar's left slot next to AddElement / Save System.
 *
 * Reload semantics:
 *   - Loaded session → reload from file (clears all edits + PF cache).
 *   - Blank session  → reset to empty (session keeps its replay buffer
 *     conceptually wiped via useReloadCase fast-path; the empty
 *     replay buffer triggers NoCaseLoaded so we only show this for
 *     loaded sessions).
 */
export interface WorkflowToolbarProps {
  className?: string;
}

export function WorkflowToolbar({ className }: WorkflowToolbarProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const selection = useCaseStore((s) => s.selection);
  const topology = useCurrentTopology();
  const reload = useReloadCase();
  const undo = useUndoLastEdit();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const noTopology = topology === null;
  const committed = topology?.state === 'committed';
  const isBlank = selection?.blank === true;

  // Reload only works for loaded cases (blank sessions need to keep
  // their replay buffer intact for Undo to be meaningful).
  const reloadDisabled = noTopology || isBlank || reload.isPending;
  const undoDisabled = noTopology || committed || undo.isPending;

  const handleReload = () => {
    if (!sessionId) return;
    setError(null);
    reload.mutate(sessionId, {
      onSuccess: () => setConfirmOpen(false),
      onError: (err) => {
        if (err instanceof ProblemDetailsError) {
          setError(err.detail ?? err.title ?? 'Reload failed');
        } else if (err instanceof Error) {
          setError(err.message);
        }
      },
    });
  };

  const handleUndo = () => {
    if (!sessionId) return;
    setError(null);
    undo.mutate(sessionId, {
      onError: (err) => {
        if (err instanceof ProblemDetailsError) {
          // 422 = nothing to undo. Surface a small inline note.
          setError(err.detail ?? err.title ?? 'Nothing to undo');
        } else if (err instanceof Error) {
          setError(err.message);
        }
      },
    });
  };

  return (
    <>
      <div className={cn('flex items-center gap-1', className)}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={undoDisabled}
          onClick={handleUndo}
          data-testid="undo-last-edit-button"
          className="text-xs"
          title="Undo the last element added or edited"
        >
          {undo.isPending ? 'Undoing…' : 'Undo'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={reloadDisabled}
          onClick={() => {
            setError(null);
            setConfirmOpen(true);
          }}
          data-testid="reload-case-button"
          className="text-xs"
          title="Reload from the on-disk case file (discards all edits)"
        >
          Reload
        </Button>
        {error ? (
          <span role="alert" data-testid="workflow-error" className="text-danger ml-2 text-[10px]">
            {error}
          </span>
        ) : null}
      </div>
      <Dialog
        open={confirmOpen}
        onOpenChange={(next) => {
          if (!next) setConfirmOpen(false);
        }}
      >
        <DialogContent>
          <DialogTitle>Reload from file?</DialogTitle>
          <DialogDescription className="mt-2">
            Reloading will re-parse the case from disk and discard every element you've added or
            edited since loading. Any PF results will be cleared. This cannot be undone.
          </DialogDescription>
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirmOpen(false)}
              disabled={reload.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={handleReload}
              disabled={reload.isPending}
              data-testid="reload-confirm"
            >
              {reload.isPending ? 'Reloading…' : 'Discard edits & reload'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
