/**
 * What the app says wherever a run has fixed the system, in one wording.
 *
 * A run (a power flow, a time-domain run, a change in Edit mode) sets the
 * system up in ANDES, and a system that is set up takes no new element and no
 * change to the ones it has. The palette, the Inspector, the tables and the
 * diagram each refuse an edit then, and each used to say so in words of its
 * own, of which some sent the user to a button that was not on screen and
 * all said the edits "are discarded" whether any would be.
 *
 * `runLockNotice` is the sentence they share: why, the way out (Reset run,
 * which every one of these places now has beside the sentence), and what the
 * reset keeps and loses, in exact terms. The results of the run are kept: a
 * time-domain run in Run history, a power flow among the ones kept for
 * comparison. What a reset loses is only what `discardsEdits` stands for
 * (`useReloadDiscardsEdits`): the elements added, changed or deleted since a
 * case file was opened and not saved, because the reset reads the file again.
 */

/** Why nothing of the system can be edited. */
export const RUN_LOCK = 'A run has fixed the system.';

/** The way out, and what it keeps. */
export const RESET_RUN_KEEPS =
  'Reset run lets you edit again; the result stays in Analysis > Compare and in Run history.';

/** What the way out loses, said only while it would lose something. */
export const RESET_RUN_LOSES =
  'The elements you added, changed or deleted since the case was opened are not saved yet, and the reset reads the case from its file again: save the system first to keep them.';

/**
 * The sentence for a place a run has locked. `first` says what the place
 * offers besides the reset (Edit mode, for the parameters of a controller).
 */
export function runLockNotice(discardsEdits: boolean, first?: string): string {
  return [RUN_LOCK, first, RESET_RUN_KEEPS, discardsEdits ? RESET_RUN_LOSES : undefined]
    .filter((part) => part !== undefined && part !== '')
    .join(' ');
}

/** What a converged power flow says of the lock it has just put on, once. */
export const PFLOW_LOCKS_NOTE =
  'The run has fixed the system: elements cannot be added or changed until Reset run, which keeps this result.';
