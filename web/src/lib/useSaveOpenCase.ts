/**
 * The hooks behind saving the system to the workspace: the layout sidecar that goes
 * beside every saved case file, and Save, which writes the open case back over its
 * own file where `saveInPlaceTarget` says that is safe.
 *
 * Save system as (a dialog, a new file in a chosen format) and Save (no dialog, the
 * open file) are different commands that end the same way: the file is written, the
 * edit journal counts the edits as saved, and the positions the user dragged nodes to
 * are written as `<file>.layout.json`.
 */
import { useCallback, useMemo } from 'react';

import { ProblemDetailsError } from '@/api/client';
import { useCurrentTopology, usePutSidecar, useSaveCase } from '@/api/queries';
import { parseWorkspacePath } from '@/api/types';
import { sidecarFromDragOverrides } from '@/components/sld/sidecar';
import { saveInPlaceTarget, type SaveInPlaceTarget } from '@/lib/saveInPlace';
import { toast } from '@/lib/toast';
import { useCaseStore } from '@/store/case';
import { hasUnsavedEdits, useEditJournalStore } from '@/store/editJournal';
import { useSessionStore } from '@/store/session';

/**
 * Returns a function that writes the layout sidecar of a case file just saved, from
 * the drag positions at the time it is called, or does nothing when nothing was
 * dragged. The case file is on disk whether or not this succeeds, so a failure is not
 * reported.
 *
 * The drag positions are read when the function runs, not subscribed to: a component
 * that subscribed would re-render when the canvas prunes them, in the same tick the
 * canvas is still rendering (a setState-during-render warning under StrictMode).
 */
export function useWriteLayoutSidecar(): (caseFilename: string) => void {
  const topology = useCurrentTopology();
  const { mutate: putSidecar } = usePutSidecar();
  return useCallback(
    (caseFilename: string) => {
      const layout = sidecarFromDragOverrides(useCaseStore.getState().dragOverrides, topology);
      if (layout === null) return;
      try {
        putSidecar({ casePath: parseWorkspacePath(caseFilename), layout });
      } catch {
        // Only a file name with traversal segments fails to parse, which the server has
        // already refused, so the case file itself was not written either.
      }
    },
    [topology, putSidecar],
  );
}

export interface SaveOpenCase {
  /** What Save does now: write `target.filename`, or ask for a name (and why). */
  target: SaveInPlaceTarget;
  /**
   * Write the system over the open case file. Does nothing when `target` is not ok,
   * while a save is already running, or (with a toast saying so) when there is
   * nothing newer than the file.
   */
  save: () => void;
}

function describeError(err: unknown): string {
  if (err instanceof ProblemDetailsError) return err.detail ?? err.title ?? `HTTP ${err.status}`;
  return err instanceof Error ? err.message : 'unknown error';
}

export function useSaveOpenCase(): SaveOpenCase {
  const sessionId = useSessionStore((s) => s.sessionId);
  const selection = useCaseStore((s) => s.selection);
  const cloneInitialized = useCaseStore((s) => s.cloneInitialized);
  const replaced = useEditJournalStore((s) => s.replaced);
  const { mutateAsync: saveCase, isPending } = useSaveCase();
  const writeSidecar = useWriteLayoutSidecar();

  const target = useMemo(
    () => saveInPlaceTarget(selection, { cloneInitialized, replaced }),
    [selection, cloneInitialized, replaced],
  );

  const save = useCallback(() => {
    if (!target.ok || sessionId === null || isPending) return;
    if (!hasUnsavedEdits()) {
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
  }, [target, sessionId, isPending, saveCase, writeSidecar]);

  return { target, save };
}
