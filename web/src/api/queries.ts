/**
 * TanStack Query v5 hooks — one per substrate endpoint.
 *
 * Conventions:
 *
 * - Query keys: `[<scope>, <id>?]` with `scope` matching the API path
 *   segment ("topology", "workspace-files", "sidecar"). Keys are exported
 *   so other hooks can invalidate by prefix.
 * - Mutations write through to the Zustand stores after a successful
 *   response (sessionId, topology, lastRun). Queries do NOT — components
 *   consume queries directly via `data` and let React reconcile.
 * - 401 handling: the queries layer detects `ProblemDetailsError` with
 *   `status === 401` in the global `QueryCache`/`MutationCache` callbacks
 *   wired in `App.tsx` (see `makeQueryClient` below). The client itself
 *   stays dumb.
 *
 * Cache invalidation rules (per the plan):
 *
 * - Case load → invalidate topology (the new case has a new topology).
 * - PF run → invalidate topology (state flips from "pre-setup" to
 *   "committed" after `ss.setup()`).
 * - Reload → invalidate topology + clear PF cache.
 * - Sidecar PUT → invalidate sidecar GET for the same case path.
 */
import { useMutation, useQuery, useQueryClient, QueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { andesClient, NetworkError, ProblemDetailsError, TIMEOUTS } from './client';
import { getAuthToken } from '@/store/auth';
import { parseSessionId, parseRunId } from './types';
import type {
  AbortResponse,
  AddDisturbancesRequest,
  AddDisturbancesResponse,
  AddElementRequest,
  AddPmuRequest,
  AlterableParamsResponse,
  BlankSystemResponse,
  ConnectivityResult,
  CpfResult,
  DisturbanceSpec,
  EditElementRequest,
  EigParticipationResponse,
  EigResult,
  ElementCreated,
  ListPmusResponse,
  LoadCaseRequest,
  ParamValue,
  PflowResult,
  SaveCaseRequest,
  SaveCaseResponse,
  SeMeasurementsGeneratedResponse,
  SeResult,
  SessionDescriptor,
  SidecarLayout,
  SessionId,
  TopologyEntry,
  TopologySchema,
  TopologySummary,
  WorkspaceFileList,
  WorkspacePath,
} from './types';
import { useAuthStore } from '@/store/auth';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useDisturbanceStore } from '@/store/disturbance';
import { useRunsStore } from '@/store/runs';
import { useAnalyzeStore } from '@/store/analyze';
import { useConnectivityStore } from '@/store/connectivity';
import { usePmuStore } from '@/store/pmu';

/**
 * Routine name accepted by ``GET /sessions/{id}/report``. Phase 1
 * (Unit 4) ships ``pflow`` + ``tds``; the substrate accepts ``eig``
 * at the schema level but rejects with 422 until Unit 6 lands. The
 * frontend type widens here so the dialog tab strip can ship the EIG
 * tab in disabled form pre-Unit-6 if the design ever wants it.
 *
 * Declared at module top so the ``queryKeys`` block (below) can
 * reference it for the ``report`` key factory.
 */
export type ReportRoutine = 'pflow' | 'tds' | 'eig';

// ---- query keys -----------------------------------------------------------

export const queryKeys = {
  sessions: ['sessions'] as const,
  session: (id: SessionId) => ['sessions', id] as const,
  topology: (id: SessionId) => ['topology', id] as const,
  workspaceFiles: ['workspace-files'] as const,
  sidecar: (casePath: WorkspacePath) => ['sidecar', casePath] as const,
  topologySchema: ['topology-schema'] as const,
  /** Alterable-params lookup, scoped per (session, model). */
  alterableParams: (id: SessionId, model: string) => ['alterable-params', id, model] as const,
  /** Report payload, scoped per (session, routine). Phase 1 (Unit 4) ships
   *  ``pflow`` + ``tds``; ``eig`` widens in Unit 6. */
  report: (id: SessionId, routine: ReportRoutine) => ['report', id, routine] as const,
  /** EIG result, scoped per session (Unit 6). */
  eig: (id: SessionId) => ['eig', id] as const,
  /** Per-mode participation factor row (Unit 6). */
  eigParticipation: (id: SessionId, modeIdx: number) =>
    ['eig-participation', id, modeIdx] as const,
  /** CPF result, scoped per session (Unit 12). */
  cpf: (id: SessionId) => ['cpf', id] as const,
  /** SE result, scoped per session (Unit 13). */
  se: (id: SessionId) => ['se', id] as const,
  /** SE measurements-generated count, scoped per session (Unit 13). */
  seMeasurements: (id: SessionId) => ['se-measurements', id] as const,
  /** Connectivity / island-detection result, scoped per session (Unit 17). */
  connectivity: (id: SessionId) => ['connectivity', id] as const,
  /** PMU placements list, scoped per session (Unit 14). */
  pmus: (id: SessionId) => ['pmus', id] as const,
} as const;

// ---- QueryClient factory --------------------------------------------------

/**
 * Construct a QueryClient with the project's defaults + the global 401
 * cascade. Exported so tests can mint their own client without the
 * cascade if they want to isolate a single hook.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          // Don't retry auth / client errors. Retry network blips once.
          if (error instanceof ProblemDetailsError) return false;
          return failureCount < 1;
        },
      },
      mutations: {
        retry: false,
      },
    },
  });
}

/**
 * Regex matching session-scoped API paths. A 404 on any of these is
 * interpreted as "the substrate doesn't know our session id any more"
 * (typical after a substrate restart, idle-timeout, or a blip that
 * reaped the worker process) and triggers the auto-recovery path. The
 * pattern intentionally allows the trailing segment to be missing so a
 * 404 on ``/api/sessions/{id}`` itself (a session-describe call) also
 * recovers.
 *
 * Non-session 404s (``/api/workspace/file/missing.raw``,
 * ``/api/topology/schema``, etc.) skip recovery and surface their error
 * normally — those are real "the resource doesn't exist" 404s, not
 * stale-session 404s.
 */
const SESSION_SCOPED_PATH_RE = /\/api\/sessions\/[^/]+(?:\/.*)?$/;

/**
 * Per-second debounce on session-recovery firings. A burst of 404s from
 * concurrent queries (e.g., topology + sidecar both fire and both 404 on a
 * stale session) should trigger only one recovery — the rest piggyback on
 * the same recovery flag and refetch against the new session id once it
 * lands. The timestamp lives at module scope (not inside the QueryClient)
 * so multiple QueryClient instances in tests don't bypass the debounce.
 */
const RECOVERY_DEBOUNCE_MS = 1000;
let lastRecoveryAttemptTs = 0;

/** Test-only helper: reset the debounce timestamp between cases. */
export function __resetRecoveryDebounceForTests(): void {
  lastRecoveryAttemptTs = 0;
}

function isSessionScopedPath(path: string | undefined): boolean {
  if (!path) return false;
  return SESSION_SCOPED_PATH_RE.test(path);
}

/**
 * Wire global error recovery on the QueryClient's caches. Two distinct
 * paths are handled here:
 *
 * 1. **401** — clear the auth store, which cascades into a full logout
 *    (session / case / pflow all cleared). The TokenPasteModal re-mounts.
 *    Idempotent against the auth-fast-path race: only clears if the user
 *    thought they were authed.
 *
 * 2. **404 on ``/api/sessions/{id}/...``** — the substrate has forgotten
 *    our session (worker restart, idle-timeout). Fire
 *    ``useSessionStore.resetSession()`` which clears the id AND raises
 *    the ``recoveryInProgress`` flag. ``useEnsureSession`` (in
 *    ``WorkspaceFilePicker``) watches the flag, calls ``mutation.reset()``
 *    locally, and the gate re-fires ``useCreateSession.mutate()`` against
 *    the new session id. Topology + sidecar queries are gated on
 *    ``sessionId !== null`` so they auto-pause during the recovery window
 *    and resume against the new id once it lands. Per-second debounced so
 *    a burst of 404s only fires recovery once.
 *
 * **Forward-compat caveat (security):** v0.1.y's recovery is safe under
 * the current "no session-revocation policy" trust model. A future SaaS
 * phase that adds server-side session revocation must inspect a
 * revocation-reason header before auto-recreating; otherwise auto-recovery
 * would defeat revocation. Not a blocker for the current local-trusted-user
 * model — see Risks in the v0.1.y plan.
 *
 * Called once from `App.tsx` after `makeQueryClient`. Tests can opt out
 * by skipping the call.
 */
/**
 * Pure handler invoked by both cache subscribers (and exported for unit
 * tests). Inspects an unknown error; if it's a recognized
 * ``ProblemDetailsError`` shape, mutates the auth or session store as
 * described above. Returns the action it took (or ``'noop'``) for
 * test assertions.
 */
export function handleGlobalRecoveryError(
  err: unknown,
): 'auth-cleared' | 'session-recovery' | 'noop' {
  if (!(err instanceof ProblemDetailsError)) return 'noop';

  if (err.status === 401) {
    // Only clear if the user thought they were authed. A 401 returned
    // for a request that fired before auth was established (e.g., a
    // query that mounted on first paint, before the URL-fragment
    // fast-path persisted the token) would otherwise wipe out the
    // token the fast-path just set. Idempotent: when the store is
    // already null, the cascade has already run.
    if (useAuthStore.getState().token !== null) {
      useAuthStore.getState().clearToken();
      return 'auth-cleared';
    }
    return 'noop';
  }

  if (err.status === 404 && isSessionScopedPath(err.requestPath)) {
    const now = Date.now();
    // Debounce: skip if we already fired a recovery within the past
    // second. The first 404 in a burst raises ``recoveryInProgress``;
    // subsequent ones are no-ops because the flag is already up.
    if (now - lastRecoveryAttemptTs < RECOVERY_DEBOUNCE_MS) return 'noop';
    const sessionState = useSessionStore.getState();
    // Don't fire recovery if we never had a session id and recovery is
    // already in flight (no point double-firing).
    if (sessionState.sessionId === null && sessionState.recoveryInProgress) return 'noop';
    // Don't loop: once recovery has failed (>3 attempts in 30s), stay
    // pinned in the failed state until tab reload.
    if (sessionState.recoveryFailed) return 'noop';
    lastRecoveryAttemptTs = now;
    sessionState.resetSession();
    return 'session-recovery';
  }

  return 'noop';
}

export function wireGlobalErrorRecovery(client: QueryClient): void {
  client.getQueryCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'error') {
      handleGlobalRecoveryError(event.action.error);
    }
  });
  client.getMutationCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'error') {
      handleGlobalRecoveryError(event.action.error);
    }
  });
}

/**
 * Backwards-compatible alias for the renamed handler. The function was
 * named ``wireGlobal401Handler`` in v0.1.x; v0.1.y renames to
 * ``wireGlobalErrorRecovery`` because it now also handles 404 stale-session
 * recovery. Kept as a re-export so any out-of-tree consumers don't break;
 * the in-tree call site in ``App.tsx`` uses the new name.
 *
 * @deprecated Use ``wireGlobalErrorRecovery``.
 */
export const wireGlobal401Handler = wireGlobalErrorRecovery;

// ---- session lifecycle -----------------------------------------------------

/** `POST /sessions` → creates a session and writes the id to the session store. */
export function useCreateSession(): UseMutationResult<SessionDescriptor, Error, void> {
  return useMutation({
    mutationFn: async () => {
      return await andesClient.post<SessionDescriptor>('/sessions', {
        body: {},
        timeoutMs: TIMEOUTS.sessionLifecycle,
      });
    },
    onSuccess: (data) => {
      useSessionStore.getState().setSessionId(parseSessionId(data.session_id));
    },
  });
}

/** `DELETE /sessions/{id}` → close a session and clear the session store. */
export function useDeleteSession(): UseMutationResult<void, Error, SessionId> {
  return useMutation({
    mutationFn: async (id: SessionId) => {
      await andesClient.delete<void>(`/sessions/${encodeURIComponent(id)}`, {
        timeoutMs: TIMEOUTS.sessionLifecycle,
      });
    },
    onSuccess: () => {
      useSessionStore.getState().clearSession();
    },
  });
}

// ---- case load + topology -------------------------------------------------

export interface LoadCaseVars {
  sessionId: SessionId;
  request: LoadCaseRequest;
}

/**
 * `POST /sessions/{id}/case`. Invalidates the topology query so the next
 * read picks up the new case.
 */
export function useLoadCase(): UseMutationResult<TopologySummary, Error, LoadCaseVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, request }: LoadCaseVars) => {
      return await andesClient.post<TopologySummary>(
        `/sessions/${encodeURIComponent(sessionId)}/case`,
        { body: request, timeoutMs: TIMEOUTS.caseLoad },
      );
    },
    onSuccess: (data, { sessionId }) => {
      // Seed the topology cache with the load response (the substrate's
      // load handler returns the topology already; saves a round-trip).
      queryClient.setQueryData(queryKeys.topology(sessionId), data);
      useCaseStore.getState().setTopology(data);
    },
  });
}

/**
 * `GET /sessions/{id}/topology`. Disabled when `sessionId` is null; the
 * caller is responsible for guarding render until the session exists.
 */
export function useTopology(sessionId: SessionId | null): UseQueryResult<TopologySummary, Error> {
  return useQuery({
    queryKey: sessionId ? queryKeys.topology(sessionId) : ['topology', 'noop'],
    enabled: sessionId !== null,
    queryFn: async () => {
      if (!sessionId) throw new Error('topology query enabled without a session id');
      return await andesClient.get<TopologySummary>(
        `/sessions/${encodeURIComponent(sessionId)}/topology`,
        { timeoutMs: TIMEOUTS.topology },
      );
    },
  });
}

/**
 * Convenience: subscribe to the current session's topology directly from
 * any component. Reads `sessionId` from the session store and forwards
 * to `useTopology`. Returns `null` when no session is active or the
 * query hasn't resolved yet — components should branch on `null` and
 * render their loading/empty state.
 *
 * The Zustand `case.topology` slot is intentionally NOT populated by
 * the load mutation; the TanStack Query cache is the canonical source
 * of truth so cache invalidation (PF run, reload) flows naturally.
 */
export function useCurrentTopology(): TopologySummary | null {
  const sessionId = useSessionStore((s) => s.sessionId);
  return useTopology(sessionId).data ?? null;
}

// ---- alterable params (Unit 1b endpoint, consumed by Unit 6 AlterSpecForm) -

/**
 * `GET /sessions/{id}/topology/models/{model}/alterable_params`. Returns
 * the ordered list of parameter names that ANDES will accept as ``src``
 * for the ``Alter`` disturbance on the given model.
 *
 * The hook is gated on a session id AND a non-empty model name; the
 * Unit 6 ``AlterSpecForm`` only fires it after the user has picked a
 * model from the dropdown, so an unmounted-while-empty render path stays
 * disabled and doesn't 404 the substrate. Long stale time — the
 * alterable-params set is a function of the model class, not the case
 * data, so it's stable across the session.
 */
export function useAlterableParams(
  model: string | null,
): UseQueryResult<AlterableParamsResponse, Error> {
  const sessionId = useSessionStore((s) => s.sessionId);
  const enabled = sessionId !== null && model !== null && model.length > 0;
  return useQuery({
    queryKey: enabled ? queryKeys.alterableParams(sessionId, model) : ['alterable-params', 'noop'],
    enabled,
    // The list is purely a function of the ANDES model class; it doesn't
    // change while the session is alive. Cache it for the session lifetime.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      if (!sessionId || !model) {
        throw new Error('useAlterableParams enabled without session or model');
      }
      return await andesClient.get<AlterableParamsResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/topology/models/${encodeURIComponent(model)}/alterable_params`,
        { timeoutMs: TIMEOUTS.topology },
      );
    },
  });
}

// ---- power flow -----------------------------------------------------------

/**
 * `POST /sessions/{id}/pflow`. Invalidates topology because PF triggers
 * `ss.setup()`, flipping the topology's `state` from "pre-setup" to
 * "committed".
 */
export function useRunPflow(): UseMutationResult<PflowResult, Error, SessionId> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: SessionId) => {
      return await andesClient.post<PflowResult>(
        `/sessions/${encodeURIComponent(sessionId)}/pflow`,
        { body: {}, timeoutMs: TIMEOUTS.pflowRun },
      );
    },
    onMutate: () => {
      usePflowStore.getState().setRunning(true);
    },
    onSuccess: (data, sessionId) => {
      usePflowStore.getState().setLastRun({
        ...data,
        run_id: parseRunId(data.run_id),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.topology(sessionId) });
    },
    onError: (err) => {
      if (err instanceof ProblemDetailsError) {
        usePflowStore.getState().setError(err);
      }
    },
    onSettled: () => {
      usePflowStore.getState().setRunning(false);
    },
  });
}

// ---- reload --------------------------------------------------------------

/**
 * `POST /sessions/{id}/reload`. Re-parses the case (full cost, not a
 * fast path); invalidates topology + clears PF cache.
 */
export function useReloadCase(): UseMutationResult<TopologySummary, Error, SessionId> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: SessionId) => {
      return await andesClient.post<TopologySummary>(
        `/sessions/${encodeURIComponent(sessionId)}/reload`,
        { body: {}, timeoutMs: TIMEOUTS.caseLoad },
      );
    },
    onSuccess: (data, sessionId) => {
      queryClient.setQueryData(queryKeys.topology(sessionId), data);
      useCaseStore.getState().setTopology(data);
      usePflowStore.getState().clearPflow();
    },
  });
}

// ---- workspace lister -----------------------------------------------------

/** `GET /workspace/files`. Stable across the tab; modest stale time.
 * Gated on `auth.token !== null` so the query doesn't fire on first
 * paint before the URL-fragment fast-path has had a chance to land
 * (which would 401, race the fast-path, and wipe the token via the
 * global 401 handler). */
export function useListWorkspaceFiles(): UseQueryResult<WorkspaceFileList, Error> {
  const tokenPresent = useAuthStore((s) => s.token !== null);
  return useQuery({
    queryKey: queryKeys.workspaceFiles,
    enabled: tokenPresent,
    queryFn: async () => {
      return await andesClient.get<WorkspaceFileList>('/workspace/files', {
        timeoutMs: TIMEOUTS.workspace,
      });
    },
  });
}

// ---- sidecar layout -------------------------------------------------------

/**
 * `GET /workspace/layout?case_path=<rel>`. Returns null on 404 (no
 * sidecar yet) — the auto-layout path takes over.
 */
export function useGetSidecar(
  casePath: WorkspacePath | null,
): UseQueryResult<SidecarLayout | null, Error> {
  return useQuery({
    queryKey: casePath ? queryKeys.sidecar(casePath) : ['sidecar', 'noop'],
    enabled: casePath !== null,
    queryFn: async () => {
      if (!casePath) throw new Error('sidecar query enabled without a case path');
      try {
        return await andesClient.get<SidecarLayout>('/workspace/layout', {
          query: { case_path: casePath },
          timeoutMs: TIMEOUTS.workspace,
        });
      } catch (err) {
        if (err instanceof ProblemDetailsError && err.status === 404) {
          return null;
        }
        throw err;
      }
    },
  });
}

export interface PutSidecarVars {
  casePath: WorkspacePath;
  layout: SidecarLayout;
}

/**
 * `PUT /workspace/layout?case_path=<rel>`. Invalidates the matching GET
 * so the next read returns the freshly-stored sidecar.
 */
export function usePutSidecar(): UseMutationResult<void, Error, PutSidecarVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ casePath, layout }: PutSidecarVars) => {
      await andesClient.put<void>('/workspace/layout', {
        query: { case_path: casePath },
        body: layout,
        timeoutMs: TIMEOUTS.workspace,
      });
    },
    onSuccess: (_data, { casePath, layout }) => {
      queryClient.setQueryData(queryKeys.sidecar(casePath), layout);
      useCaseStore.getState().setLayoutSidecar(layout);
    },
  });
}

// ---- topology mutations (Unit 2 endpoints, consumed by Units 5/6/7) ------

/**
 * `GET /topology/schema`. Per-model parameter metadata. Driven by the
 * server-side `_PARAMS_BY_MODEL` table; rarely changes — long stale time.
 */
export function useTopologySchema(): UseQueryResult<TopologySchema, Error> {
  const tokenPresent = useAuthStore((s) => s.token !== null);
  return useQuery({
    queryKey: queryKeys.topologySchema,
    enabled: tokenPresent,
    staleTime: 24 * 60 * 60 * 1000,
    queryFn: async () => {
      return await andesClient.get<TopologySchema>('/topology/schema', {
        timeoutMs: TIMEOUTS.workspace,
      });
    },
  });
}

export interface AddElementVars {
  sessionId: SessionId;
  body: AddElementRequest;
}

/**
 * `POST /sessions/{id}/elements`. Adds a new topology element. On 201,
 * invalidates the topology query so the SLD picks up the new device on
 * the next render. The optimistic-update story for `BusIdxSelect` lives
 * in Unit 6 alongside the AddElementPanel.
 */
export function useAddElement(): UseMutationResult<ElementCreated, Error, AddElementVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, body }: AddElementVars) => {
      return await andesClient.post<ElementCreated>(
        `/sessions/${encodeURIComponent(sessionId)}/elements`,
        { body, timeoutMs: TIMEOUTS.workspace },
      );
    },
    onSuccess: (_data, { sessionId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.topology(sessionId) });
    },
  });
}

export interface EditElementVars {
  sessionId: SessionId;
  model: string;
  idx: string;
  params: Record<string, ParamValue>;
}

/**
 * `PUT /sessions/{id}/elements/{model}/{idx}`. Edits one or more
 * parameters on an existing pre-setup element. Returns the updated
 * `TopologyEntry`; invalidates topology so the SLD label updates.
 */
export function useEditElement(): UseMutationResult<TopologyEntry, Error, EditElementVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, model, idx, params }: EditElementVars) => {
      const body: EditElementRequest = { params };
      return await andesClient.put<TopologyEntry>(
        `/sessions/${encodeURIComponent(sessionId)}/elements/${encodeURIComponent(model)}/${encodeURIComponent(idx)}`,
        { body, timeoutMs: TIMEOUTS.workspace },
      );
    },
    onSuccess: (_data, { sessionId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.topology(sessionId) });
    },
  });
}

export interface DeleteElementVars {
  sessionId: SessionId;
  model: string;
  idx: string;
}

/**
 * ``DELETE /sessions/{id}/elements/{model}/{idx}``. Removes a previously-
 * added pre-setup element via the substrate's reload-and-replay path.
 * Returns the post-delete ``TopologySummary`` so the SLD updates without
 * an extra GET round-trip.
 *
 * The 422 ``DeleteBlockedResponse`` (cascade dependents) and 422
 * ``ProblemDetails`` (case-file-originated, unknown model) come back as
 * thrown ``ProblemDetailsError``s — the caller (``DeleteElementButton``)
 * narrows on ``status === 422`` and reads the typed body off
 * ``error.rawBody``.
 *
 * On success: seed the topology cache with the new summary AND clear
 * ``case.selectedElement`` if the deleted element was the one being
 * inspected (otherwise the inspector's findEntry would silently render
 * a stale snapshot until the next click).
 */
export function useDeleteElement(): UseMutationResult<TopologySummary, Error, DeleteElementVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, model, idx }: DeleteElementVars) => {
      return await andesClient.delete<TopologySummary>(
        `/sessions/${encodeURIComponent(sessionId)}/elements/${encodeURIComponent(model)}/${encodeURIComponent(idx)}`,
        { timeoutMs: TIMEOUTS.workspace },
      );
    },
    onSuccess: (data, { sessionId, model, idx }) => {
      queryClient.setQueryData(queryKeys.topology(sessionId), data);
      useCaseStore.getState().setTopology(data);
      // If the deleted element was the one being inspected, fall back to
      // the "no element selected" empty state. Match by lower-cased kind
      // because SelectedElement carries the inspector taxonomy
      // ("bus"/"line"/...) while the API uses the ANDES model class
      // ("Bus"/"Line"/"PV"/...). Compare structurally on idx + a kind
      // family prefix.
      const selected = useCaseStore.getState().selectedElement;
      if (selected !== null && selected.idx === String(idx)) {
        const modelLower = model.toLowerCase();
        const kindMatchesModel =
          modelLower === selected.kind ||
          modelLower.startsWith(selected.kind) ||
          selected.kind.startsWith(modelLower);
        if (kindMatchesModel) {
          useCaseStore.getState().setSelectedElement(null);
        }
      }
      // Clear pending dependents — the cascade chain may have changed,
      // and the next 422 (if any) will repopulate the list with the
      // current truth.
      useCaseStore.getState().clearPendingDependents();
    },
  });
}

/**
 * `POST /sessions/{id}/blank`. Creates a brand-new empty `andes.System()`
 * for the session. Caller seeds the topology query cache with the
 * returned blank summary so the canvas renders the empty-state prompt
 * without an extra round-trip.
 */
export function useBlankSystem(): UseMutationResult<BlankSystemResponse, Error, SessionId> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: SessionId) => {
      return await andesClient.post<BlankSystemResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/blank`,
        { body: {}, timeoutMs: TIMEOUTS.workspace },
      );
    },
    onSuccess: (data, sessionId) => {
      queryClient.setQueryData(queryKeys.topology(sessionId), data.topology);
      useCaseStore.getState().setTopology(data.topology);
    },
  });
}

export interface SaveCaseVars {
  sessionId: SessionId;
  body: SaveCaseRequest;
}

/**
 * `POST /sessions/{id}/save`. Writes the current System to the workspace
 * as xlsx or json. ANDES 2.0 has no PSS/E .raw writer — that format is
 * read-only on this substrate. On success the workspace lister query is
 * invalidated so the new file shows up immediately in the picker.
 */
export function useSaveCase(): UseMutationResult<SaveCaseResponse, Error, SaveCaseVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, body }: SaveCaseVars) => {
      return await andesClient.post<SaveCaseResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/save`,
        { body, timeoutMs: TIMEOUTS.workspace },
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceFiles });
    },
  });
}

/**
 * `POST /sessions/{id}/undo-last-edit`. Drops the last add() and
 * rebuilds the System from the remaining replay-buffer history. Returns
 * the post-undo topology snapshot, which we seed into the topology
 * cache so the SLD updates without a re-fetch round-trip.
 */
export function useUndoLastEdit(): UseMutationResult<TopologySummary, Error, SessionId> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: SessionId) => {
      return await andesClient.post<TopologySummary>(
        `/sessions/${encodeURIComponent(sessionId)}/undo-last-edit`,
        { body: {}, timeoutMs: TIMEOUTS.workspace },
      );
    },
    onSuccess: (data, sessionId) => {
      queryClient.setQueryData(queryKeys.topology(sessionId), data);
      useCaseStore.getState().setTopology(data);
    },
  });
}

// ---- TDS run lifecycle (Unit 7) -------------------------------------------

export interface CommitDisturbancesVars {
  sessionId: SessionId;
  /** Local disturbance specs to commit. Caller MUST ensure ``length >= 1`` —
   *  the substrate's ``AddDisturbancesRequest`` has ``min_length=1`` and
   *  rejects an empty list with 422. The Unit 7 RunButton path skips this
   *  call entirely when the local list is empty. */
  disturbances: readonly DisturbanceSpec[];
}

/**
 * ``POST /sessions/{id}/disturbances``. Commits the local disturbance
 * editor list to the substrate ahead of a TDS run. On 201, the
 * disturbance slice's ``markCommitted`` flag is flipped so the UI
 * reflects "in sync". 422 surfaces as a thrown ``ProblemDetailsError`` —
 * the caller (Unit 7's RunButton) inspects the error and shows it on the
 * failing disturbance row rather than as a global toast.
 */
export function useCommitDisturbances(): UseMutationResult<
  AddDisturbancesResponse,
  Error,
  CommitDisturbancesVars
> {
  return useMutation({
    mutationFn: async ({ sessionId, disturbances }: CommitDisturbancesVars) => {
      const body: AddDisturbancesRequest = {
        // Spread to convert ``readonly`` into a mutable array shape so the
        // generated type's mutable ``disturbances`` field accepts it.
        disturbances: [...disturbances],
      };
      return await andesClient.post<AddDisturbancesResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/disturbances`,
        { body, timeoutMs: TIMEOUTS.workspace },
      );
    },
    onSuccess: () => {
      useDisturbanceStore.getState().markCommitted();
    },
  });
}

/**
 * ``POST /sessions/{id}/abort`` (Unit 1b endpoint). Signals the worker to
 * cooperatively halt the active TDS run at the next ``callpert`` tick.
 * The actual stream end is asynchronous — the WS emits the terminal
 * ``done`` message with ``final_t < tf`` once the integration loop exits.
 *
 * On a successful HTTP response, the active run's ``abortedLocally`` flag
 * is set to true so the runs slice can distinguish user-initiated abort
 * from numerical instability when the eventual ``done`` arrives (see Unit
 * 7's state-inference rules).
 */
export function useAbortRun(): UseMutationResult<AbortResponse, Error, SessionId> {
  return useMutation({
    mutationFn: async (sessionId: SessionId) => {
      return await andesClient.post<AbortResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/abort`,
        { body: {}, timeoutMs: TIMEOUTS.sessionLifecycle },
      );
    },
    onSuccess: () => {
      const activeRunId = useRunsStore.getState().activeRunId;
      if (activeRunId !== null) {
        useRunsStore.getState().setAbortedLocally(activeRunId, true);
      }
    },
  });
}

/**
 * ``POST /sessions/{id}/reload`` wrapped for the v0.2 "Reset run" affordance.
 * Same wire endpoint as ``useReloadCase`` but with different post-success
 * cleanup tailored to the TDS run lifecycle:
 *
 * - Drop the active run's frame buffer (``runs.resetRun(activeRunId)``).
 * - Clear the disturbance commit flag (the substrate's reload threw away
 *   the committed disturbance list; the timeline editor's local list is
 *   preserved per the v0.2 plan's Open Questions decision so the user can
 *   retry without redefining everything).
 * - Invalidate topology + clear PF cache (mirrors ``useReloadCase`` because
 *   the underlying endpoint is the same).
 */
export function useResetRun(): UseMutationResult<TopologySummary, Error, SessionId> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: SessionId) => {
      return await andesClient.post<TopologySummary>(
        `/sessions/${encodeURIComponent(sessionId)}/reload`,
        { body: {}, timeoutMs: TIMEOUTS.caseLoad },
      );
    },
    onSuccess: (data, sessionId) => {
      queryClient.setQueryData(queryKeys.topology(sessionId), data);
      useCaseStore.getState().setTopology(data);
      usePflowStore.getState().clearPflow();
      const activeRunId = useRunsStore.getState().activeRunId;
      if (activeRunId !== null) {
        useRunsStore.getState().resetRun(activeRunId);
      }
      // Disturbance timeline list is preserved (per the plan's Open
      // Questions decision); only the "committed against substrate" flag
      // is reset so the next Run TDS re-commits the (possibly-edited)
      // local list.
      useDisturbanceStore.setState({ committed: false, dirty: true });
    },
  });
}

// ---- bundle export (Unit 3) -----------------------------------------------

export interface ExportBundleVars {
  sessionId: SessionId;
  /**
   * Request body forwarded to ``POST /api/sessions/{id}/bundle/export``.
   * The substrate accepts an empty body (``{}``) and produces a minimal
   * bundle (case + manifest only); callers typically populate
   * ``disturbances`` / ``sim_params`` / ``results_csv`` from their local
   * state so the bundle is reproducibility-grade.
   */
  body: {
    disturbances?: readonly { kind: string }[];
    sim_params?: Record<string, unknown> | null;
    results_csv?: string | null;
    run_id?: string | null;
  };
}

/**
 * ``POST /api/sessions/{id}/bundle/export``.
 *
 * Returns a ``Blob`` of the assembled ``.zip`` body — the caller is
 * responsible for triggering the browser download (typically via the
 * ``downloadBlob`` helper from ``components/export/downloadBlob.ts``).
 *
 * The default ``andesClient.post`` parses the response as JSON; the
 * bundle endpoint returns ``application/zip``, so we bypass the
 * client and call ``fetch`` directly. We still honor the project's
 * auth header + ``ProblemDetailsError`` taxonomy so the global 401
 * cascade and the in-dialog error inline path work the same way as
 * every other mutation.
 */
export function useExportBundle(): UseMutationResult<Blob, Error, ExportBundleVars> {
  return useMutation({
    mutationFn: async ({ sessionId, body }: ExportBundleVars) => {
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/bundle/export`;
      const headers = new Headers();
      const token = getAuthToken();
      if (token) headers.set('X-Andes-Token', token);
      headers.set('Content-Type', 'application/json');

      // 60s timeout matches `caseLoad` — bundle assembly does at most one
      // canonical xlsx export, which is the same order of magnitude as a
      // case load.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.caseLoad);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        throw new NetworkError(`Network error on POST ${url}`, err);
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        // Error body is JSON ProblemDetails — read it through the same
        // path the regular client uses so the global 401 / 404 cascade
        // recognises the shape.
        let parsed: unknown = undefined;
        try {
          parsed = await response.json();
        } catch {
          // ignore
        }
        const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
        const problem = {
          type: typeof obj.type === 'string' ? obj.type : 'about:blank',
          title: typeof obj.title === 'string' ? obj.title : `HTTP ${response.status}`,
          status: typeof obj.status === 'number' ? obj.status : response.status,
          detail: typeof obj.detail === 'string' ? obj.detail : null,
          instance: typeof obj.instance === 'string' ? obj.instance : null,
        };
        throw new ProblemDetailsError(problem, parsed, url);
      }

      return await response.blob();
    },
  });
}

// ---- snapshot save/load (Unit 7) ------------------------------------------

/** Sidecar-JSON shape echoed in save/restore/list responses. */
export interface SnapshotMetadata {
  andes_version: string;
  andes_app_version: string;
  case_filename: string | null;
  case_sha256: string | null;
  disturbance_log: readonly Record<string, unknown>[];
  saved_at: string;
  has_pflow: boolean;
  has_tds: boolean;
}

/** Response of ``POST /sessions/{id}/snapshot``. */
export interface SaveSnapshotResponse {
  name: string;
  metadata: SnapshotMetadata;
  dill_bytes: number;
  metadata_bytes: number;
}

/** Response of ``POST /sessions/{id}/snapshot/restore``. */
export interface RestoreSnapshotResponse {
  used_dill: boolean;
  fallback_reason: string | null;
  disturbances_replayed: number;
  metadata: SnapshotMetadata;
}

/** One entry of the ``GET /sessions/{id}/snapshots`` response. */
export interface SnapshotListEntry {
  name: string;
  saved_at: string;
  has_pflow: boolean;
  has_tds: boolean;
  has_dill: boolean;
  andes_version: string;
  disturbance_count: number;
}

/** Response shape of ``GET /sessions/{id}/snapshots``. */
export interface ListSnapshotsResponse {
  snapshots: readonly SnapshotListEntry[];
}

export interface SaveSnapshotVars {
  sessionId: SessionId;
  name: string;
  /** When True, overwrite an existing snapshot under the same name. */
  force?: boolean;
}

export interface RestoreSnapshotVars {
  sessionId: SessionId;
  name: string;
  /** When True (default), use the dill fast path. */
  useDillOptimization?: boolean;
}

export interface DeleteSnapshotVars {
  sessionId: SessionId;
  name: string;
}

/** Query-key factory for the snapshot listing. Exported so the snapshot
 *  mutations (save / restore / delete) can invalidate it on success. */
function snapshotsKey(sessionId: SessionId) {
  return ['snapshots', sessionId] as const;
}

/**
 * ``POST /sessions/{id}/snapshot`` — save the current operating point.
 *
 * On success, invalidates the snapshot listing so a re-open of the
 * load dialog picks up the new entry without a manual refetch.
 */
export function useSaveSnapshot(): UseMutationResult<
  SaveSnapshotResponse,
  Error,
  SaveSnapshotVars
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, name, force }: SaveSnapshotVars) => {
      return await andesClient.post<SaveSnapshotResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/snapshot`,
        {
          body: { name, force: force ?? false },
          timeoutMs: TIMEOUTS.caseLoad,
        },
      );
    },
    onSuccess: (_data, { sessionId }) => {
      void queryClient.invalidateQueries({ queryKey: snapshotsKey(sessionId) });
    },
  });
}

/**
 * ``POST /sessions/{id}/snapshot/restore`` — restore a saved snapshot.
 *
 * On success, invalidates session-scoped caches that the restore
 * mutated under the hood (topology, pflow, EIG) so the UI re-fetches
 * the post-restore state without a stale render.
 */
export function useRestoreSnapshot(): UseMutationResult<
  RestoreSnapshotResponse,
  Error,
  RestoreSnapshotVars
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      sessionId,
      name,
      useDillOptimization,
    }: RestoreSnapshotVars) => {
      return await andesClient.post<RestoreSnapshotResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/snapshot/restore`,
        {
          body: {
            name,
            use_dill_optimization: useDillOptimization ?? true,
          },
          timeoutMs: TIMEOUTS.caseLoad,
        },
      );
    },
    onSuccess: (_data, { sessionId }) => {
      // Restore swaps the System; every session-scoped query is now
      // potentially stale. Invalidate the broad set rather than
      // hand-list each one — a snapshot restore is a rare operation
      // so the over-invalidation cost is fine.
      void queryClient.invalidateQueries({ queryKey: queryKeys.topology(sessionId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.eig(sessionId) });
      // Disturbance log is reset by the restore; tell the disturbance
      // store to mark itself dirty so the next TDS run re-syncs.
      useDisturbanceStore.setState({ committed: false, dirty: true });
    },
  });
}

/**
 * ``GET /sessions/{id}/snapshots`` — list snapshots for the current case.
 *
 * Gating: enabled only when a session is active. Returns an empty list
 * when no snapshots have been saved against the case yet.
 */
export function useListSnapshots(): UseQueryResult<ListSnapshotsResponse, Error> {
  const sessionId = useSessionStore((s) => s.sessionId);
  const enabled = sessionId !== null;
  return useQuery({
    queryKey: enabled ? snapshotsKey(sessionId) : ['snapshots', 'noop'],
    enabled,
    staleTime: 10_000,
    queryFn: async () => {
      if (!sessionId) {
        throw new Error('useListSnapshots enabled without a session id');
      }
      return await andesClient.get<ListSnapshotsResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/snapshots`,
        { timeoutMs: TIMEOUTS.workspace },
      );
    },
  });
}

/**
 * ``DELETE /sessions/{id}/snapshot/{name}`` — remove a snapshot.
 *
 * On success, invalidates the listing so the load dialog rerenders
 * without the deleted entry.
 */
export function useDeleteSnapshot(): UseMutationResult<
  void,
  Error,
  DeleteSnapshotVars
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, name }: DeleteSnapshotVars) => {
      await andesClient.delete<unknown>(
        `/sessions/${encodeURIComponent(sessionId)}/snapshot/${encodeURIComponent(name)}`,
        { timeoutMs: TIMEOUTS.workspace },
      );
    },
    onSuccess: (_data, { sessionId }) => {
      void queryClient.invalidateQueries({ queryKey: snapshotsKey(sessionId) });
    },
  });
}

// ---- reports (Unit 4) -----------------------------------------------------

/** One tabular block in a routine's structured report. */
export interface ReportTable {
  title: string;
  headers: readonly string[];
  rows: readonly (readonly string[])[];
}

/** Response shape of ``GET /api/sessions/{id}/report``. */
export interface ReportResponse {
  routine: ReportRoutine;
  plain_text: string;
  structured: { tables: readonly ReportTable[] };
}

/**
 * ``GET /api/sessions/{id}/report?routine=...`` — fetches a routine's
 * report payload.
 *
 * Gating: enabled only when (a) a session is active AND (b) the
 * relevant routine has produced a result on the current session. The
 * caller passes the precomputed ``hasRunResult`` flag so this hook
 * doesn't need to subscribe to two stores; the dialog component owns
 * the gating logic.
 *
 * On 409 (no PF/TDS run yet), the error surfaces as a
 * ``ProblemDetailsError`` whose ``status`` the dialog inspects to
 * render the empty-state instead of the error banner.
 *
 * The ``staleTime`` is short (10 s) so a fresh PF/TDS run invalidates
 * naturally as the user re-opens the dialog. Components can also call
 * ``queryClient.invalidateQueries({ queryKey: ['report', id, routine] })``
 * after the run mutation lands to force a refetch.
 */
export function useReport(
  routine: ReportRoutine,
  hasRunResult: boolean,
): UseQueryResult<ReportResponse, Error> {
  const sessionId = useSessionStore((s) => s.sessionId);
  const enabled = sessionId !== null && hasRunResult;
  return useQuery({
    queryKey: enabled ? queryKeys.report(sessionId, routine) : ['report', 'noop', routine],
    enabled,
    staleTime: 10_000,
    queryFn: async () => {
      if (!sessionId) {
        throw new Error('useReport enabled without a session id');
      }
      return await andesClient.get<ReportResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/report`,
        { query: { routine }, timeoutMs: TIMEOUTS.workspace },
      );
    },
  });
}

// ---- EIG (Unit 6) ---------------------------------------------------------

/**
 * ``POST /api/sessions/{id}/eig`` — runs eigenvalue analysis.
 *
 * On success: writes through to ``useAnalyzeStore.setEigResult`` so
 * EIGScatter / EIGParticipationTable / EIGDampingChart can read
 * synchronously, and seeds the TanStack Query cache so hooks reading
 * via ``queryKeys.eig`` see the same value.
 *
 * Errors:
 *
 * - 409 ``EigPrerequisiteError`` — substrate gates on
 *   ``ss.PFlow.converged`` independently (see Unit 1a spike). The
 *   AnalyzePanel catches this and shows a "Run PFlow first" empty
 *   state.
 * - 422 ``EigComputationError`` — ANDES routine raised (singular
 *   Jacobian after regularization, etc.); surfaced as a banner.
 */
export function useEigRun(): UseMutationResult<EigResult, Error, SessionId> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: SessionId) => {
      return await andesClient.post<EigResult>(
        `/sessions/${encodeURIComponent(sessionId)}/eig`,
        { body: {}, timeoutMs: TIMEOUTS.pflowRun },
      );
    },
    onSuccess: (data, sessionId) => {
      useAnalyzeStore.getState().setEigResult(data);
      queryClient.setQueryData(queryKeys.eig(sessionId), data);
    },
  });
}

/**
 * ``GET /api/sessions/{id}/eig/modes/{modeIdx}/participation`` —
 * per-mode participation factor row.
 *
 * Gating: enabled only when (a) a session is active AND (b) the
 * caller has selected a non-null mode. The store's ``selectedModeId``
 * provides the trigger; consumers pass it through.
 *
 * Cache key includes ``modeIdx`` so switching modes triggers a fresh
 * fetch; the result is cached per-mode so re-clicking the same
 * eigenvalue is instant.
 */
export function useEigParticipation(
  modeIdx: number | null,
): UseQueryResult<EigParticipationResponse, Error> {
  const sessionId = useSessionStore((s) => s.sessionId);
  const enabled = sessionId !== null && modeIdx !== null;
  return useQuery({
    queryKey:
      enabled && sessionId !== null && modeIdx !== null
        ? queryKeys.eigParticipation(sessionId, modeIdx)
        : ['eig-participation', 'noop'],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      if (!sessionId || modeIdx === null) {
        throw new Error('useEigParticipation enabled without session/mode');
      }
      return await andesClient.get<EigParticipationResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/eig/modes/${modeIdx}/participation`,
        { timeoutMs: TIMEOUTS.workspace },
      );
    },
  });
}

// ---- CPF (Unit 12 — continuation power flow) -----------------------------

/** Request body shape for ``POST /api/sessions/{id}/cpf``. */
export interface CpfRunVars {
  sessionId: SessionId;
  /** ``'load'`` (default) scales loads up; ``'gen'`` scales generation up. */
  direction?: 'load' | 'gen';
  /** Optional initial continuation step size (passes to ``CPF.config.step``). */
  step?: number;
  /**
   * Optional cap on the number of continuation steps. Maps onto
   * ANDES's ``CPF.config.max_steps`` (which controls truncation; the
   * ANDES ``max_iter`` config is corrector iterations per step, not
   * total steps).
   */
  maxIter?: number;
}

/** Request body shape for ``POST /api/sessions/{id}/cpf/qv``. */
export interface CpfQvRunVars {
  sessionId: SessionId;
  /** Bus idx to draw the QV-curve at (must have a PQ device). */
  busIdx: string;
  /** Optional reactive-power range; ANDES default is 5.0. */
  qRange?: number;
}

/**
 * ``POST /api/sessions/{id}/cpf`` — runs continuation power flow
 * (PV-curve / nose-curve) on the session.
 *
 * On success: writes through to ``useAnalyzeStore.setCpfResult`` so
 * ``CPFCurveChart`` can read synchronously; seeds the TanStack Query
 * cache so hooks reading via ``queryKeys.cpf`` see the same value.
 *
 * Errors:
 *
 * - 409 ``CpfPrerequisiteError`` — substrate gates on
 *   ``ss.PFlow.converged`` independently (per Unit 1a spike). The
 *   AnalyzePanel catches this and shows a "Run PFlow first" empty
 *   state with a CTA back to the PF view.
 * - 422 ``CpfDivergedError`` — ANDES routine raised; surfaced as a
 *   banner.
 *
 * Note: a clean ``False`` return from ``ss.CPF.run`` (e.g., hit
 * ``max_steps`` before nose) does NOT raise — the response carries
 * ``truncated=true`` and ``nose_idx=-1`` so the UI can render the
 * truncation note inline rather than as an error.
 */
export function useCpfRun(): UseMutationResult<CpfResult, Error, CpfRunVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, direction, step, maxIter }: CpfRunVars) => {
      const body: Record<string, unknown> = {
        direction: direction ?? 'load',
      };
      if (step !== undefined) body.step = step;
      if (maxIter !== undefined) body.max_iter = maxIter;
      return await andesClient.post<CpfResult>(
        `/sessions/${encodeURIComponent(sessionId)}/cpf`,
        // CPF can take longer than PF (multi-step continuation); reuse
        // the case-load timeout (60s) which sits comfortably above the
        // ~3 s observed for IEEE 14 with default config.
        { body, timeoutMs: TIMEOUTS.caseLoad },
      );
    },
    onSuccess: (data, { sessionId }) => {
      useAnalyzeStore.getState().setCpfResult(data);
      queryClient.setQueryData(queryKeys.cpf(sessionId), data);
    },
  });
}

/**
 * ``POST /api/sessions/{id}/cpf/qv`` — runs a single-bus QV-curve
 * continuation. Same wire-shape response as ``useCpfRun``; the
 * ``mode`` discriminator on the result is ``"qv"`` so the chart
 * labels the X-axis "Q (pu)" instead of "lambda".
 */
export function useCpfQvRun(): UseMutationResult<CpfResult, Error, CpfQvRunVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, busIdx, qRange }: CpfQvRunVars) => {
      const body: Record<string, unknown> = { bus_idx: busIdx };
      if (qRange !== undefined) body.q_range = qRange;
      return await andesClient.post<CpfResult>(
        `/sessions/${encodeURIComponent(sessionId)}/cpf/qv`,
        { body, timeoutMs: TIMEOUTS.caseLoad },
      );
    },
    onSuccess: (data, { sessionId }) => {
      useAnalyzeStore.getState().setCpfResult(data);
      queryClient.setQueryData(queryKeys.cpf(sessionId), data);
    },
  });
}

// ---- SE (Unit 13 — state estimation) -------------------------------------

/** Request body shape for ``POST /api/sessions/{id}/se/measurements/generate``. */
export interface SeGenerateMeasurementsVars {
  sessionId: SessionId;
  /** Optional integer seed for the Gaussian noise draw. */
  noiseSeed?: number;
}

/**
 * ``POST /api/sessions/{id}/se/measurements/generate`` — builds the
 * default measurement set (bus voltages + bus injections) from the
 * converged PF solution and caches it on the substrate worker.
 *
 * On success: writes the count through to
 * ``useAnalyzeStore.setSeMeasurementsCount`` so the AnalyzePanel can
 * enable the "Run SE" button and show the headline count; seeds the
 * TanStack Query cache so consumers reading via ``queryKeys.seMeasurements``
 * see the same value.
 *
 * Errors:
 *
 * - 409 ``SePrerequisiteError`` — substrate gates on
 *   ``ss.PFlow.converged`` independently (per Unit 1a spike). The
 *   AnalyzePanel catches this and shows a "Run PFlow first" empty
 *   state with a CTA back to the PF view.
 * - 422 — measurement-generation failure (rare; usually a model
 *   lookup raised inside ``add_bus_injection``).
 */
export function useSeGenerateMeasurements(): UseMutationResult<
  SeMeasurementsGeneratedResponse,
  Error,
  SeGenerateMeasurementsVars
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, noiseSeed }: SeGenerateMeasurementsVars) => {
      const body: Record<string, unknown> = {};
      if (noiseSeed !== undefined) body.noise_seed = noiseSeed;
      return await andesClient.post<SeMeasurementsGeneratedResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/se/measurements/generate`,
        { body, timeoutMs: TIMEOUTS.pflowRun },
      );
    },
    onSuccess: (data, { sessionId }) => {
      useAnalyzeStore.getState().setSeMeasurementsCount(data.count);
      // Generating fresh measurements invalidates any prior SE result —
      // the residuals would be measured against the old z values.
      useAnalyzeStore.getState().setSeResult(null);
      queryClient.setQueryData(queryKeys.seMeasurements(sessionId), data);
    },
  });
}

/**
 * ``POST /api/sessions/{id}/se`` — runs static state estimation
 * against the substrate's cached measurement set.
 *
 * On success: writes through to ``useAnalyzeStore.setSeResult`` so
 * ``SEResidualChart`` can read synchronously; seeds the TanStack
 * Query cache so consumers reading via ``queryKeys.se`` see the same
 * value.
 *
 * Errors:
 *
 * - 409 ``SePrerequisiteError`` — either no converged PF or no cached
 *   measurement set yet. The AnalyzePanel catches both and shows the
 *   appropriate empty-state CTA.
 * - 422 ``SeUnderDeterminedError`` — measurement set has insufficient
 *   redundancy (gain matrix singular).
 * - 422 ``SeNonConvergentError`` — WLS Gauss-Newton hit max_iter.
 */
export function useSeRun(): UseMutationResult<SeResult, Error, SessionId> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: SessionId) => {
      return await andesClient.post<SeResult>(
        `/sessions/${encodeURIComponent(sessionId)}/se`,
        // SE iteration cost is comparable to PF; reuse the PF-run timeout.
        { body: {}, timeoutMs: TIMEOUTS.pflowRun },
      );
    },
    onSuccess: (data, sessionId) => {
      useAnalyzeStore.getState().setSeResult(data);
      queryClient.setQueryData(queryKeys.se(sessionId), data);
    },
  });
}

// ---- Connectivity (Unit 17 — island detection) ---------------------------

/**
 * ``GET /api/sessions/{id}/connectivity`` — runs ANDES's
 * ``ss.connectivity()`` and returns the per-island bus membership.
 *
 * **Manual trigger only.** Per the v2.0 plan's Unit 17 auto-fix, this
 * is post-run only — no auto-refetch on TDS frame, no streaming
 * integration. The user clicks "Recompute connectivity" on the SLD
 * overlay to fire the underlying ``refetch``; in between fires the
 * cached result drives the SLD's grey-out overlay.
 *
 * Gating: ``enabled: false`` so the query never auto-fires; consumers
 * call ``query.refetch()`` from a button click. Gated additionally on
 * ``sessionId !== null`` so an unauthenticated client never even
 * carries a real query key.
 *
 * On success: writes through to ``useConnectivityStore.setResult``
 * (which derives the energised-bus set in one update so BusNode reads
 * stay O(1)). The TanStack Query cache also seeds ``queryKeys.connectivity``
 * for any other consumer that wants the raw payload.
 *
 * Errors:
 *
 * - 409 — no case loaded yet on the session. The SLD overlay catches
 *   this and disables the button before the click; the response is a
 *   defence-in-depth fallback.
 * - 422 — ``SetupFailedError`` from the wrapper; the recovery hint
 *   ("call POST /reload") is in the response body.
 */
export function useConnectivity(): UseQueryResult<ConnectivityResult, Error> {
  const sessionId = useSessionStore((s) => s.sessionId);
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: sessionId
      ? queryKeys.connectivity(sessionId)
      : ['connectivity', 'noop'],
    // Manual-trigger only: never auto-fire. The SLD's "Recompute
    // connectivity" button calls ``query.refetch()``.
    enabled: false,
    queryFn: async () => {
      if (!sessionId) {
        throw new Error('useConnectivity refetched without a session');
      }
      const data = await andesClient.get<ConnectivityResult>(
        `/sessions/${encodeURIComponent(sessionId)}/connectivity`,
        { timeoutMs: TIMEOUTS.workspace },
      );
      // Mirror into the Zustand store (the SLD reads from here for
      // O(1) per-bus checks; the query cache stays the source of
      // truth for re-fetches and any downstream consumer).
      useConnectivityStore.getState().setResult(data);
      queryClient.setQueryData(queryKeys.connectivity(sessionId), data);
      return data;
    },
  });
}

// ---- PMU placement (Unit 14) ---------------------------------------------

export interface AddPmuVars {
  sessionId: SessionId;
  /** Body forwarded to ``POST /sessions/{id}/pmu``. */
  body: AddPmuRequest;
}

/**
 * ``POST /api/sessions/{id}/pmu`` — place a PMU at the given bus
 * pre-setup. On success: append the new entry to the PMU slice +
 * invalidate the listPmus query so any other consumer sees the
 * placement without an extra round-trip.
 *
 * Errors:
 *
 * - 409 — session committed; caller surfaces a "reload to recover"
 *   banner.
 * - 422 — bus does not exist OR ANDES rejected the add.
 */
export function useAddPmu(): UseMutationResult<TopologyEntry, Error, AddPmuVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, body }: AddPmuVars) => {
      return await andesClient.post<TopologyEntry>(
        `/sessions/${encodeURIComponent(sessionId)}/pmu`,
        { body, timeoutMs: TIMEOUTS.workspace },
      );
    },
    onSuccess: (data, { sessionId }) => {
      usePmuStore.getState().appendPmu(data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.pmus(sessionId) });
      // The PMU also lives in the topology bucket (controllers) — a
      // fresh placement should refresh the SLD's controller layer.
      void queryClient.invalidateQueries({ queryKey: queryKeys.topology(sessionId) });
    },
  });
}

/**
 * ``GET /api/sessions/{id}/pmu`` — list every PMU on the session.
 * Empty list when none placed (the common case for a fresh load).
 *
 * On success: writes through to the PMU slice so non-Query consumers
 * (the placement dialog list, the SLD overlay) read synchronously.
 */
export function useListPmus(): UseQueryResult<ListPmusResponse, Error> {
  const sessionId = useSessionStore((s) => s.sessionId);
  const queryClient = useQueryClient();
  const enabled = sessionId !== null;
  return useQuery({
    queryKey: enabled ? queryKeys.pmus(sessionId) : ['pmus', 'noop'],
    enabled,
    staleTime: 10_000,
    queryFn: async () => {
      if (!sessionId) {
        throw new Error('useListPmus enabled without a session id');
      }
      const data = await andesClient.get<ListPmusResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/pmu`,
        { timeoutMs: TIMEOUTS.workspace },
      );
      // Mirror into the Zustand store so the placement dialog reads
      // synchronously; the query cache stays the source of truth for
      // re-fetches / cache invalidation.
      usePmuStore.getState().setPmus(data.pmus);
      queryClient.setQueryData(queryKeys.pmus(sessionId), data);
      return data;
    },
  });
}

export interface DeletePmuVars {
  sessionId: SessionId;
  /** ANDES idx of the PMU (e.g., ``"PMU_1"``). */
  idx: string;
}

/**
 * ``DELETE /api/sessions/{id}/pmu/{idx}`` — remove a PMU pre-setup.
 *
 * On success: drop the entry from the PMU slice + invalidate the
 * listPmus query so any other consumer sees the removal without
 * waiting for a refetch.
 *
 * Errors:
 *
 * - 404 — unknown PMU idx.
 * - 409 — session committed; caller must reload first.
 */
export function useDeletePmu(): UseMutationResult<void, Error, DeletePmuVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, idx }: DeletePmuVars) => {
      await andesClient.delete<unknown>(
        `/sessions/${encodeURIComponent(sessionId)}/pmu/${encodeURIComponent(idx)}`,
        { timeoutMs: TIMEOUTS.workspace },
      );
    },
    onSuccess: (_data, { sessionId, idx }) => {
      usePmuStore.getState().removePmu(idx);
      void queryClient.invalidateQueries({ queryKey: queryKeys.pmus(sessionId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.topology(sessionId) });
    },
  });
}

export interface ExportPmuCsvVars {
  sessionId: SessionId;
  /**
   * Run identifier — opaque on the substrate side (the substrate
   * exposes only the latest ``ss.dae.ts``); used to name the
   * downloaded file and the ``Content-Disposition`` header.
   */
  runId: string;
}

/**
 * ``GET /api/sessions/{id}/pmu/{run_id}/export.csv`` — download the
 * PMU am/vm CSV for the most recent TDS run.
 *
 * Returns a ``Blob`` of the CSV body — the caller is responsible for
 * triggering the browser download (typically via ``downloadBlob`` from
 * ``components/export/downloadBlob.ts``).
 *
 * The default ``andesClient.get`` parses JSON; this endpoint returns
 * ``text/csv``, so we bypass the client and call ``fetch`` directly.
 * We still honour the project's auth header + ``ProblemDetailsError``
 * taxonomy so the global 401 cascade and the in-dialog error inline
 * path work the same way as every other mutation.
 */
export function useExportPmuCsv(): UseMutationResult<Blob, Error, ExportPmuCsvVars> {
  return useMutation({
    mutationFn: async ({ sessionId, runId }: ExportPmuCsvVars) => {
      const url =
        `/api/sessions/${encodeURIComponent(sessionId)}/pmu/` +
        `${encodeURIComponent(runId)}/export.csv`;
      const headers = new Headers();
      const token = getAuthToken();
      if (token) headers.set('X-Andes-Token', token);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.workspace);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        throw new NetworkError(`Network error on GET ${url}`, err);
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        let parsed: unknown = undefined;
        try {
          parsed = await response.json();
        } catch {
          // ignore
        }
        const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<
          string,
          unknown
        >;
        const problem = {
          type: typeof obj.type === 'string' ? obj.type : 'about:blank',
          title: typeof obj.title === 'string' ? obj.title : `HTTP ${response.status}`,
          status: typeof obj.status === 'number' ? obj.status : response.status,
          detail: typeof obj.detail === 'string' ? obj.detail : null,
          instance: typeof obj.instance === 'string' ? obj.instance : null,
        };
        throw new ProblemDetailsError(problem, parsed, url);
      }

      return await response.blob();
    },
  });
}
