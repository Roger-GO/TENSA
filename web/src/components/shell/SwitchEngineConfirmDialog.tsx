import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { engineLabel } from '@/lib/engines';

/**
 * SwitchEngineConfirmDialog. Destructive-confirmation modal shown when the
 * user picks another engine in the top-bar engine picker with a case open: a
 * session belongs to one engine, so switching ends the session and closes the
 * case with it, as Change case does. Sibling of `ChangeCaseConfirmDialog`,
 * same markup and wiring, and like it the dialog says what goes besides the
 * case: the runs in History and the power flows kept for comparison. It owns
 * no logic beyond cancel / confirm; the caller (`EnginePicker`) runs the
 * switch on confirm, and says where the focus goes back to.
 */
export interface SwitchEngineConfirmDialogProps {
  /** The engine waiting on this confirm; the dialog is open while it is set. */
  engine: string | null;
  /** Whether the open case has edits that no save has written. */
  unsavedEdits: boolean;
  /** Whether a time-domain run or a sweep is under way on the session. */
  runUnderWay: boolean;
  /** Called when the dialog requests to close (Esc, overlay click, Cancel). */
  onCancel: () => void;
  /** Called when the user confirms the switch. */
  onConfirm: () => void;
  /**
   * Where the focus goes as the dialog closes. Radix would put it back on what
   * had it when the dialog opened, which is the menu item that opened it and
   * is gone by then, so the caller says (the picker's trigger).
   */
  returnFocus: () => void;
}

export function SwitchEngineConfirmDialog({
  engine,
  unsavedEdits,
  runUnderWay,
  onCancel,
  onConfirm,
  returnFocus,
}: SwitchEngineConfirmDialogProps) {
  return (
    <Dialog
      open={engine !== null}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent
        data-testid="switch-engine-confirm"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus();
        }}
      >
        <DialogTitle>Switch to {engineLabel(engine ?? '')}?</DialogTitle>
        <DialogDescription className="mt-2">
          A session belongs to one engine, so switching starts a new session. The open case will be
          closed.
          {unsavedEdits ? ' Its unsaved edits will be lost.' : ''}
          {runUnderWay ? ' The run under way will be stopped.' : ''} The runs in History and the
          power flows kept for comparison will be cleared too.
        </DialogDescription>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} data-testid="switch-engine-confirm-cancel">
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} data-testid="switch-engine-confirm-accept">
            Switch engine
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
