import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState, FolderIcon } from '@/components/ui/EmptyState';
import { ParseErrorBanner } from './ParseErrorBanner';
import { NewSystemButton } from './NewSystemButton';
import { BundleImportButton } from '@/components/bundle/BundleImportDialog';
import { useListWorkspaceFiles, useLoadCase } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { ServerError } from '@/api/client';
import { parseWorkspacePath } from '@/api/types';
import type { SessionId, WorkspaceFile, WorkspaceFileList } from '@/api/types';
import { cn } from '@/lib/cn';

/**
 * WorkspaceFilePicker. Lists the substrate's workspace via
 * `GET /workspace/files`; the user picks a primary case (.raw, .xlsx,
 * .json, .m); for `.raw` cases an optional `.dyr` addfile selector
 * appears. The "Load" button invokes `POST /sessions/{id}/case`.
 *
 * Visual states (interaction-states.md → Case nav):
 *
 * - Loading: 5 skeleton rows (`bg-muted`, `--radius-sm`).
 * - Empty workspace: EmptyState with "place a `.raw`/.xlsx/.json/.m"
 *   copy.
 * - Populated list: rows; selected row uses `bg-muted`+`text-foreground`;
 *   `.dyr` selector visible after `.raw` is picked.
 * - Parse error: `ParseErrorBanner` above the list (R8 taxonomy mapping
 *   below).
 *
 * Error mapping (R8):
 *
 * - 422 ProblemDetails (parse error) → `ParseErrorBanner` inline above
 *   the list. Selection of the offending file is unset so the user can
 *   pick again.
 * - 5xx → kept as a typed `ServerError`; surfaced inline as a recovery
 *   prompt (Unit 9 will hook the runtime-crash modal). For Unit 7 we
 *   show a banner with "Reload page" copy + the underlying detail.
 * - 401 → handled globally by `wireGlobal401Handler` from Unit 5; we do
 *   not surface it locally.
 */

type PrimaryFormat = 'xlsx' | 'raw' | 'json' | 'm';
const PRIMARY_FORMATS: ReadonlySet<PrimaryFormat> = new Set(['xlsx', 'raw', 'json', 'm']);

function isPrimaryCase(file: WorkspaceFile): file is WorkspaceFile & { format: PrimaryFormat } {
  if (!PRIMARY_FORMATS.has(file.format as PrimaryFormat)) return false;
  // Exclude sidecar layout files. The auto-write companion to a saved
  // case is named ``<case>.layout.json`` and reports format=json; it is
  // not a loadable case. Without this filter the picker double-lists
  // every saved case + its sidecar, and the user can pick the sidecar
  // by mistake (which would 422 inside the substrate).
  if (file.name.endsWith('.layout.json')) return false;
  return true;
}

function isDyr(file: WorkspaceFile): boolean {
  return file.format === 'dyr';
}

/** Friendly format label, mirrors the substrate's enum to short caps. */
function formatLabel(format: WorkspaceFile['format']): string {
  return format.toUpperCase();
}

/**
 * Loading skeleton — 5 grey rounded-rectangle rows. Mirrors the
 * interaction-states.md "Loading" cell. Uses the design tokens (no
 * hardcoded colors).
 */
function PickerSkeleton() {
  return (
    <div role="status" aria-label="Loading workspace" className="flex flex-col gap-1.5 p-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className={cn(
            'bg-muted h-7 w-full rounded-[var(--radius-sm)]',
            'animate-pulse opacity-60',
          )}
        />
      ))}
    </div>
  );
}

/**
 * Hook — read the session id from the store. The session lifecycle (both
 * initial create and post-change-case re-create) is owned by the
 * App-level ``useSessionRecovery`` driver in ``api/useSessionRecovery.ts``;
 * the picker is purely a consumer here.
 *
 * Bug history: v0.1 had the picker fire its own ``useCreateSession``
 * cycle. The v0.2-Unit-1 plan documented the race that occurred during
 * the change-case flow when both ``CaseNav`` and the picker held their
 * own ``useCreateSession`` instances and both fired after the DELETE.
 * The substrate would mint two sessions and only one ``setSessionId``
 * call won; the picker frequently rendered against the loser, the next
 * Load click POSTed to a 404'd session, and the global 404 recovery
 * restarted the whole loop. The fix collapses session creation to a
 * single App-level consumer.
 *
 * ``creating`` here means "no session id yet AND we expect one soon" —
 * derived from the same primitive (``sessionId === null``) the App-level
 * driver consumes, so the Load button's "Connecting..." state stays in
 * sync without the picker observing the mutation directly.
 */
function useEnsureSession(): {
  sessionId: SessionId | null;
  creating: boolean;
} {
  const sessionId = useSessionStore((s) => s.sessionId);
  const recoveryFailed = useSessionStore((s) => s.recoveryFailed);
  // ``creating`` is true whenever we have no session id and we expect the
  // App-level driver to be working on one — that is, we're not in the
  // permanent recovery-failed state. The Load button reads this to render
  // "Connecting..." while it stays disabled.
  return {
    sessionId,
    creating: sessionId === null && !recoveryFailed,
  };
}

export interface WorkspaceFilePickerProps {
  className?: string;
}

export function WorkspaceFilePicker({ className }: WorkspaceFilePickerProps) {
  const filesQuery = useListWorkspaceFiles();
  const loadCase = useLoadCase();
  const { sessionId, creating: creatingSession } = useEnsureSession();
  const setCase = useCaseStore((s) => s.setCase);

  const [selectedPrimary, setSelectedPrimary] = useState<string | null>(null);
  const [selectedAddfile, setSelectedAddfile] = useState<string | null>(null);
  // Local error mirror — `loadCase.error` is global-cleared after `reset()`,
  // but we want the banner dismiss to be sticky local UI. We snapshot the
  // error into local state on each new failure and clear on dismiss.
  const [bannerError, setBannerError] = useState<Error | null>(null);

  const data: WorkspaceFileList | undefined = filesQuery.data;
  const primaryFiles = useMemo(() => (data?.files ?? []).filter(isPrimaryCase), [data]);
  const dyrFiles = useMemo(() => (data?.files ?? []).filter(isDyr), [data]);

  // Clear addfile selection when the primary changes away from a `.raw`
  // (or to a different primary entirely) to avoid stale pairings.
  useEffect(() => {
    if (!selectedPrimary) {
      setSelectedAddfile(null);
      return;
    }
    const file = (data?.files ?? []).find((f) => f.name === selectedPrimary);
    if (!file || file.format !== 'raw') {
      setSelectedAddfile(null);
    }
  }, [selectedPrimary, data]);

  // ---- error surface mapping (R8) ----------------------------------------
  useEffect(() => {
    if (loadCase.error) {
      setBannerError(loadCase.error);
      // Clear the offending selection so the user can pick again — per
      // interaction-states.md "Parse error" cell ("selection of the
      // offending file is unset").
      setSelectedPrimary(null);
      setSelectedAddfile(null);
    }
  }, [loadCase.error]);

  const currentSelection = useCaseStore((s) => s.selection);

  const onLoad = () => {
    if (!selectedPrimary || !sessionId) return;
    let primary;
    let addfiles: ReturnType<typeof parseWorkspacePath>[] = [];
    try {
      primary = parseWorkspacePath(selectedPrimary);
      if (selectedAddfile) {
        addfiles = [parseWorkspacePath(selectedAddfile)];
      }
    } catch (err) {
      // Defensive: the substrate also validates, but `..` segments should
      // never reach this layer. Surface as the parse-error banner.
      setBannerError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // v0.2 polish Unit 1 — same-file no-op guard. If the user picks the
    // case that's already loaded (same primary + same addfiles, in the
    // same order) the click is a no-op rather than a spurious reload —
    // reloading would tear down PF results, snapshots, and disturbance
    // log to land back at the same case.
    if (
      currentSelection !== null &&
      currentSelection.primaryPath === primary &&
      currentSelection.addfiles.length === addfiles.length &&
      currentSelection.addfiles.every((p, i) => p === addfiles[i])
    ) {
      return;
    }

    loadCase.mutate(
      {
        sessionId,
        request: {
          primary_path: primary,
          addfiles: addfiles.length > 0 ? addfiles : null,
        },
      },
      {
        onSuccess: () => {
          // Mirror the loaded selection into the case slice so the parent
          // CaseNav swaps to the summary card. The mutation hook itself
          // only seeds the topology; the slice's `selection` is owned by
          // the picker (the only place that knows what the user picked).
          setCase({ primaryPath: primary, addfiles });
          setBannerError(null);
        },
      },
    );
  };

  // ---- render ----------------------------------------------------------
  if (filesQuery.isLoading) {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        <PickerSkeleton />
      </div>
    );
  }

  if (filesQuery.isError) {
    return (
      <div className={cn('flex flex-col gap-3 p-3', className)}>
        <ParseErrorBanner error={filesQuery.error} onDismiss={() => filesQuery.refetch()} />
      </div>
    );
  }

  const files = data?.files ?? [];
  const hasFiles = files.length > 0;
  const selectedIsRaw =
    selectedPrimary !== null && files.find((f) => f.name === selectedPrimary)?.format === 'raw';
  const showAddfileSelector = selectedIsRaw && dyrFiles.length > 0;

  // 5xx — Unit 9 will hook a runtime-crash modal. For Unit 7 we surface
  // a recovery banner inline; the picker stays interactive.
  const isServerError = bannerError instanceof ServerError;
  const banner = bannerError ? (
    <ParseErrorBanner
      error={bannerError}
      onDismiss={() => {
        setBannerError(null);
        loadCase.reset();
      }}
    />
  ) : null;

  return (
    <div className={cn('flex h-full flex-col gap-3 p-2', className)}>
      {banner}

      {isServerError ? (
        <p className="text-muted-foreground text-xs">
          Substrate error. Try again, or reload the page if the problem persists.
        </p>
      ) : null}

      {/* createSession errors are surfaced by the App-level RecoveryBadge —
          the picker is no longer the create driver, so it doesn't render its
          own create-error banner. The badge transitions to the destructive
          "Reconnection failed — reload the tab" copy after 3 failed attempts
          in 30s; intermediate failures stay visible as "Reconnecting..." */}

      <div className="flex flex-col gap-1.5">
        <NewSystemButton />
        {/* Unit 10 — Import bundle is the third top-level entry point
            alongside "New system" and "Pick a file". A bundle is a
            full session restore (case + disturbances), so it lives
            here rather than buried in a sub-menu. Disabled when there
            is no session yet (the substrate's import endpoint is
            session-scoped). */}
        <BundleImportButton className="w-full" />
      </div>
      <div
        className="text-muted-foreground -mt-1 mb-1 flex items-center gap-2 text-[10px]"
        aria-hidden="true"
      >
        <span className="bg-border h-px flex-1" />
        <span>or pick a file</span>
        <span className="bg-border h-px flex-1" />
      </div>

      {!hasFiles ? (
        <EmptyState
          icon={<FolderIcon />}
          title="No supported case files"
          description="Place a .raw / .xlsx / .json / .m file in the workspace dir."
          emptyStateKey="workspace-files-empty"
        />
      ) : (
        <>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-muted-foreground px-1 pb-1 text-xs font-medium">Cases</legend>
            <ul className="flex flex-col gap-0.5" role="listbox" aria-label="Workspace cases">
              {primaryFiles.length === 0 ? (
                <li className="text-muted-foreground px-2 py-1 text-xs">
                  No primary case files (.raw, .xlsx, .json, .m).
                </li>
              ) : (
                primaryFiles.map((file) => {
                  const selected = file.name === selectedPrimary;
                  return (
                    <li key={file.name}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => setSelectedPrimary(file.name)}
                        className={cn(
                          'group flex w-full items-center justify-between gap-2',
                          'rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm',
                          'transition-colors duration-[var(--duration-fast)]',
                          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                          selected
                            ? 'bg-muted text-foreground'
                            : 'text-foreground hover:bg-muted/60',
                        )}
                      >
                        <span className="truncate font-mono">{file.name}</span>
                        <span className="text-muted-foreground shrink-0 font-mono text-xs">
                          {formatLabel(file.format)}
                        </span>
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </fieldset>

          {showAddfileSelector ? (
            <fieldset className="flex flex-col gap-1">
              <legend className="text-muted-foreground px-1 pb-1 text-xs font-medium">
                Dynamic file (optional)
              </legend>
              <Select
                value={selectedAddfile ?? '__none__'}
                onValueChange={(value) => setSelectedAddfile(value === '__none__' ? null : value)}
              >
                <SelectTrigger aria-label="Pair with .dyr file">
                  <SelectValue placeholder="No .dyr (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No .dyr (optional)</SelectItem>
                  {dyrFiles.map((file) => (
                    <SelectItem key={file.name} value={file.name}>
                      {file.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </fieldset>
          ) : null}

          <div className="mt-auto flex flex-col gap-2 pt-2">
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={!selectedPrimary || loadCase.isPending || creatingSession || !sessionId}
              onClick={onLoad}
            >
              {loadCase.isPending
                ? `Loading ${selectedPrimary ?? ''}…`
                : creatingSession
                  ? 'Connecting…'
                  : 'Load'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
