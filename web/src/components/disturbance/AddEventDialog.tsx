import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { DisturbanceSpec } from '@/api/types';
import { blankFaultSpec } from '@/store/disturbance';
import { DisturbanceForm } from './DisturbanceForm';

/**
 * AddEventDialog — Radix Dialog wrapping ``DisturbanceForm`` for the
 * primary "Add disturbance" entry point AND the "edit existing" entry
 * (clicking a marker).
 *
 * Modes:
 * - ``add``: opens with a fresh blank Fault spec; Save → onSave(spec)
 *   creates a new disturbance.
 * - ``edit``: opens pre-filled from ``initialSpec``; Save → onSave(spec)
 *   replaces the existing disturbance's spec.
 *
 * Save is gated on validity — if any sub-form reports errors, the Save
 * button is disabled. Cancel and Esc close without applying the draft.
 */

export interface AddEventDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /**
   * If provided, the dialog opens in edit mode pre-filled with this spec.
   * If null, opens in add mode with a blank Fault spec.
   */
  initialSpec?: DisturbanceSpec | null;
  /** Save handler — receives the validated, possibly-edited spec. */
  onSave: (spec: DisturbanceSpec) => void;
}

export function AddEventDialog({
  open,
  onOpenChange,
  initialSpec,
  onSave,
}: AddEventDialogProps) {
  const isEdit = initialSpec !== null && initialSpec !== undefined;
  // Local draft owned by the dialog; reset each time the dialog opens so
  // closing+reopening doesn't carry the previous draft over.
  const [draft, setDraft] = useState<DisturbanceSpec>(() =>
    initialSpec ?? blankFaultSpec(),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      setDraft(initialSpec ?? blankFaultSpec());
      setErrors({});
    }
  }, [open, initialSpec]);

  const valid = Object.keys(errors).length === 0;

  const handleSave = () => {
    if (!valid) return;
    onSave(draft);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="add-event-dialog">
        <DialogTitle>{isEdit ? 'Edit disturbance' : 'Add disturbance'}</DialogTitle>
        <DialogDescription className="mt-1">
          Fault, line trip (toggle), or scheduled parameter change (alter).
        </DialogDescription>
        <div className="mt-3">
          <DisturbanceForm
            spec={draft}
            onChange={setDraft}
            onValidityChange={setErrors}
            hideKindPicker={isEdit}
          />
        </div>
        <DialogFooter className="mt-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            data-testid="add-event-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={!valid}
            data-testid="add-event-save"
          >
            {isEdit ? 'Save' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
