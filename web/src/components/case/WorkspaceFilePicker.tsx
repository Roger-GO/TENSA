import { useEffect, useMemo, useRef, useState } from 'react';
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
  const recoveryInProgress = useSessionStore((s) => s.recoveryInProgress);
  const clearRecoveryInProgress = useSessionStore((s) => s.clearRecoveryInProgress);
  const tokenPresent = useAuthStore((s) => s.token !== null);
  const createSession = useCreateSession();
  const loadCase = useLoadCase();
  // Capture the case selection once so the recovery effect can re-issue
  // ``loadCase`` against the new session id without re-rendering on every
  // selection change. A loaded session pre-recovery should land on the
  // same case post-recovery; a blank session stays blank.
  const caseSelection = useCaseStore((s) => s.selection);
  // Don't fire create-session before auth is established. A pre-auth
  // POST /api/sessions returns 401, which would race the URL-fragment
  // fast-path's setToken and wipe out the token via the global 401
  // handler. The picker is rendered behind the auth modal but its
  // hooks still run; gate the mutate() call explicitly.
  //
  // v0.1.y Unit 6 — sticky-error fix. The previous gate also tested
  // ``!createSession.isError``, which trapped the cycle once any
  // 401/404/timeout fired (the error stayed pinned and the gate stayed
  // false forever). The fix drops the ``!isError`` term: the cycle is
  // now idempotent — as long as no create is in flight, a fresh attempt
  // is allowed. The recovery effect below calls ``createSession.reset()``
  // when the recovery flag flips ``false → true`` to clear any prior
  // error before the gate re-evaluates.
  //
  // Multi-component coordination caveat: today only WorkspaceFilePicker
  // calls useEnsureSession. If a future component (e.g., a v0.2 session
  // badge) also calls it, two hook instances racing the create cycle
  // could double-fire ``POST /sessions``. Mitigation deferred — v0.1.y
  // has only one caller; the per-instance debounce below is a
  // belt-and-suspenders guard but does NOT cross instance boundaries. A
  // v0.2 implementer adding a second consumer should hoist the cycle to
  // a singleton bridge or a shared zustand action.
  const shouldCreate =
    tokenPresent && sessionId === null && !createSession.isPending;

  // Per-instance debounce: prevent rapid-fire create attempts from
  // re-render loops. Allows at most one mutate() call per second.
  // The recovery handler in queries.ts has its own module-level debounce
  // for the 404→reset path; this ref guards the create-cycle re-entry
  // inside this hook.
  const lastCreateAttemptRef = useRef<number>(0);
  const CREATE_DEBOUNCE_MS = 1_000;

  // Capture mutation status flags as primitive deps so the effect re-runs
  // on the meaningful transitions without depending on the (non-stable)
  // mutation object itself.
  const createIsError = createSession.isError;

  useEffect(() => {
    if (!shouldCreate) return;
    const now = Date.now();
    if (now - lastCreateAttemptRef.current < CREATE_DEBOUNCE_MS) return;
    lastCreateAttemptRef.current = now;
    createSession.mutate();
    // ``createIsError`` is intentional: with the Unit 6 gate change, the
    // false→true transition (error fires) re-runs this effect (debounce
    // blocks the mutate); the true→false transition (recovery effect's
    // ``reset()``) re-runs it again so a fresh attempt can fire once the
    // debounce window passes. This is the sticky-error fix — the old
    // ``!isError`` gate would have permanently blocked the second branch.
    // ``createSession`` itself is excluded from deps because TanStack
    // mutation objects are not referentially stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldCreate, createIsError]);

  // ---- recovery effect (v0.1.y Unit 5) -----------------------------------
  // When the global error-recovery handler (``wireGlobalErrorRecovery`` in
  // queries.ts) detects a 404 on a session-scoped path, it calls
  // ``useSessionStore.resetSession()``. That clears the session id AND
  // raises ``recoveryInProgress``. Below:
  //
  // 1. On the false→true transition we reset any prior ``createSession``
  //    error state. (Unit 6 dropped the ``!isError`` gate term, so a
  //    stale error no longer pins the cycle on its own; we still call
  //    ``reset()`` here to scrub the mutation's exposed ``error`` /
  //    ``isError`` so consumer UI — e.g., the createError banner below —
  //    doesn't keep showing a stale error across the recovery boundary.)
  // 2. Once the new session id is written by ``useCreateSession``'s
  //    success path, we re-issue ``loadCase`` against the previously
  //    loaded ``primaryPath`` (if any) so the new session has the case
  //    re-applied; blank sessions stay blank.
  // 3. After the re-load completes (or immediately on a blank session),
  //    we clear ``recoveryInProgress`` which auto-hides the badge.
  //
  // The effect runs entirely inside this hook instance because a global
  // QueryClient subscriber cannot directly call a hook-bound mutation
  // method like ``createSession.reset()`` — the recovery handler raises
  // a flag in the Zustand store and this effect bridges the gap.
  const recoveryReloadFiredRef = useRef(false);
  useEffect(() => {
    if (recoveryInProgress) {
      // Bridge step (1): clear any prior createSession error so the
      // shouldCreate gate above can re-evaluate true on the next render.
      // Idempotent — reset() is a no-op when already idle.
      createSession.reset();
      recoveryReloadFiredRef.current = false;
    }
    // Intentionally omit createSession from the dep list (mutation
    // objects are not referentially stable across renders, and we only
    // want to react to the recoveryInProgress edge).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryInProgress]);

  useEffect(() => {
    // Bridge steps (2) + (3): runs on every render where recovery is in
    // progress AND a fresh session id has just been written. Branches:
    //
    // - Loaded session (primaryPath !== null): fire loadCase once; on
    //   success clear recoveryInProgress.
    // - Blank session (primaryPath === null OR no selection): nothing
    //   to re-load; clear immediately.
    if (!recoveryInProgress) return;
    if (sessionId === null) return;
    if (recoveryReloadFiredRef.current) return;

    if (caseSelection === null || caseSelection.primaryPath === null) {
      // Blank session or no case loaded pre-recovery; just clear the flag.
      recoveryReloadFiredRef.current = true;
      clearRecoveryInProgress();
      return;
    }

    recoveryReloadFiredRef.current = true;
    loadCase.mutate(
      {
        sessionId,
        request: {
          primary_path: caseSelection.primaryPath,
          addfiles: caseSelection.addfiles.length > 0 ? caseSelection.addfiles : null,
        },
      },
      {
        onSettled: () => {
          // Settled rather than onSuccess so a 404/422 on the re-load
          // still drops out of the recovery state — the user sees the
          // load error surface normally rather than a stuck spinner.
          clearRecoveryInProgress();
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryInProgress, sessionId]);

  // Derive ``creating`` against the sessionId-is-null invariant so a stale
  // ``createSession.isPending`` (TanStack v5 observer desync seen in
  // StrictMode dev — the MutationCache transitions to ``success`` but the
  // hook observer can stay ``pending``) can't trap the button. Once
  // ``setSessionId`` has run on the success path, ``sessionId !== null``
  // and we are no longer ``creating`` regardless of what the observer says.
  return {
    sessionId,
    creating: createSession.isPending && sessionId === null,
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
