import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { DisturbanceSpec } from '@/api/types';
import { blankFaultSpec, blankToggleSpec } from '@/store/disturbance';
import { useSessionStore } from '@/store/session';
import { allowedSpecKinds, engineDisturbanceKinds } from '@/lib/engines';
import { useDepsChanged } from '@/lib/useDepsChanged';
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
  /**
   * Add-mode prefill (e.g., the currently-selected element's idx). Unlike
   * ``initialSpec`` this does NOT switch the dialog to edit mode — the
   * kind picker stays visible and the title remains "Add disturbance".
   * Callers must keep the reference stable (memoize) while the dialog is
   * open, or the draft resets on every parent render.
   */
  seedSpec?: DisturbanceSpec | null;
  /** Save handler — receives the validated, possibly-edited spec. */
  onSave: (spec: DisturbanceSpec) => void;
}

/** The sentence that lists what the dialog can add, from the allowed kinds. */
function descriptionOf(kinds: readonly string[] | null): string {
  const allowed = allowedSpecKinds(kinds);
  if (kinds === null) return 'Fault, line trip (toggle), or scheduled parameter change (alter).';
  const fragments: string[] = [];
  if (allowed.has('fault')) fragments.push('fault on a bus');
  if (allowed.has('toggle')) {
    const branch = kinds.includes('branch_trip');
    const gen = kinds.includes('gen_trip');
    fragments.push(
      branch && gen ? 'line trip or generator trip' : branch ? 'line trip' : 'generator trip',
    );
  }
  if (allowed.has('alter')) fragments.push('scheduled parameter change (alter)');
  if (fragments.length === 0) return 'No disturbance kind is available with this engine.';
  const first = fragments[0]!;
  const head = first.charAt(0).toUpperCase() + first.slice(1);
  const rest = fragments.slice(1);
  if (rest.length === 0) return `${head}.`;
  return `${head}, ${rest.slice(0, -1).join(', ')}${rest.length > 1 ? ',' : ''} or ${rest.at(-1)}.`;
}

/** The blank spec the dialog opens with: a fault when allowed, else the first allowed kind. */
function blankSpecOf(kinds: readonly string[] | null): DisturbanceSpec {
  const allowed = allowedSpecKinds(kinds);
  if (allowed.has('fault')) return blankFaultSpec();
  return blankToggleSpec();
}

export function AddEventDialog({
  open,
  onOpenChange,
  initialSpec,
  seedSpec,
  onSave,
}: AddEventDialogProps) {
  const isEdit = initialSpec !== null && initialSpec !== undefined;
  const engine = useSessionStore((s) => s.engine);
  const engines = useSessionStore((s) => s.engines);
  const disturbanceKinds = engineDisturbanceKinds(engines, engine);
  // Local draft owned by the dialog; reset each time the dialog opens so
  // closing+reopening doesn't carry the previous draft over.
  const [draft, setDraft] = useState<DisturbanceSpec>(
    () => initialSpec ?? seedSpec ?? blankSpecOf(disturbanceKinds),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Reset while rendering, so the first frame of an opening holds its own draft.
  if (useDepsChanged([open, initialSpec, seedSpec, disturbanceKinds]) && open) {
    setDraft(initialSpec ?? seedSpec ?? blankSpecOf(disturbanceKinds));
    setErrors({});
  }

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
        <DialogDescription className="mt-1">{descriptionOf(disturbanceKinds)}</DialogDescription>
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
