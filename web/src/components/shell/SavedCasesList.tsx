import { useCallback } from 'react';
import { EmptyState, FolderIcon, SnapshotIcon } from '@/components/ui/EmptyState';
import {
  useListSnapshots,
  useListWorkspaceFiles,
  useLoadCase,
  useRestoreSnapshot,
} from '@/api/queries';
import type { SnapshotListEntry } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useSnapshotStore } from '@/store/snapshot';
import { ProblemDetailsError } from '@/api/client';
import { parseWorkspacePath } from '@/api/types';
import type { WorkspaceFile } from '@/api/types';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';

/**
 * SavedCasesList (v3 Unit 4).
 *
 * Combined list of workspace case files + saved snapshots. Sits in the
 * "Saved cases" section of the LeftSidebar (Unit 3).
 *
 * Two visually distinct row groups:
 *
 *  - **Workspace files** — every `.raw / .xlsx / .json / .m` file the
 *    substrate's workspace lister returns, minus `.layout.json` sidecars
 *    (same filter as ``WorkspaceFilePicker``). Click a row to load that
 *    case via ``useLoadCase``. Reuses the picker's parse-workspace-path
 *    + same-file no-op guard so a click on the already-loaded case is a
 *    no-op rather than a destructive reload.
 *  - **Snapshots** — only renders when a case is loaded. Lists the
 *    substrate's snapshot listing for the active session. Click a row
 *    to restore via ``useRestoreSnapshot`` (uses the dill fast path by
 *    default; same as ``LoadSnapshotDialog`` Restore button).
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

type PrimaryFormat = 'xlsx' | 'raw' | 'json' | 'm';
const PRIMARY_FORMATS: ReadonlySet<PrimaryFormat> = new Set(['xlsx', 'raw', 'json', 'm']);

function isPrimaryCase(file: WorkspaceFile): file is WorkspaceFile & { format: PrimaryFormat } {
  if (!PRIMARY_FORMATS.has(file.format as PrimaryFormat)) return false;
  // Sidecar layout files (`<case>.layout.json`) are not loadable; skip.
  if (file.name.endsWith('.layout.json')) return false;
  return true;
}

function formatLabel(format: WorkspaceFile['format']): string {
  return format.toUpperCase();
}

export interface SavedCasesListProps {
  className?: string;
}

export function SavedCasesList({ className }: SavedCasesListProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const caseSelection = useCaseStore((s) => s.selection);
  const setCase = useCaseStore((s) => s.setCase);

  const filesQuery = useListWorkspaceFiles();
  const snapshotsQuery = useListSnapshots();
  const loadCase = useLoadCase();
  const restoreSnapshot = useRestoreSnapshot();
  const markRestorePending = useSnapshotStore((s) => s.markRestorePending);
  const markRestoreSuccess = useSnapshotStore((s) => s.markRestoreSuccess);
  const markRestoreError = useSnapshotStore((s) => s.markRestoreError);

  const files = (filesQuery.data?.files ?? []).filter(isPrimaryCase);
  const hasCaseLoaded = caseSelection !== null;
  const snapshots: readonly SnapshotListEntry[] = snapshotsQuery.data?.snapshots ?? [];

  /**
   * Click handler for a workspace-file row. Mirrors the
   * ``WorkspaceFilePicker.onLoad`` happy path:
   *   1. Parse the workspace path (defensive — the substrate also
   *      validates `..` segments).
   *   2. Same-file no-op guard — skip the load if the user clicked the
   *      currently-loaded case (avoids tearing down PF results +
   *      snapshots + disturbance log just to land back at the same
   *      case).
   *   3. Dispatch the load mutation; mirror the resolved selection into
   *      the case slice so CaseNav's summary card swaps in.
   *
   * No addfile picker here — the LeftSidebar SavedCasesList is the
   * "click to load" surface; the WorkspaceFilePicker (still mounted
   * inside CaseNav for the no-case state) remains the entry point for
   * `.raw` + `.dyr` pairings. Loading a `.raw` from this list defaults
   * to "no addfile" — the user can re-open with the picker if they
   * want to pair a `.dyr`.
   */
  const handleLoadFile = useCallback(
    (fileName: string) => {
      if (!sessionId) return;
      let primary;
      try {
        primary = parseWorkspacePath(fileName);
      } catch (err) {
        toast.error(`Invalid workspace path: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      // Same-file no-op guard — see WorkspaceFilePicker.onLoad.
      if (
        caseSelection !== null &&
        caseSelection.primaryPath === primary &&
        caseSelection.addfiles.length === 0
      ) {
        return;
      }
      loadCase.mutate(
        {
          sessionId,
          request: { primary_path: primary, addfiles: null },
        },
        {
          onSuccess: () => {
            setCase({ primaryPath: primary, addfiles: [] });
          },
          onError: (err) => {
            const detail =
              err instanceof ProblemDetailsError
                ? (err.detail ?? err.title ?? `HTTP ${err.status}`)
                : err.message;
            toast.error(`Load failed: ${detail}`);
          },
        },
      );
    },
    [sessionId, caseSelection, loadCase, setCase],
  );

  /**
   * Click handler for a snapshot row. Mirrors ``LoadSnapshotDialog``'s
   * submitRestore path: defaults to the dill fast path; surfaces
   * success / failure via the global toast (the dialog's inline
   * success card is dialog-scoped — out of place inside the sidebar).
   */
  const handleRestoreSnapshot = useCallback(
    async (name: string) => {
      if (!sessionId) return;
      markRestorePending();
      try {
        const result = await restoreSnapshot.mutateAsync({
          sessionId,
          name,
          useDillOptimization: true,
        });
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
      {/* Workspace files group ------------------------------------------- */}
      <div className="flex flex-col gap-1">
        <p
          className="text-muted-foreground/70 px-1 pb-0.5 text-[9px] font-medium tracking-[0.08em] uppercase"
          data-testid="saved-cases-files-heading"
        >
          Workspace
        </p>
        {files.length === 0 ? (
          <div data-testid="saved-cases-files-empty">
            <EmptyState
              icon={<FolderIcon />}
              title="No case files"
              description="Place a .raw / .xlsx / .json / .m file in the workspace dir."
              emptyStateKey="saved-cases-files-empty"
            />
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5" role="list" aria-label="Workspace files">
            {files.map((file) => {
              const current = isCurrent(file.name);
              return (
                <li key={file.name}>
                  <button
                    type="button"
                    data-testid={`saved-cases-row-${file.name}`}
                    aria-current={current ? 'true' : undefined}
                    onClick={() => handleLoadFile(file.name)}
                    disabled={loadCase.isPending}
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
                      <span className="truncate font-mono">{file.name}</span>
                    </span>
                    <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
                      {formatLabel(file.format)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Snapshots group — gated on a loaded case ----------------------- */}
      {hasCaseLoaded ? (
        <div className="flex flex-col gap-1" data-testid="saved-cases-snapshots-group">
          <p
            className="text-muted-foreground px-1 pt-2 pb-0.5 text-[10px] font-medium tracking-wide uppercase"
            data-testid="saved-cases-snapshots-heading"
          >
            Snapshots
          </p>
          {snapshots.length === 0 ? (
            <div data-testid="saved-cases-snapshots-empty">
              <EmptyState
                icon={<SnapshotIcon />}
                title="No snapshots"
                description="Save the current operating point to restore it later."
                emptyStateKey="saved-cases-snapshots-empty"
              />
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5" role="list" aria-label="Saved snapshots">
              {snapshots.map((snap) => (
                <li key={snap.name}>
                  <button
                    type="button"
                    data-testid={`saved-cases-row-snapshot-${snap.name}`}
                    onClick={() => void handleRestoreSnapshot(snap.name)}
                    disabled={restoreSnapshot.isPending}
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
          )}
        </div>
      ) : null}
    </div>
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
