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
 * - a single case among the files dropped is opened when nothing is open or
 *   loading (with the `.dyr` files that came with a `.raw`), and offered with an
 *   Open button when a case is open, since opening discards that case's results.
 *   A file whose name was taken counts as dropped: it stands in the workspace
 *   under that name, so a `.raw` dropped with a `.dyr` that is already there
 *   opens with it, and Replace afterwards says the open case holds the old copy;
 * - replacing the file of the case that is open says the open case still holds
 *   the old copy, with a Reload case button.
 *
 * A toast button acts on the session and the open case of the moment it is
 * pressed, which can be up to `DECISION_TOAST_MS` after the toast went up.
 *
 * A file that was turned away is also kept in the upload notice
 * (`useUploadNoticeStore`), which the saved-cases list shows until it is
 * dismissed or files are added again: it leaves nothing in the workspace list, so
 * a toast that went by unseen would leave no sign that it was tried.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { ProblemDetailsError } from '@/api/client';
import { useReloadCase, useUploadWorkspaceFile } from '@/api/queries';
import { fileExtension, planOpen, uploadProblem } from '@/lib/caseUpload';
import { useOpenCase } from '@/lib/openCase';
import { toast } from '@/lib/toast';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { useUploadNoticeStore } from '@/store/uploadNotice';
import { describeError } from '@/lib/describeError';

/** How long a toast that asks for a decision stays up. */
const DECISION_TOAST_MS = 15_000;

/** How long a toast that has to be read, a refusal or a hint, stays up: longer than the 4 s default. */
const READ_TOAST_MS = 10_000;

/** What a lone `.dyr` needs, since the saved-cases list shows cases and not the `.dyr` files beside them. */
const DYR_ALONE_HINT =
  'A .dyr file opens together with its .raw. Add the two at once to open them.';

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

/** The workspace files the open case was loaded from; none when no case is open. */
function loadedFiles(): (string | null)[] {
  const { selection } = useCaseStore.getState();
  return selection === null ? [] : [selection.primaryPath, ...selection.addfiles];
}

export function useAddWorkspaceFiles(): AddWorkspaceFiles {
  const upload = useUploadWorkspaceFile();
  const reloadCase = useReloadCase();
  const { openCase } = useOpenCase();
  const [running, setRunning] = useState(0);

  // The work below outlives the render that started it (uploads are awaited, and
  // a toast button is pressed later), so it reads these through a ref, at the
  // time it acts, and never acts on the session or the open case of a moment ago.
  const latest = useRef({ upload, reloadCase, openCase });
  useEffect(() => {
    latest.current = { upload, reloadCase, openCase };
  });

  /**
   * Tell the user what was stored (added or replaced), and open what should be.
   * `group` is every file of the drop that is in the workspace under its name,
   * stored or taken, and is what the open is planned from.
   */
  const announceStored = useCallback(
    (names: readonly string[], verb: 'Added' | 'Replaced', group: readonly string[] = names) => {
      const sessionId = useSessionStore.getState().sessionId;
      const { selection, loadingPath } = useCaseStore.getState();
      const loaded = loadedFiles();
      const stale = names.filter((name) => loaded.includes(name));
      const where = verb === 'Added' ? 'to the workspace' : 'in the workspace';
      const message =
        names.length === 1
          ? `${verb} ${names[0]} ${where}.`
          : `${verb} ${names.length} files ${where}.`;
      const description = names.length === 1 ? undefined : listNames(names);

      if (stale.length > 0 && sessionId !== null) {
        toast.warning(`${verb} ${listNames(stale)}. The open case still holds the old copy.`, {
          action: {
            label: 'Reload case',
            onClick: () => {
              // Not the case of a moment ago: one opened since holds the new copy.
              const current = useSessionStore.getState().sessionId;
              if (current !== null && stale.some((name) => loadedFiles().includes(name))) {
                latest.current.reloadCase.mutate(current);
              }
            },
          },
          duration: DECISION_TOAST_MS,
        });
        return;
      }
      const plan = planOpen(group);
      if (plan === null) {
        // Nothing opens, and a `.dyr` is not listed on its own: say how it gets used.
        if (group.every((name) => fileExtension(name) === '.dyr')) {
          toast.success(message, {
            description:
              description === undefined ? DYR_ALONE_HINT : `${description}. ${DYR_ALONE_HINT}`,
            duration: READ_TOAST_MS,
          });
        } else {
          toast.success(message, { description });
        }
        return;
      }
      const open = () => latest.current.openCase(plan.primary, plan.addfiles);
      // A case that is still loading is not open yet, but a second load would race it.
      if (selection === null && loadingPath === null && sessionId !== null) {
        toast.success(message, { description });
        open();
        return;
      }
      toast.success(message, {
        description,
        action: sessionId === null ? undefined : { label: 'Open', onClick: open },
        duration: DECISION_TOAST_MS,
      });
    },
    [],
  );

  const replaceFiles = useCallback(
    async (files: readonly File[], group: readonly string[]) => {
      const replaced: string[] = [];
      const failures: string[] = [];
      useUploadNoticeStore.getState().dismiss();
      for (const file of files) {
        try {
          await latest.current.upload.mutateAsync({ file, overwrite: true });
          replaced.push(file.name);
        } catch (err) {
          const failure = `Could not replace ${file.name}: ${describeError(err)}`;
          failures.push(failure);
          toast.error(failure, { duration: READ_TOAST_MS });
        }
      }
      if (failures.length > 0) useUploadNoticeStore.getState().show(failures);
      if (replaced.length > 0) announceStored(replaced, 'Replaced', group);
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
      // Whatever the last attempt turned away is replaced by this one's.
      const refused = [...problems];
      useUploadNoticeStore.getState().dismiss();
      if (problems.length === 1) toast.error(problems[0] ?? '', { duration: READ_TOAST_MS });
      else if (problems.length > 1) {
        toast.error(`${problems.length} files were not added.`, {
          description: problems.join(' '),
          duration: READ_TOAST_MS,
        });
      }

      setRunning((n) => n + 1);
      try {
        const stored: string[] = [];
        const taken: File[] = [];
        // What of this drop is in the workspace under its name now, in the order
        // dropped: the files stored, and the ones whose name was already taken.
        const present: string[] = [];
        for (const file of candidates) {
          try {
            await latest.current.upload.mutateAsync({ file });
            stored.push(file.name);
            present.push(file.name);
          } catch (err) {
            if (err instanceof ProblemDetailsError && err.status === 409) {
              taken.push(file);
              present.push(file.name);
            } else {
              const failure = `Could not add ${file.name}: ${describeError(err)}`;
              refused.push(failure);
              toast.error(failure, { duration: READ_TOAST_MS });
            }
          }
        }
        if (stored.length > 0) announceStored(stored, 'Added', present);
        if (taken.length > 0) {
          const names = taken.map((file) => file.name);
          toast.warning(
            `${listNames(names)} ${names.length === 1 ? 'is' : 'are'} already in the workspace.`,
            {
              action: { label: 'Replace', onClick: () => void replaceFiles(taken, present) },
              duration: DECISION_TOAST_MS,
            },
          );
        }
      } finally {
        setRunning((n) => n - 1);
        if (refused.length > 0) useUploadNoticeStore.getState().show(refused);
      }
    },
    [announceStored, replaceFiles],
  );

  return { addFiles, isUploading: running > 0 };
}
