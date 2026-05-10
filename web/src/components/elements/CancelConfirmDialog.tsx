import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/**
 * CancelConfirmDialog. Destructive-confirmation modal shown when the
 * user clicks Cancel on an AddElementPanel with any modified field.
 *
 * Empty forms cancel silently; this dialog only appears when
 * `addPanelDirty === true`. Per R18, the modal is appropriate here
 * because the action is destructive (the in-flight form draft is
 * discarded). Confirm calls `onConfirm`, dismiss calls `onCancel` and
 * leaves the panel open with the existing draft preserved.
 */
export interface CancelConfirmDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function CancelConfirmDialog({ open, onCancel, onConfirm }: CancelConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent data-testid="add-element-cancel-confirm">
        <DialogTitle>Discard unsaved element?</DialogTitle>
        <DialogDescription className="mt-2">
          You have unsaved changes in the form. Discarding will clear the draft and close the panel.
        </DialogDescription>
        <DialogFooter className="mt-4">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Keep editing
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={onConfirm}
            data-testid="confirm-discard"
          >
            Discard
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
