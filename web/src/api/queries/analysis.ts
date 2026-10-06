/**
 * The analysis routines on a solved power flow: eigenvalues, continuation power flow
 * (the nose curve and the QV curve), state estimation, and island detection.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { andesClient, TIMEOUTS } from '@/api/client';
import type {
  ConnectivityResult,
  CpfQvRunRequest,
  CpfResult,
  EigParticipationResponse,
  EigResult,
  SeMeasurementsGeneratedResponse,
  SeResult,
  SessionId,
} from '@/api/types';
import { useAnalyzeStore } from '@/store/analyze';
import { useConnectivityStore } from '@/store/connectivity';
import { usePflowOptionsStore } from '@/store/pflowOptions';
import { useSessionStore } from '@/store/session';
import { cpfRequestBody, type CpfRunOptions } from '@/lib/cpfOptions';
import { queryKeys } from './keys';
import { failJob, reconcileJobSuccess, registerJob } from './jobGlue';

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
      return await andesClient.post<EigResult>(`/sessions/${encodeURIComponent(sessionId)}/eig`, {
        body: {},
        timeoutMs: TIMEOUTS.pflowRun,
      });
    },
    onMutate: () => ({ jobId: registerJob('eig') }),
    onSuccess: (data, sessionId, ctx) => {
      useAnalyzeStore.getState().setEigResult(data);
      queryClient.setQueryData(queryKeys.eig(sessionId), data);
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
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

/**
 * What one run of the nose curve is asked for: the session, and the settings
 * of ``CpfRunOptions`` (``lib/cpfOptions``). ``direction`` defaults to
 * ``'load'``. ``enforceQLimits`` left out takes the switch of the power-flow
 * options: the continuation starts from the power flow, so the two run under
 * one setting. ``maxIter`` maps onto ANDES's ``CPF.config.max_steps`` (which
 * controls truncation; the ANDES ``max_iter`` config is corrector iterations
 * per step, not total steps).
 */
export interface CpfRunVars extends Partial<CpfRunOptions> {
  sessionId: SessionId;
}

/** Request body shape for ``POST /api/sessions/{id}/cpf/qv``. */
export interface CpfQvRunVars {
  sessionId: SessionId;
  /** Bus idx to draw the QV-curve at (must have a PQ device). */
  busIdx: string;
  /** Optional reactive-power range; ANDES default is 5.0. */
  qRange?: number;
}

/** The Q-limit switch of the power-flow options, which a continuation shares. */
function sharedEnforceQLimits(): boolean | null {
  return usePflowOptionsStore.getState().options.enforceQLimits;
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
 *   state with a CTA back to the PF view. Also when Q limits are to be
 *   enforced and the solved power flow leaves a generator past one: the
 *   same CTA runs the power flow with the shared switch on.
 * - 422 ``CpfRequestError`` — a custom direction the case cannot take.
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
    mutationFn: async ({ sessionId, ...options }: CpfRunVars) => {
      const body = cpfRequestBody({
        ...options,
        direction: options.direction ?? 'load',
        enforceQLimits:
          options.enforceQLimits === undefined ? sharedEnforceQLimits() : options.enforceQLimits,
      });
      return await andesClient.post<CpfResult>(`/sessions/${encodeURIComponent(sessionId)}/cpf`, {
        body,
        timeoutMs: TIMEOUTS.cpfRun,
      });
    },
    onMutate: ({ direction }) => ({
      jobId: registerJob('cpf', { direction: direction ?? 'load' }),
    }),
    onSuccess: (data, { sessionId }, ctx) => {
      useAnalyzeStore.getState().setCpfResult(data);
      queryClient.setQueryData(queryKeys.cpf(sessionId), data);
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

/**
 * ``POST /api/sessions/{id}/cpf/qv`` — runs a single-bus QV-curve
 * continuation. Same wire-shape response as ``useCpfRun``; the
 * ``mode`` discriminator on the result is ``"qv"`` so the chart
 * labels the X-axis "Q (pu)" instead of "lambda". Q limits follow the
 * switch of the power-flow options, as the nose curve's do.
 */
export function useCpfQvRun(): UseMutationResult<CpfResult, Error, CpfQvRunVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, busIdx, qRange }: CpfQvRunVars) => {
      const body: Partial<CpfQvRunRequest> = { bus_idx: busIdx };
      if (qRange !== undefined) body.q_range = qRange;
      const enforceQLimits = sharedEnforceQLimits();
      if (enforceQLimits !== null) body.enforce_q_limits = enforceQLimits;
      return await andesClient.post<CpfResult>(
        `/sessions/${encodeURIComponent(sessionId)}/cpf/qv`,
        { body, timeoutMs: TIMEOUTS.cpfRun },
      );
    },
    onMutate: ({ busIdx }) => ({ jobId: registerJob('cpf-qv', { bus_idx: busIdx }) }),
    onSuccess: (data, { sessionId }, ctx) => {
      useAnalyzeStore.getState().setCpfResult(data);
      queryClient.setQueryData(queryKeys.cpf(sessionId), data);
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

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
    onMutate: () => ({ jobId: registerJob('se-measurements') }),
    onSuccess: (data, { sessionId }, ctx) => {
      useAnalyzeStore.getState().setSeMeasurementsCount(data.count);
      // Generating fresh measurements invalidates any prior SE result —
      // the residuals would be measured against the old z values.
      useAnalyzeStore.getState().setSeResult(null);
      queryClient.setQueryData(queryKeys.seMeasurements(sessionId), data);
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
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
    onMutate: () => ({ jobId: registerJob('se') }),
    onSuccess: (data, sessionId, ctx) => {
      useAnalyzeStore.getState().setSeResult(data);
      queryClient.setQueryData(queryKeys.se(sessionId), data);
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

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
    queryKey: sessionId ? queryKeys.connectivity(sessionId) : ['connectivity', 'noop'],
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
