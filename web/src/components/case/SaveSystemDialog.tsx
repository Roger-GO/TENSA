import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSaveCase } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { draftCaseKey, draftKeyOfPath, useDraftsStore } from '@/store/drafts';
import { useEditJournalStore } from '@/store/editJournal';
import { ProblemDetailsError } from '@/api/client';
import { cn } from '@/lib/cn';
import { useOpenCase } from '@/lib/openCase';
import { baseName } from '@/lib/paths';
import {
  NAME_OF_A_NEW_SYSTEM,
  OPEN_THE_COPY,
  SAVED_COPY_TOAST_ID,
  openCasePath,
  stillEditing,
  suggestedCopyName,
} from '@/lib/savedCopy';
import { saveInPlaceTarget } from '@/lib/saveInPlace';
import { toast } from '@/lib/toast';
import { useSafeTimeout } from '@/lib/useSafeTimeout';
import { useWriteLayoutSidecar } from '@/lib/useSaveOpenCase';

/**
 * "Save system as" format-picker modal: the whole system, written to a new file
 * in the workspace in a format of the user's choosing. (Save, Ctrl/Cmd+S, writes
 * the open file back instead where that is safe, and asks for this modal where it
 * is not; the modal then says why.)
 *
 * Controlled, so whoever owns an always-mounted copy can open it from anywhere:
 * the Workspace menu keeps one for its menu item, the palette command and
 * Ctrl/Cmd+S.
 *
 * A copy is what it writes: the session goes on with the case it had open, which
 * a user who expects Save as to move them to the new file cannot tell from the
 * diagram. So a save says which file is still being edited, in a notice with a
 * button that opens the copy, and the Project tab keeps saying it under the
 * name of the loaded case (`savedCopy` of the case store, `CaseNav`).
 *
 * The modal has:
 *
 * - Filename input (workspace-relative; extension auto-derived from
 *   format). It opens on a name made from the open case's (`wscc9-copy`),
 *   selected, so typing replaces it and Enter saves under it.
 * - Format radio: xlsx (ANDES native), raw, or json. ANDES 2.0 has no PSS/E
 *   writer, so .raw comes from the substrate's own v33 writer
 *   (`server/src/tensa/core/psse_writer.py`). A .raw holds no dynamic data,
 *   and the option says so: the machines and controllers of the case are
 *   left out of it.
 * - Submit fires `useSaveCase()`. On 409 (file exists) the modal flips
 *   to an "Overwrite?" confirmation.
 */
export interface SaveSystemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Format = 'xlsx' | 'json' | 'raw';

const EXT_BY_FORMAT: Record<Format, string> = {
  xlsx: '.xlsx',
  json: '.json',
  raw: '.raw',
};

function ensureExtension(filename: string, format: Format): string {
  const ext = EXT_BY_FORMAT[format];
  if (filename.endsWith(ext)) return filename;
  // Strip any other recognized extension before appending.
  const stripped = filename.replace(/\.(xlsx|json|raw|dyr|m)$/i, '');
  return stripped + ext;
}

export function SaveSystemDialog({ open: modalOpen, onOpenChange }: SaveSystemDialogProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const saveMutation = useSaveCase();
  // Writes the diagram's layout beside the case file (reading it at click time).
  const writeSidecarAlongside = useWriteLayoutSidecar();
  // Why Save did not write the open file, when this dialog is open because it could not.
  const selection = useCaseStore((s) => s.selection);
  const cloneInitialized = useCaseStore((s) => s.cloneInitialized);
  const replaced = useEditJournalStore((s) => s.replaced);
  const savedCopy = useCaseStore((s) => s.savedCopy);
  const { openCase } = useOpenCase();
  const [filename, setFilename] = useState(() => suggestedCopyName(selection));
  const filenameInput = useRef<HTMLInputElement>(null);
  // Each opening starts on the name made from the case open now. Set while
  // rendering, not in an effect, so the first frame of the modal already holds
  // it and the name can be selected as the focus arrives.
  const [wasOpen, setWasOpen] = useState(modalOpen);
  if (modalOpen !== wasOpen) {
    setWasOpen(modalOpen);
    if (modalOpen) setFilename(suggestedCopyName(selection));
  }
  const [format, setFormat] = useState<Format>('xlsx');
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // This component stays mounted while the modal opens and closes, so the
  // unmount cleanup of ``useSafeTimeout`` alone would not stop the auto-close
  // beat of one opening from closing the next. Opening or closing the modal
  // cancels a pending beat and bumps ``modalEpoch``; a save that answers after
  // the modal it started in was left must not touch the one open now.
  const schedule = useSafeTimeout();
  const cancelAutoClose = useRef<(() => void) | null>(null);
  const modalEpoch = useRef(0);

  const resetBeat = () => {
    modalEpoch.current += 1;
    cancelAutoClose.current?.();
    cancelAutoClose.current = null;
  };
  const setModalState = (next: boolean) => {
    resetBeat();
    onOpenChange(next);
  };
  // The owner opens and closes the modal too, not only the buttons below, so
  // each flip of ``open`` ends the last opening's beat and bumps the epoch, and
  // an opening starts without the last one's error or "saved" line. They stay
  // while the modal fades out.
  useEffect(() => {
    resetBeat();
    if (modalOpen) {
      setError(null);
      setSuccess(null);
    }
  }, [modalOpen]);

  // The notice of a copy says "you are still editing", which stops being so
  // the moment another case is opened (the store drops `savedCopy` then).
  useEffect(() => {
    if (savedCopy === null) toast.dismiss(SAVED_COPY_TOAST_ID);
  }, [savedCopy]);

  // A system built here has no file for Save to write, which needs no explaining; an
  // opened file that Save cannot write back does.
  const saveTarget = saveInPlaceTarget(selection, { cloneInitialized, replaced });
  const whySaveAsks =
    !saveTarget.ok && selection?.primaryPath != null && selection.blank !== true
      ? saveTarget.reason
      : null;

  const submit = () => {
    if (!sessionId || saveMutation.isPending) return;
    setError(null);
    setSuccess(null);
    const targetName = ensureExtension(filename.trim(), format);
    if (targetName === ensureExtension('', format) || targetName.length <= 5) {
      setError('Pick a non-empty filename.');
      return;
    }
    const epoch = modalEpoch.current;
    saveMutation.mutate(
      {
        sessionId,
        body: { filename: targetName, format, overwrite },
      },
      {
        onSuccess: (resp) => {
          // Auto-save the layout sidecar alongside the case file so the
          // saved case reopens as it is placed now (Unit 13a). The file
          // is on disk whether or not the modal is still the one that saved.
          writeSidecarAlongside(resp.filename);
          // The drafts on the diagram go with the copy as well: the ones of a
          // system built from scratch have no other file to be found under.
          const draftsOf = draftCaseKey(useCaseStore.getState().selection);
          if (draftsOf !== null) {
            useDraftsStore.getState().copy(draftsOf, draftKeyOfPath(resp.filename));
          }
          // Which file is being edited now is said whether or not the modal is
          // still open. A save over the open file itself made no copy.
          const openPath = openCasePath(useCaseStore.getState().selection);
          if (openPath !== resp.filename) {
            const copy = resp.filename;
            useCaseStore.getState().setSavedCopy(copy);
            toast.success(`Saved as ${baseName(copy)}`, {
              id: SAVED_COPY_TOAST_ID,
              description: stillEditing(openPath),
              duration: 15_000,
              action: { label: OPEN_THE_COPY, onClick: () => openCase(copy) },
            });
          }
          if (modalEpoch.current !== epoch) return;
          setSuccess(`Wrote ${resp.bytes_written} bytes to ${resp.filename}`);
          cancelAutoClose.current = schedule(() => setModalState(false), 1200);
        },
        onError: (err) => {
          if (modalEpoch.current !== epoch) return;
          if (err instanceof ProblemDetailsError) {
            if (err.status === 409 && !overwrite) {
              setError('A file by that name already exists. Tick "Overwrite" to replace it.');
              return;
            }
            setError(err.detail ?? err.title ?? 'Save failed');
          } else if (err instanceof Error) {
            setError(err.message);
          }
        },
      },
    );
  };

  return (
    <>
      <Dialog
        open={modalOpen}
        onOpenChange={(next) => {
          if (!next) setModalState(false);
        }}
      >
        <DialogContent
          onOpenAutoFocus={(event) => {
            // On the name, selected: typing replaces it, and Enter saves.
            event.preventDefault();
            filenameInput.current?.focus();
            filenameInput.current?.select();
          }}
        >
          <DialogTitle>Save system as</DialogTitle>
          <DialogDescription className="mt-2">
            Writes a copy of the system as it is now to the workspace, as a new file you can open
            later. The case file you opened is not changed, and it stays the one you are editing:
            open the copy from the Project tab to go on there. The diagram&apos;s layout (where
            everything is placed) is written with the copy as
            <code> &lt;filename&gt;.layout.json</code>; the layout of the case you have open saves
            by itself as you move things.
          </DialogDescription>
          {whySaveAsks !== null ? (
            <p
              data-testid="save-system-why-new-file"
              className="text-muted-foreground mt-2 text-xs"
            >
              {whySaveAsks}
            </p>
          ) : null}
          {/* A form, so that Enter in the name saves. */}
          <form
            data-testid="save-system-form"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="mt-4 flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs font-medium">
                  Filename (without extension)
                </span>
                <input
                  ref={filenameInput}
                  type="text"
                  value={filename}
                  onChange={(e) => setFilename(e.target.value)}
                  disabled={saveMutation.isPending}
                  className="bg-background border-border h-8 rounded border px-2 font-mono text-sm"
                  data-testid="save-filename"
                />
                <span className="text-muted-foreground text-[10px]">
                  Will save as{' '}
                  <code>{ensureExtension(filename || NAME_OF_A_NEW_SYSTEM, format)}</code>. Enter
                  saves.
                </span>
              </label>
              <fieldset className="flex flex-col gap-2">
                <legend className="text-muted-foreground text-xs font-medium">Format</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="save-format"
                    checked={format === 'xlsx'}
                    onChange={() => setFormat('xlsx')}
                    disabled={saveMutation.isPending}
                  />
                  <span>
                    <strong>xlsx</strong> — ANDES native, opens in Excel
                  </span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="save-format"
                    checked={format === 'raw'}
                    onChange={() => setFormat('raw')}
                    disabled={saveMutation.isPending}
                  />
                  <span>
                    <strong>raw</strong> — PSS/E v33, the power-flow data only (no dynamic models)
                  </span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="save-format"
                    checked={format === 'json'}
                    onChange={() => setFormat('json')}
                    disabled={saveMutation.isPending}
                  />
                  <span>
                    <strong>json</strong> — cleanest round-trip
                  </span>
                </label>
              </fieldset>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-testid="save-overwrite"
                  checked={overwrite}
                  onChange={(e) => setOverwrite(e.target.checked)}
                  disabled={saveMutation.isPending}
                />
                <span>Overwrite if exists</span>
              </label>
              {error ? (
                <div
                  role="alert"
                  data-testid="save-error"
                  className={cn(
                    'border-danger/30 bg-danger/10 text-foreground',
                    'rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs',
                  )}
                >
                  {error}
                </div>
              ) : null}
              {success ? (
                <div
                  role="status"
                  className={cn(
                    'border-success/30 bg-success/10 text-foreground',
                    'rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs',
                  )}
                >
                  {success}
                </div>
              ) : null}
            </div>
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setModalState(false)}
                disabled={saveMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={saveMutation.isPending}
                data-testid="save-confirm"
              >
                {saveMutation.isPending ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
