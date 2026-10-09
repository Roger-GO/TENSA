/**
 * The words Save system as has for the copy it writes.
 *
 * Save system as writes a copy and leaves the session on the case it had open,
 * where many programs move to the new file. Nothing on the diagram tells the two
 * apart, so the dialog, the notice of a save and the Project tab each say which
 * file is being edited, and these are the pieces they share.
 */
import type { CaseSelection } from '@/store/case';
import { baseName, stemOf } from '@/lib/paths';

/** The name of a system that has no case file to take one from. */
export const NAME_OF_A_NEW_SYSTEM = 'my-system';

/** The notice of a saved copy: one at a time, gone when another case is opened. */
export const SAVED_COPY_TOAST_ID = 'saved-copy';

/** The path of the case file a session has open, or `null` for none or a system built here. */
export function openCasePath(selection: CaseSelection | null): string | null {
  return selection === null || selection.blank === true ? null : selection.primaryPath;
}

/** The name the dialog opens on: the open case's, marked as the copy it will be. */
export function suggestedCopyName(selection: CaseSelection | null): string {
  const path = openCasePath(selection);
  return path === null ? NAME_OF_A_NEW_SYSTEM : `${stemOf(path)}-copy`;
}

/**
 * Which file the session edits once a copy is written, for the notice of the
 * save, whose title names the copy. One sentence: a notice with a button has a
 * narrow column for its words.
 */
export function stillEditing(openPath: string | null): string {
  return openPath === null
    ? 'The system you built is still the one open here, with no file of its own: what you change next is not in the copy unless you save again.'
    : `You are still editing ${baseName(openPath)}: what you change next goes there, not into the copy.`;
}

/** The button of that notice. The Project tab has one that names the file. */
export const OPEN_THE_COPY = 'Open the copy';
