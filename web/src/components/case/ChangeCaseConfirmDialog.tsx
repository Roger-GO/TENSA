import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/**
 * ChangeCaseConfirmDialog. Destructive-confirmation modal shown when the
 * user clicks "Change case" with a case currently loaded.
 *
 * Per R18, modals are reserved for destructive confirmations and the
 * runtime-crash exception. Discarding a session (closing the worker
 * subprocess + losing PF results) qualifies as destructive — hence the
 * Dialog here is the appropriate use of a modal.
 *
 * The dialog itself owns no logic beyond cancel/confirm wiring; the
 * caller (`CaseNav`) runs the DELETE+POST mutations and clears the
 * stores on confirm.
 */
export interface ChangeCaseConfirmDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Called when the dialog requests to close (Esc, overlay click, Cancel). */
  onCancel: () => void;
  /** Called when the user confirms the destructive action. */
  onConfirm: () => void;
  /** Whether confirm is in flight (DELETE + POST round-trip). */
  isConfirming?: boolean;
}

export function ChangeCaseConfirmDialog({
  open,
  onCancel,
  onConfirm,
  isConfirming = false,
}: ChangeCaseConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent>
        <DialogTitle>Change case?</DialogTitle>
        <DialogDescription className="mt-2">
          Discard current session? Loaded case + PF results will be cleared.
        </DialogDescription>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isConfirming}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={isConfirming}>
            {isConfirming ? 'Discarding…' : 'Discard & change case'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
