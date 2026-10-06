/**
 * The hooks behind saving the system to the workspace: the layout sidecar that goes
 * beside every saved case file, and Save, which writes the open case back over its
 * own file where `saveInPlaceTarget` says that is safe.
 *
 * Save system as (a dialog, a new file in a chosen format) and Save (no dialog, the
 * open file) are different commands that end the same way: the file is written, the
 * edit journal counts the edits as saved, and the layout of the diagram as it is
 * drawn is written as `<file>.layout.json`. A write over the open file also makes it
 * the base the edit journal and the server rebuild from (see `useSaveCase`).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { SAVE_CASE_MUTATION_KEY, usePutSidecar, useSaveCase } from '@/api/queries';
import { parseWorkspacePath } from '@/api/types';
import { layoutForRenumberedCopy } from '@/components/sld/sidecar';
import { diagramLayoutForSave } from '@/lib/diagramLayout';
import { extensionOf } from '@/lib/paths';
import { saveInPlaceTarget, type SaveInPlaceTarget } from '@/lib/saveInPlace';
import { toast } from '@/lib/toast';
import { useCaseStore } from '@/store/case';
import { hasEditsNotInFile, useEditJournalStore } from '@/store/editJournal';
import { useSessionStore } from '@/store/session';
import { describeError } from '@/lib/describeError';

/**
 * Returns a function that writes the layout sidecar of a case file just saved, from
 * the diagram as it is drawn at the time it is called. Not only what was dragged: a
 * case opened in its curated or automatic layout and saved under a new name would
 * otherwise come back laid out differently, since the curated layout goes by the
 * file's name and the automatic one is worked out again. The case file is on disk
 * whether or not this succeeds, so a failure is not reported. With no diagram drawn
 * there is nothing to write, and the copy the server made of the open case's layout
 * stands.
 *
 * A `.raw` file the PSS/E writer wrote keeps no idx: the system read back from it
 * has its devices and branches numbered afresh. The layout written beside one is
 * therefore cut down to what can still be matched then (`layoutForRenumberedCopy`),
 * and that is what a `.raw` name gets unless the caller says otherwise. A copy of the
 * open case's own files (Save parameter edits as case) reads back with the idx values
 * the session has, whatever its format, and passes `renumbered: false` to keep the
 * whole layout, as the server does for the copy it makes.
 */
export function useWriteLayoutSidecar(): (
  caseFilename: string,
  options?: { renumbered?: boolean },
) => void {
  const { mutate: putSidecar } = usePutSidecar();
  return useCallback(
    (caseFilename: string, options: { renumbered?: boolean } = {}) => {
      const drawn = diagramLayoutForSave();
      if (drawn === null) return;
      const renumbered = options.renumbered ?? extensionOf(caseFilename).toLowerCase() === '.raw';
      const layout = renumbered ? layoutForRenumberedCopy(drawn) : drawn;
      try {
        putSidecar({ casePath: parseWorkspacePath(caseFilename), layout });
      } catch {
        // Only a file name with traversal segments fails to parse, which the server has
        // already refused, so the case file itself was not written either.
      }
    },
    [putSidecar],
  );
}

export interface SaveOpenCase {
  /** What Save does now: write `target.filename`, or ask for a name (and why). */
  target: SaveInPlaceTarget;
  /**
   * Write the system over the open case file. Does nothing when `target` is not ok,
   * while a save is already running (started from any menu, palette or key), or (with
   * a toast saying so) when the file already holds every edit.
   */
  save: () => void;
}

export function useSaveOpenCase(): SaveOpenCase {
  const sessionId = useSessionStore((s) => s.sessionId);
  const selection = useCaseStore((s) => s.selection);
  const cloneInitialized = useCaseStore((s) => s.cloneInitialized);
  const replaced = useEditJournalStore((s) => s.replaced);
  const queryClient = useQueryClient();
  const { mutateAsync: saveCase } = useSaveCase();
  const writeSidecar = useWriteLayoutSidecar();

  const target = useMemo(
    () => saveInPlaceTarget(selection, { cloneInitialized, replaced }),
    [selection, cloneInitialized, replaced],
  );

  const save = useCallback(() => {
    if (!target.ok || sessionId === null) return;
    // The menus, the palette and the key handler each call this hook, and each has a
    // mutation of its own, so what is running is asked of the query client, at the
    // moment of the press (a render may not have caught up with a quick second one).
    if (queryClient.isMutating({ mutationKey: SAVE_CASE_MUTATION_KEY }) > 0) return;
    // A save under another name does not count: the open file is what Save writes.
    if (!hasEditsNotInFile()) {
      toast.info(
        `Nothing to save: ${target.filename} has no changes since it was opened or saved.`,
      );
      return;
    }
    // A promise, not `mutate`'s callbacks: those do not run once the component that
    // asked is gone, and the answer should reach the user whichever surface (menu,
    // palette, Ctrl/Cmd+S) it was asked from.
    saveCase({
      sessionId,
      body: { filename: target.filename, format: target.format, overwrite: true },
    }).then(
      () => {
        writeSidecar(target.filename);
        toast.success(`Saved ${target.filename}`);
      },
      (err: unknown) => {
        toast.error(`Could not save ${target.filename}`, { description: describeError(err) });
      },
    );
  }, [target, sessionId, queryClient, saveCase, writeSidecar]);

  return { target, save };
}
