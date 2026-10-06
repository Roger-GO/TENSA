/** Sensitivity sweeps: start one, and cancel a job that is running. */
import { useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { andesClient, TIMEOUTS } from '@/api/client';
import type { SessionId } from '@/api/types';
import { useJobsStore } from '@/store/jobs';
import { failJob, registerJob } from './jobGlue';

/** Allowed sweep parameter kinds (mirrors substrate ``SweepParamKind``). */
export type SweepParamKind =
  | 'disturbance.fault.tc'
  | 'disturbance.fault.tf'
  | 'disturbance.fault.xf'
  | 'disturbance.fault.rf'
  | 'disturbance.toggle.t'
  | 'disturbance.alter.t'
  | 'disturbance.alter.amount';

export interface StartSweepVars {
  sessionId: SessionId;
  parameterKind: SweepParamKind;
  parameterTarget: number;
  rangeStart: number;
  rangeEnd: number;
  rangeSteps: number;
  tf: number;
  h?: number | null;
  vars?: readonly string[] | null;
  snapshotName: string;
}

export interface StartSweepResponse {
  sweep_id: string;
  total: number;
}

/**
 * ``POST /api/sessions/{id}/sweep`` — start a sensitivity sweep — Unit 18.
 *
 * Returns immediately with a ``sweep_id`` that the UI uses to subscribe
 * via the WS progress channel (``/api/ws/{session_id}/sweep/{sweep_id}``).
 * The sweep runs as one long invoke on the per-session worker that
 * holds the session lock until done — every other session-scoped
 * route will return 503 in the meantime.
 *
 * 409 from the substrate means a sweep is already running on this
 * session; the dialog surfaces this inline.
 */
export function useStartSweep(): UseMutationResult<StartSweepResponse, Error, StartSweepVars> {
  return useMutation({
    mutationFn: async (vars: StartSweepVars) => {
      const body = {
        parameter: {
          kind: vars.parameterKind,
          target: vars.parameterTarget,
          range: {
            start: vars.rangeStart,
            end: vars.rangeEnd,
            steps: vars.rangeSteps,
          },
        },
        sim: {
          tf: vars.tf,
          h: vars.h ?? null,
          vars: vars.vars ?? null,
        },
        snapshot_name: vars.snapshotName,
      };
      return await andesClient.post<StartSweepResponse>(
        `/sessions/${encodeURIComponent(vars.sessionId)}/sweep`,
        { body, timeoutMs: TIMEOUTS.sessionLifecycle },
      );
    },
    onMutate: (vars) => ({
      jobId: registerJob(
        'sweep',
        { kind: vars.parameterKind, steps: vars.rangeSteps },
        // Sweeps are cancellable (cooperative abort at iteration boundary).
        true,
      ),
    }),
    onSuccess: (data, _vars, ctx) => {
      // The substrate aliases ``sweep_id`` onto the registry job_id, so the
      // placeholder reconciles onto it; subsequent JobStream events for the
      // same id (kept ``running`` by the sweep itself, then ``done``) merge.
      if (ctx) {
        useJobsStore.getState().reconcileJob(ctx.jobId, data.sweep_id, { status: 'running' });
      }
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

/** Variables for ``useCancelJob`` — the owning session + the job to cancel. */
export interface CancelJobVars {
  sessionId: SessionId;
  jobId: string;
}

/**
 * ``DELETE /sessions/{id}/jobs/{job_id}`` — request cooperative cancellation
 * of an in-flight job (Activity panel "Cancel" affordance, v3.1 Unit 11).
 *
 * The substrate flips the job to ``cancelled`` (or leaves it terminal if it
 * already finished) and the canonical transition arrives over ``JobStream``;
 * we optimistically mark the placeholder ``cancelled`` so the row updates
 * instantly even before the WS event lands. A failed DELETE (e.g. the job
 * already completed) is swallowed at the call site — the JobStream remains
 * the source of truth and will reconcile the real terminal state.
 */
export function useCancelJob(): UseMutationResult<void, Error, CancelJobVars> {
  return useMutation({
    mutationFn: async ({ sessionId, jobId }: CancelJobVars) => {
      await andesClient.delete<void>(
        `/sessions/${encodeURIComponent(sessionId)}/jobs/${encodeURIComponent(jobId)}`,
        { timeoutMs: TIMEOUTS.sessionLifecycle },
      );
    },
    onSuccess: (_data, { jobId }) => {
      // Optimistic terminal flip; the canonical JobStream ``cancelled`` event
      // merges onto this by id.
      useJobsStore.getState().updateJob(jobId, { status: 'cancelled', can_cancel: false });
    },
  });
}
