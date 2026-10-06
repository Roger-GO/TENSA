import { useCallback } from 'react';
import { EmptyState, FolderIcon, SnapshotIcon } from '@/components/ui/EmptyState';
import { useListSnapshots, useListWorkspaceFiles, useRestoreSnapshot } from '@/api/queries';
import type { SnapshotListEntry } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useSnapshotStore } from '@/store/snapshot';
import { ProblemDetailsError } from '@/api/client';
import type { WorkspaceFile } from '@/api/types';
import { AddCaseFilesButton } from '@/components/case/AddCaseFilesButton';
import { CASE_FILE_EXTENSIONS } from '@/lib/caseUpload';
import { isPrimaryCase, useOpenCase } from '@/lib/openCase';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';
import { useRecentCasesStore } from '@/store/recentCases';
import { useUploadNoticeStore } from '@/store/uploadNotice';

/**
 * SavedCasesList (v3 Unit 4).
 *
 * Combined list of workspace case files + saved snapshots. Sits in the
 * "Saved cases" section of the LeftSidebar (Unit 3).
 *
 * Up to three visually distinct row groups:
 *
 *  - **Recent** — the cases opened last (``useRecentCasesStore``) that the
 *    workspace still holds, newest first, each with the dynamic files it
 *    was opened with: a click opens the pair again. Only once something
 *    has been opened.
 *  - **Workspace files** — every `.raw / .xlsx / .json / .m` file the
 *    substrate's workspace lister returns, minus `.layout.json` sidecars
 *    (same filter as ``WorkspaceFilePicker``). Click a row to load that
 *    case with ``useOpenCase``, which the palette's Open case page uses
 *    too. It parses the workspace path and skips the load for the case
 *    already open, so a click on that one is a no-op rather than a
 *    destructive reload. The group's header has the button that adds
 *    files to the workspace (dropping them on the window does the same).
 *  - **Snapshots** — only renders when a case is loaded. Lists the
 *    substrate's snapshot listing for the active session. Click a row
 *    to restore via ``useRestoreSnapshot`` (replays the snapshot's
 *    disturbances and re-solves the power flow; same as the
 *    ``LoadSnapshotDialog`` Restore button with its default options).
 *    The group's header has the button that saves one (it opens
 *    ``SaveSnapshotDialog``): a list of snapshots is where a first-time
 *    user looks for the way to make one, and the Workspace menu's item
 *    is a menu away.
 *
 * Empty states use the canonical ``<EmptyState />`` component (per the
 * v3 plan IA spec). The two sections render their own empty state so
 * "no workspace files yet" doesn't drown out "snapshots will appear
 * here once you save one" or vice-versa.
 *
 * Network shape mirrors ``WorkspaceFilePicker`` + ``LoadSnapshotDialog``
 * — TanStack Query hooks own the I/O; this component is purely a
 * presentation + click-through layer. Errors surface via the global
 * toast (per the AGENTS toast policy: transient action results go to
 * ``toast.*``, recovery hints get an action button).
 */

function formatLabel(format: WorkspaceFile['format']): string {
  return format.toUpperCase();
}

/** How many recent cases the list shows. */
const MAX_RECENT_SHOWN = 5;

export interface SavedCasesListProps {
  className?: string;
}

export function SavedCasesList({ className }: SavedCasesListProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const caseSelection = useCaseStore((s) => s.selection);
  const loadingPath = useCaseStore((s) => s.loadingPath);

  const filesQuery = useListWorkspaceFiles();
  const snapshotsQuery = useListSnapshots();
  const { openCase, isPending: loadPending } = useOpenCase();
  const restoreSnapshot = useRestoreSnapshot();
  const markRestorePending = useSnapshotStore((s) => s.markRestorePending);
  const markRestoreSuccess = useSnapshotStore((s) => s.markRestoreSuccess);
  const markRestoreError = useSnapshotStore((s) => s.markRestoreError);
  const openSaveSnapshot = useSnapshotStore((s) => s.openSaveDialog);

  const files = (filesQuery.data?.files ?? []).filter(isPrimaryCase);
  const recentCases = useRecentCasesStore((s) => s.cases);
  // A recent case is shown while the workspace still holds its file, with the
  // dynamic files that are still there.
  const present = new Set((filesQuery.data?.files ?? []).map((f) => f.name));
  const recent = recentCases
    .flatMap((c) => {
      const file = files.find((f) => f.name === c.primaryPath);
      return file === undefined
        ? []
        : [{ file, addfiles: c.addfiles.filter((a) => present.has(a)) }];
    })
    .slice(0, MAX_RECENT_SHOWN);
  const refused = useUploadNoticeStore((s) => s.refused);
  const dismissRefused = useUploadNoticeStore((s) => s.dismiss);
  const hasCaseLoaded = caseSelection !== null;
  const snapshots: readonly SnapshotListEntry[] = snapshotsQuery.data?.snapshots ?? [];

  /**
   * Click handler for a snapshot row. Mirrors ``LoadSnapshotDialog``'s
   * submitRestore path: defaults to the replay restore; surfaces
   * success / failure via the global toast (the dialog's inline
   * success card is dialog-scoped — out of place inside the sidebar).
   */
  const handleRestoreSnapshot = useCallback(
    async (name: string) => {
      if (!sessionId) return;
      markRestorePending();
      try {
        const result = await restoreSnapshot.mutateAsync({ sessionId, name });
        markRestoreSuccess({
          used_dill: result.used_dill,
          fallback_reason: result.fallback_reason,
          disturbances_replayed: result.disturbances_replayed,
          name,
        });
        toast.success(
          `Restored ${name} (${result.used_dill ? 'dill fast path' : 'replay+PF'}; ${result.disturbances_replayed} disturbance${
            result.disturbances_replayed === 1 ? '' : 's'
          } replayed)`,
        );
      } catch (err) {
        const detail =
          err instanceof ProblemDetailsError
            ? (err.detail ?? err.title ?? `HTTP ${err.status}`)
            : err instanceof Error
              ? err.message
              : 'unknown error';
        const message = `Restore failed: ${detail}`;
        markRestoreError(message);
        toast.error(message, {
          action: { label: 'Retry', onClick: () => void handleRestoreSnapshot(name) },
        });
      }
    },
    [sessionId, restoreSnapshot, markRestorePending, markRestoreSuccess, markRestoreError],
  );

  const isCurrent = (fileName: string): boolean =>
    caseSelection !== null && caseSelection.primaryPath === fileName;

  return (
    <div
      data-testid="saved-cases-list"
      className={cn('flex flex-col gap-2 px-2 pt-1 pb-3', className)}
    >
      {/* Recent group — cases opened lately, with the files they were opened with */}
      {recent.length > 0 ? (
        <div className="flex flex-col gap-1" data-testid="saved-cases-recent-group">
          <p
            className="text-muted-foreground/70 px-1 pb-0.5 text-[9px] font-medium tracking-[0.08em] uppercase"
            data-testid="saved-cases-recent-heading"
          >
            Recent
          </p>
          <ul className="flex flex-col gap-0.5" role="list" aria-label="Recent cases">
            {recent.map(({ file, addfiles }) => (
              <li key={file.name}>
                <CaseRow
                  testId={`saved-cases-recent-${file.name}`}
                  name={file.name}
                  detail={addfiles.length > 0 ? `with ${addfiles.join(', ')}` : null}
                  label={formatLabel(file.format)}
                  current={isCurrent(file.name)}
                  loading={loadingPath === file.name}
                  disabled={loadPending}
                  onClick={() => openCase(file.name, addfiles)}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Workspace files group ------------------------------------------- */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <p
            className="text-muted-foreground/70 px-1 pb-0.5 text-[9px] font-medium tracking-[0.08em] uppercase"
            data-testid="saved-cases-files-heading"
          >
            Workspace
          </p>
          <AddCaseFilesButton />
        </div>
        {refused.length > 0 ? (
          <div
            role="group"
            aria-label="Files not added"
            data-testid="saved-cases-upload-notice"
            className="border-danger/40 bg-danger/5 flex flex-col gap-1 rounded-[var(--radius-sm)] border px-2 py-1.5 text-[11px]"
          >
            <p className="text-foreground font-medium">
              {refused.length === 1
                ? '1 file was not added'
                : `${refused.length} files were not added`}
            </p>
            <ul className="text-muted-foreground flex flex-col gap-0.5">
              {refused.map((line, i) => (
                <li key={i} className="break-words">
                  {line}
                </li>
              ))}
            </ul>
            <button
              type="button"
              data-testid="saved-cases-upload-notice-dismiss"
              onClick={dismissRefused}
              className={cn(
                'text-primary self-start rounded-[var(--radius-sm)] px-1 text-[10px] font-medium hover:underline',
                'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
              )}
            >
              Dismiss
            </button>
          </div>
        ) : null}
        {files.length === 0 ? (
          <div data-testid="saved-cases-files-empty">
            <EmptyState
              icon={<FolderIcon />}
              title="No case files"
              description="Drop a .raw / .xlsx / .json / .m file anywhere in this window, or use Add files."
              emptyStateKey="saved-cases-files-empty"
            />
          </div>
        ) : (
          <>
            <ul className="flex flex-col gap-0.5" role="list" aria-label="Workspace files">
              {files.map((file) => (
                <li key={file.name}>
                  <CaseRow
                    testId={`saved-cases-row-${file.name}`}
                    name={file.name}
                    detail={null}
                    label={formatLabel(file.format)}
                    current={isCurrent(file.name)}
                    loading={loadingPath === file.name}
                    disabled={loadPending}
                    onClick={() => openCase(file.name)}
                  />
                </li>
              ))}
            </ul>
            <p
              data-testid="saved-cases-drop-hint"
              className="text-muted-foreground px-1 text-[10px] leading-snug"
            >
              Drop {CASE_FILE_EXTENSIONS.join(', ')} files anywhere in this window to add them.
            </p>
          </>
        )}
      </div>

      {/* Snapshots group — gated on a loaded case ----------------------- */}
      {hasCaseLoaded ? (
        <div className="flex flex-col gap-1" data-testid="saved-cases-snapshots-group">
          <div className="flex items-center justify-between gap-2 pt-2">
            <p
              className="text-muted-foreground px-1 pb-0.5 text-[10px] font-medium tracking-wide uppercase"
              data-testid="saved-cases-snapshots-heading"
            >
              Snapshots
            </p>
            <button
              type="button"
              data-testid="saved-cases-save-snapshot"
              onClick={openSaveSnapshot}
              title="Save the operating point, the disturbances and the diagram as it is placed now under a name, to restore later."
              className={cn(
                'border-border text-primary rounded-[var(--radius-sm)] border px-2 py-0.5',
                'text-[11px] font-medium',
                'hover:bg-muted transition-colors duration-[var(--duration-fast)]',
                'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
              )}
            >
              Save snapshot…
            </button>
          </div>
          {snapshots.length === 0 ? (
            <div data-testid="saved-cases-snapshots-empty">
              <EmptyState
                icon={<SnapshotIcon />}
                title="No snapshots"
                description="Use Save snapshot to keep the operating point and the diagram as it is placed now, and restore them later."
                emptyStateKey="saved-cases-snapshots-empty"
              />
            </div>
          ) : (
            <>
              <ul className="flex flex-col gap-0.5" role="list" aria-label="Saved snapshots">
                {snapshots.map((snap) => (
                  <li key={snap.name}>
                    <button
                      type="button"
                      data-testid={`saved-cases-row-snapshot-${snap.name}`}
                      onClick={() => void handleRestoreSnapshot(snap.name)}
                      disabled={restoreSnapshot.isPending}
                      title={`Restore ${snap.name}: the operating point and the diagram as they were when it was saved`}
                      className={cn(
                        'group flex w-full items-center justify-between gap-2',
                        'rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-xs',
                        'transition-colors duration-[var(--duration-fast)]',
                        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                        'disabled:cursor-not-allowed disabled:opacity-60',
                        'text-foreground hover:bg-muted/60',
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <SnapshotGlyph />
                        {/* The row shows only the name; what a click does is in its
                            accessible name too, not just in the hint under the list. */}
                        <span className="sr-only">Restore snapshot</span>
                        <span className="truncate font-mono">{snap.name}</span>
                      </span>
                      <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
                        {snap.andes_version}
                        {snap.has_pflow ? ' · PF' : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <p
                data-testid="saved-cases-snapshots-hint"
                className="text-muted-foreground px-1 text-[10px] leading-snug"
              >
                Click a snapshot to restore its operating point and diagram layout. To delete one,
                open Load snapshot in the Workspace menu.
              </p>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

interface CaseRowProps {
  testId: string;
  name: string;
  /** A second line under the name (the dynamic files a recent case opens with), or `null`. */
  detail: string | null;
  /** The format at the row's right edge, unless it is loading. */
  label: string;
  current: boolean;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}

/** One case in the list: a button that opens it. */
function CaseRow({
  testId,
  name,
  detail,
  label,
  current,
  loading,
  disabled,
  onClick,
}: CaseRowProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-current={current ? 'true' : undefined}
      aria-busy={loading ? 'true' : undefined}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'group flex w-full items-center justify-between gap-2',
        'rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-xs',
        'transition-colors duration-[var(--duration-fast)]',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-60',
        current ? 'bg-muted text-foreground' : 'text-foreground hover:bg-muted/60',
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <FileGlyph />
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-mono">{name}</span>
          {detail !== null ? (
            <span className="text-muted-foreground truncate font-mono text-[10px]">{detail}</span>
          ) : null}
        </span>
      </span>
      <span
        className={cn(
          'shrink-0 font-mono text-[10px]',
          loading ? 'text-primary' : 'text-muted-foreground',
        )}
      >
        {loading ? 'Loading…' : label}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Inline-SVG glyphs. Match the codebase house style (stroke=currentColor,
// inline `aria-hidden`). Sized to ~12px so they don't dwarf the row text.
// ---------------------------------------------------------------------------

function FileGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-muted-foreground h-3.5 w-3.5 shrink-0"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function SnapshotGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-muted-foreground h-3.5 w-3.5 shrink-0"
    >
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M17 21v-8H7v8" />
      <path d="M7 3v5h8" />
    </svg>
  );
}
