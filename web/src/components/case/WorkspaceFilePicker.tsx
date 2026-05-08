import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/components/shell/EmptyState';
import { ParseErrorBanner } from './ParseErrorBanner';
import { NewSystemButton } from './NewSystemButton';
import { useListWorkspaceFiles, useLoadCase, useCreateSession } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useAuthStore } from '@/store/auth';
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
  return PRIMARY_FORMATS.has(file.format as PrimaryFormat);
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
 * Hook — ensure we have a session id for the case-load mutation. The
 * parent `CaseNav` doesn't know whether one exists; the picker creates
 * one lazily on first render so the user can click "Load" without a
 * separate "Connect" step.
 *
 * If `useCreateSession` errors (e.g., 401 → caught globally), the
 * picker stays interactive but Load is disabled.
 */
function useEnsureSession(): {
  sessionId: SessionId | null;
  creating: boolean;
  createError: Error | null;
} {
  const sessionId = useSessionStore((s) => s.sessionId);
  const tokenPresent = useAuthStore((s) => s.token !== null);
  const createSession = useCreateSession();
  // Don't fire create-session before auth is established. A pre-auth
  // POST /api/sessions returns 401, which would race the URL-fragment
  // fast-path's setToken and wipe out the token via the global 401
  // handler. The picker is rendered behind the auth modal but its
  // hooks still run; gate the mutate() call explicitly.
  const shouldCreate =
    tokenPresent && sessionId === null && !createSession.isPending && !createSession.isError;

  useEffect(() => {
    if (shouldCreate) {
      createSession.mutate();
    }
    // We deliberately omit `createSession` from deps — TanStack Query
    // mutation objects are not referentially stable across renders, but
    // we only want to fire on the (token + sessionId-null + idle) edge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldCreate]);

  return {
    sessionId,
    creating: createSession.isPending,
    createError: createSession.error,
  };
}

export interface WorkspaceFilePickerProps {
  className?: string;
}

export function WorkspaceFilePicker({ className }: WorkspaceFilePickerProps) {
  const filesQuery = useListWorkspaceFiles();
  const loadCase = useLoadCase();
  const { sessionId, creating: creatingSession, createError } = useEnsureSession();
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

      {createError ? <ParseErrorBanner error={createError} onDismiss={() => {}} /> : null}

      <NewSystemButton />
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
          title="No supported case files"
          description="Place a .raw / .xlsx / .json / .m file in the workspace dir."
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
