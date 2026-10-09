/**
 * Tell the user that a value they changed is in. The value shows where it was
 * typed (a cell of a table, a row of the Inspector), which a first-time user
 * does not take for an answer: nothing says that the case now holds it, or that
 * it can be taken back. The toast names the change the way Undo in the Edit menu
 * does, and points there.
 *
 * One such toast at a time: the one before is dismissed as the next goes up, so
 * a row typed across with Tab leaves the toast of its last value and not a pile.
 * Each is a toast of its own. Writing the new words into the one on screen (one
 * id for all) loses them whenever that toast is already on its way out.
 */
import { describeChanged } from '@/lib/editSteps';
import { toast } from '@/lib/toast';
import { UNDO } from '@/lib/undoWording';

/** How many of these toasts have gone up; the last one's id ends in it. */
let sent = 0;

const toastId = (n: number) => `value-changed-${n}`;

export function announceEdit(model: string, idx: string, params: readonly string[]): void {
  if (sent > 0) toast.dismiss(toastId(sent));
  sent += 1;
  toast.success(`Changed ${describeChanged({ model, idx, params: [...params] })}`, {
    id: toastId(sent),
    description: `${UNDO} takes it back.`,
  });
}
