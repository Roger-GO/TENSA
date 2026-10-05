/**
 * Adding files to the workspace from the browser: what a drop on the window and
 * the "Add files" button both do.
 *
 * Each file that can be tried (`uploadProblem`) goes to `POST /workspace/files`
 * one after the other, and the user hears what became of them in toasts, not
 * dialogs: what was added, what was refused and why, and for a name that is
 * already in the workspace a toast with a Replace button, since replacing is the
 * one choice that cannot be undone. Then:
 *
 * - a single case among the added files is opened when nothing is open or loading
 *   (with the `.dyr` files that came with a `.raw`), and offered with an Open
 *   button when a case is open, since opening discards that case's results;
 * - replacing the file of the case that is open says the open case still holds
 *   the old copy, with a Reload case button.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { ProblemDetailsError } from '@/api/client';
import { useReloadCase, useUploadWorkspaceFile } from '@/api/queries';
import { planOpen, uploadProblem } from '@/lib/caseUpload';
import { useOpenCase } from '@/lib/openCase';
import { toast } from '@/lib/toast';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';

/** How long a toast that asks for a decision stays up. */
const DECISION_TOAST_MS = 15_000;

export interface AddWorkspaceFiles {
  /** Try to add `files` to the workspace and report what became of each. */
  addFiles: (files: readonly File[]) => Promise<void>;
  /** True while an `addFiles` call from this hook is running. */
  isUploading: boolean;
}

/** "a", "a and b", "a, b and c", then "a, b and 3 more". */
function listNames(names: readonly string[]): string {
  if (names.length <= 3) {
    return names.length <= 1
      ? names.join('')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

function describeError(err: unknown): string {
  if (err instanceof ProblemDetailsError) return err.detail ?? err.title ?? `HTTP ${err.status}`;
  return err instanceof Error ? err.message : String(err);
}

export function useAddWorkspaceFiles(): AddWorkspaceFiles {
  const upload = useUploadWorkspaceFile();
  const reloadCase = useReloadCase();
  const { openCase } = useOpenCase();
  const [running, setRunning] = useState(0);

  // The work below outlives the render that started it (uploads are awaited, and
  // a toast button is pressed later), so it reads these through a ref and never
  // acts on the session or the open case of a moment ago.
  const latest = useRef({ upload, reloadCase, openCase });
  useEffect(() => {
    latest.current = { upload, reloadCase, openCase };
  });

  /** Tell the user what was stored (added or replaced), and open what should be. */
  const announceStored = useCallback((names: readonly string[], verb: 'Added' | 'Replaced') => {
    const { reloadCase: reload, openCase: open } = latest.current;
    const sessionId = useSessionStore.getState().sessionId;
    const { selection, loadingPath } = useCaseStore.getState();
    const loaded: (string | null)[] =
      selection === null ? [] : [selection.primaryPath, ...selection.addfiles];
    const stale = names.filter((name) => loaded.includes(name));
    const where = verb === 'Added' ? 'to the workspace' : 'in the workspace';
    const message =
      names.length === 1
        ? `${verb} ${names[0]} ${where}.`
        : `${verb} ${names.length} files ${where}.`;
    const description = names.length === 1 ? undefined : listNames(names);

    if (stale.length > 0 && sessionId !== null) {
      toast.warning(`${verb} ${listNames(stale)}. The open case still holds the old copy.`, {
        action: { label: 'Reload case', onClick: () => reload.mutate(sessionId) },
        duration: DECISION_TOAST_MS,
      });
      return;
    }
    const plan = planOpen(names);
    if (plan === null) {
      toast.success(message, { description });
      return;
    }
    // A case that is still loading is not open yet, but a second load would race it.
    if (selection === null && loadingPath === null && sessionId !== null) {
      toast.success(message, { description });
      open(plan.primary, plan.addfiles);
      return;
    }
    toast.success(message, {
      description,
      action:
        sessionId === null
          ? undefined
          : { label: 'Open', onClick: () => open(plan.primary, plan.addfiles) },
      duration: DECISION_TOAST_MS,
    });
  }, []);

  const replaceFiles = useCallback(
    async (files: readonly File[]) => {
      const replaced: string[] = [];
      for (const file of files) {
        try {
          await latest.current.upload.mutateAsync({ file, overwrite: true });
          replaced.push(file.name);
        } catch (err) {
          toast.error(`Could not replace ${file.name}: ${describeError(err)}`);
        }
      }
      if (replaced.length > 0) announceStored(replaced, 'Replaced');
    },
    [announceStored],
  );

  const addFiles = useCallback(
    async (files: readonly File[]) => {
      const problems: string[] = [];
      const candidates: File[] = [];
      for (const file of files) {
        const problem = uploadProblem(file);
        if (problem === null) candidates.push(file);
        else problems.push(problem);
      }
      if (problems.length === 1) toast.error(problems[0] ?? '');
      else if (problems.length > 1) {
        toast.error(`${problems.length} files were not added.`, {
          description: problems.join(' '),
        });
      }

      setRunning((n) => n + 1);
      try {
        const stored: string[] = [];
        const taken: File[] = [];
        for (const file of candidates) {
          try {
            await latest.current.upload.mutateAsync({ file });
            stored.push(file.name);
          } catch (err) {
            if (err instanceof ProblemDetailsError && err.status === 409) taken.push(file);
            else toast.error(`Could not add ${file.name}: ${describeError(err)}`);
          }
        }
        if (stored.length > 0) announceStored(stored, 'Added');
        if (taken.length > 0) {
          const names = taken.map((file) => file.name);
          toast.warning(
            `${listNames(names)} ${names.length === 1 ? 'is' : 'are'} already in the workspace.`,
            {
              action: { label: 'Replace', onClick: () => void replaceFiles(taken) },
              duration: DECISION_TOAST_MS,
            },
          );
        }
      } finally {
        setRunning((n) => n - 1);
      }
    },
    [announceStored, replaceFiles],
  );

  return { addFiles, isUploading: running > 0 };
}
