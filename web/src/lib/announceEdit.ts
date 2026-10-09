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
 *
 * It also says where the change is kept, which is two different things the
 * word "saved" runs together: a reload of the page brings it back (the tab
 * keeps the edits and replays them, `store/editJournal.ts`), and the case file
 * does not hold it until the system is saved.
 */
import { describeChanged } from '@/lib/editSteps';
import { baseName } from '@/lib/paths';
import { toast } from '@/lib/toast';
import { UNDO } from '@/lib/undoWording';
import { useCaseStore } from '@/store/case';
import { useEditJournalStore } from '@/store/editJournal';

/** How many of these toasts have gone up; the last one's id ends in it. */
let sent = 0;

const toastId = (n: number) => `value-changed-${n}`;

/**
 * What a change was written to: the `system` of the session (an element edit),
 * or the `copy` of the case that Edit mode keeps a controller's parameters in.
 */
export type EditTarget = 'system' | 'copy';

/**
 * Whether the change outlives a reload of the page, and whether a file holds it.
 * Read at the moment of the edit, from what the tab keeps and what is open.
 */
export function whereEditIsKept(target: EditTarget): string {
  const selection = useCaseStore.getState().selection;
  const file =
    selection === null || selection.blank === true || selection.primaryPath === null
      ? null
      : baseName(selection.primaryPath);
  if (!useEditJournalStore.getState().replayable) {
    // A snapshot, a bundle, a PMU or a profile was put on the system, which the
    // tab cannot replay: a reload opens the file as it is.
    return 'It is not saved: a reload of the page would lose it. Save the system (Workspace menu) to keep it.';
  }
  if (target === 'copy') {
    return 'It is kept in a copy of the case, through a reload of the page too; the file you opened is not changed. Edit > Save parameter edits as case writes the copy out.';
  }
  return file === null
    ? 'A reload of the page keeps it. The system has no file yet: Workspace > Save system as writes one.'
    : `A reload of the page keeps it, but it is not in ${file} until you save the system (Workspace menu).`;
}

export function announceEdit(
  model: string,
  idx: string,
  params: readonly string[],
  target: EditTarget = 'system',
): void {
  if (sent > 0) toast.dismiss(toastId(sent));
  sent += 1;
  toast.success(`Changed ${describeChanged({ model, idx, params: [...params] })}`, {
    id: toastId(sent),
    description: `${UNDO} takes it back. ${whereEditIsKept(target)}`,
    // Three sentences: more than the default four seconds to read.
    duration: 9000,
  });
}
