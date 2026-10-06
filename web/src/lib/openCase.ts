/**
 * Opening a case file from the workspace: the filter that says which files are
 * cases, and the hook that loads one into the session. The sidebar's saved-cases
 * list and the palette's "Open case" page both go through it, so a case opens
 * the same way (and fails the same way) from either.
 */
import { useCallback } from 'react';
import { useLoadCase } from '@/api/queries';
import { parseWorkspacePath } from '@/api/types';
import type { WorkspaceFile, WorkspacePath } from '@/api/types';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { describeError } from '@/lib/describeError';
import { toast } from '@/lib/toast';

type PrimaryFormat = 'xlsx' | 'raw' | 'json' | 'm';
const PRIMARY_FORMATS: ReadonlySet<PrimaryFormat> = new Set(['xlsx', 'raw', 'json', 'm']);

/** True for a workspace file that is a case a session can load. */
export function isPrimaryCase(file: WorkspaceFile): file is WorkspaceFile & {
  format: PrimaryFormat;
} {
  if (!PRIMARY_FORMATS.has(file.format as PrimaryFormat)) return false;
  // Sidecar layout files (`<case>.layout.json`) are not loadable; skip.
  if (file.name.endsWith('.layout.json')) return false;
  return true;
}

export interface OpenCase {
  /**
   * Load `fileName` (a workspace-relative path) as the session's case, with the
   * dynamic files `addfiles` (workspace-relative paths, default none).
   */
  openCase: (fileName: string, addfiles?: readonly string[]) => void;
  /** True while a load is in flight. */
  isPending: boolean;
}

/**
 * Click-through for a case row:
 *   1. Parse the workspace path (defensive: the substrate also validates `..`
 *      segments).
 *   2. Same-file no-op guard: skip the load when it is the case already open,
 *      so a click does not tear down the PF results, snapshots and disturbance
 *      log just to land back at the same case.
 *   3. Dispatch the load mutation and mirror the resolved selection into the
 *      case slice once it has loaded.
 *
 * A click on a file in the saved-cases list or the palette passes no addfiles, so
 * a `.raw` opens without its `.dyr`; a recent case, or files dropped together,
 * pass the dynamic files the case was opened with.
 */
export function useOpenCase(): OpenCase {
  const sessionId = useSessionStore((s) => s.sessionId);
  const caseSelection = useCaseStore((s) => s.selection);
  const setCase = useCaseStore((s) => s.setCase);
  const loadCase = useLoadCase();

  const openCase = useCallback(
    (fileName: string, addfileNames: readonly string[] = []) => {
      if (!sessionId) return;
      let primary;
      let addfiles: WorkspacePath[];
      try {
        primary = parseWorkspacePath(fileName);
        addfiles = addfileNames.map(parseWorkspacePath);
      } catch (err) {
        toast.error(`Invalid workspace path: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (
        caseSelection !== null &&
        caseSelection.primaryPath === primary &&
        caseSelection.addfiles.length === addfiles.length &&
        caseSelection.addfiles.every((path, i) => path === addfiles[i])
      ) {
        return;
      }
      // ``mutateAsync``, not ``mutate`` with callbacks: those only run while the
      // component that called it is mounted, and the palette's Open case page,
      // which calls this, is gone the moment it closes. The load goes on without
      // it, and what has to follow it (recording the case, saying why it failed)
      // must not depend on it.
      loadCase
        .mutateAsync({
          sessionId,
          request: { primary_path: primary, addfiles: addfiles.length > 0 ? addfiles : null },
        })
        .then(
          () => {
            setCase({ primaryPath: primary, addfiles });
          },
          (err: unknown) => {
            toast.error(`Load failed: ${describeError(err)}`);
          },
        );
    },
    [sessionId, caseSelection, loadCase, setCase],
  );

  return { openCase, isPending: loadCase.isPending };
}
