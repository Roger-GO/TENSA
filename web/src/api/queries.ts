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
import { andesClient, ProblemDetailsError, TIMEOUTS } from './client';
import { parseSessionId, parseRunId } from './types';
import type {
  AddElementRequest,
  BlankSystemResponse,
  EditElementRequest,
  ElementCreated,
  LoadCaseRequest,
  ParamValue,
  PflowResult,
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

// ---- query keys -----------------------------------------------------------

export const queryKeys = {
  sessions: ['sessions'] as const,
  session: (id: SessionId) => ['sessions', id] as const,
  topology: (id: SessionId) => ['topology', id] as const,
  workspaceFiles: ['workspace-files'] as const,
  sidecar: (casePath: WorkspacePath) => ['sidecar', casePath] as const,
  topologySchema: ['topology-schema'] as const,
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
 * Wire global 401 handling on the QueryClient's caches. On any
 * `ProblemDetailsError` with status 401, clear the auth store. The auth
 * store's clear cascade then unwinds session / case / pflow.
 *
 * Called once from `App.tsx` after `makeQueryClient`. Tests can opt out
 * by skipping the call.
 */
export function wireGlobal401Handler(client: QueryClient): void {
  const handle = (err: unknown): void => {
    if (err instanceof ProblemDetailsError && err.status === 401) {
      // Only clear if the user thought they were authed. A 401 returned
      // for a request that fired before auth was established (e.g., a
      // query that mounted on first paint, before the URL-fragment
      // fast-path persisted the token) would otherwise wipe out the
      // token the fast-path just set. Idempotent: when the store is
      // already null, the cascade has already run.
      if (useAuthStore.getState().token !== null) {
        useAuthStore.getState().clearToken();
      }
    }
  };
  client.getQueryCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'error') {
      handle(event.action.error);
    }
  });
  client.getMutationCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'error') {
      handle(event.action.error);
    }
  });
}

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
