/**
 * Whether the open case can be saved over its own file, and if not, why.
 *
 * "Save" replaces the file the case was opened from with the system as it is now.
 * That is only done where nothing can be lost by it:
 *
 * - The case is an xlsx or json file. Those are written by ANDES itself, whole.
 *   The raw writer is TENSA's own and leaves parts of a PSS/E case out (three-winding
 *   transformers, and the controllers of the .dyr file that goes with it), and
 *   MATPOWER (.m) cannot be written at all.
 * - The case has no companion files (a .dyr, say), which a save would not carry along.
 * - No clone of the case exists. Controller parameter edits live in a copy so the
 *   file stays as it was; writing the system over the file would end that, and
 *   "Discard all parameter edits" would no longer have an original to go back to.
 * - A snapshot restore or a bundle import has not replaced the system since the
 *   case was opened. It is then not the open file plus the user's edits, and a
 *   bundle may hold another case altogether.
 *
 * Anywhere else, Save asks for a name and a format instead, as the first save of a
 * new document does. The `reason` says which of the above applies, in a sentence the
 * Save system as dialog can show.
 *
 * Disturbances a run committed to the system are not checked here: the server refuses
 * to write them over the case file (they would come back as the case's own events), and
 * the answer reaches the user as the toast of a failed save.
 */
import type { CaseSelection } from '@/store/case';

export type SaveInPlaceFormat = 'xlsx' | 'json';

export type SaveInPlaceTarget =
  | { ok: true; filename: string; format: SaveInPlaceFormat }
  | { ok: false; reason: string };

/** What the system's state means for a save, besides the case selection. */
export interface SaveInPlaceState {
  /** The per-session clone-on-write copy exists (a controller parameter was edited). */
  cloneInitialized: boolean;
  /** A snapshot restore or bundle import replaced the system (`replaced` of the edit journal). */
  replaced: boolean;
}

const FORMAT_BY_EXTENSION: Readonly<Record<string, SaveInPlaceFormat>> = {
  '.xlsx': 'xlsx',
  '.json': 'json',
};

/** The file name of a workspace path, for a sentence. */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The extension of a workspace path with its dot, as written (`''` when it has none). */
function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

export function saveInPlaceTarget(
  selection: CaseSelection | null,
  state: SaveInPlaceState,
): SaveInPlaceTarget {
  if (selection === null) return { ok: false, reason: 'No case is open.' };
  const path = selection.primaryPath;
  if (selection.blank === true || path === null) {
    return { ok: false, reason: 'This system was built here and has no file yet.' };
  }
  const name = baseName(path);
  if (state.cloneInitialized) {
    return {
      ok: false,
      reason:
        'Your controller parameter edits are held in a copy of the case, so the file you opened stays as it was. ' +
        'Use Save parameter edits as case to write them out, or save the whole system under a new name.',
    };
  }
  if (state.replaced) {
    return {
      ok: false,
      reason: `A snapshot or bundle you loaded replaced the system, so it is no longer ${name} with your edits. Save it under a new name, or reload the case from its file first.`,
    };
  }
  // The extension is matched as written: the server only takes `.xlsx` and `.json`.
  const ext = extensionOf(path);
  const format = FORMAT_BY_EXTENSION[ext];
  if (format === undefined) {
    return {
      ok: false,
      reason: `${name} is ${ext === '' ? 'a file with no extension' : `a ${ext} case`}. Save replaces only xlsx and json cases, because the other formats cannot be written back without losing parts of the case. Save it under a new name instead.`,
    };
  }
  if (selection.addfiles.length > 0) {
    const files = selection.addfiles.map((f) => baseName(f)).join(', ');
    return {
      ok: false,
      reason: `${name} comes with ${files}, which a save would not carry along. Save it under a new name instead.`,
    };
  }
  return { ok: true, filename: path, format };
}
