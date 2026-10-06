/**
 * Job registration glue shared by the mutation hooks.
 *
 * A mutation registers an optimistic placeholder in ``useJobsStore`` when it fires
 * (``registerJob``) and settles it when the response (``reconcileJobSuccess``) or the
 * error (``failJob``) arrives. Internal to the hooks: ``index.ts`` does not re-export it.
 */
import { ProblemDetailsError } from '@/api/client';
import { useJobsStore, mintLocalJobId, LOCAL_ID_PREFIX } from '@/store/jobs';
import type { JobKind, JobRecord } from '@/store/jobs';

/**
 * Register an optimistic placeholder ``JobRecord`` in ``useJobsStore`` for a
 * mutation that has just fired (``onMutate``). Returns the temp id the
 * caller threads into ``reconcileJobSuccess`` / ``failJob`` so the canonical
 * substrate ``job_id`` (which arrives on the response) re-keys the record.
 *
 * Two write paths converge in the store (this optimistic path + the
 * ``JobStream`` canonical events); they reconcile by ``job_id`` (see
 * ``store/jobs.ts``). Registering here is what powers the Activity panel's
 * instant feedback and tracks ``SessionBusy`` as a job state.
 *
 * NOTE: ``request_summary`` is in-memory only (security F2) — it is NEVER
 * persisted. Keep it small + free of credentials/blobs; the store's
 * ``partialize`` excludes the job map entirely, but callers should still
 * avoid stuffing large payloads here.
 */
export function registerJob(
  kind: JobKind,
  request_summary: Record<string, unknown> = {},
  canCancel = false,
): string {
  const id = mintLocalJobId();
  useJobsStore.getState().addJob({
    id,
    kind,
    status: 'pending',
    can_cancel: canCancel,
    request_summary,
    isPlaceholder: true,
  });
  return id;
}

/** Pull a substrate ``job_id`` off a mutation response, if present. The
 *  generated TS result types don't all declare ``job_id`` yet (the substrate
 *  embeds it per Unit 5b), so read it defensively. */
function extractJobId(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'job_id' in data) {
    const v = (data as Record<string, unknown>)['job_id'];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Reconcile an optimistic placeholder to ``done`` (mutation ``onSuccess``).
 * If the response carried a substrate ``job_id`` we re-key onto it (so the
 * canonical ``JobStream`` events for the same id merge); otherwise we mark
 * the temp record done in place. The ``JobStream`` event may have already
 * landed under the server id — ``reconcileJob`` handles that race.
 */
export function reconcileJobSuccess(
  tempId: string,
  data: unknown,
  patch?: Partial<JobRecord>,
): void {
  const serverId = extractJobId(data);
  const donePatch: Partial<JobRecord> = { status: 'done', ...patch };
  if (serverId) {
    useJobsStore.getState().reconcileJob(tempId, serverId, donePatch);
  } else {
    useJobsStore.getState().updateJob(tempId, donePatch);
  }
}

/**
 * Mark an optimistic placeholder ``failed`` (mutation ``onError``). Carries
 * the ProblemDetails envelope onto the record so the Activity panel's
 * per-job error surface can render it. A 409 ``SessionBusy`` flows through
 * here too — tracked as a ``failed`` job state rather than unhandled noise.
 *
 * ASYMMETRY NOTE (vs ``reconcileJobSuccess``): a *success* response embeds
 * the canonical substrate ``job_id`` so the placeholder re-keys onto it and
 * merges with any racing ``JobStream`` event — exactly one row. A *failure*
 * HTTP body (``map_worker_error`` → ``{detail, recovery, **extras}``) carries
 * NO ``job_id``, while the substrate's ``_run_as_job`` wrapper ALSO broadcasts
 * the canonical ``failed`` record over WS (under ``srv-X``). If we blindly
 * marked the ``local:`` placeholder failed in place, BOTH would survive as
 * terminal rows — a visible duplicate in the Activity panel / HistoryDrawer.
 * So: when a canonical (non-``local:``) terminal record for the same job kind
 * already exists in the store (the WS event won the race, the common case
 * since the broadcast fires before the HTTP error unwinds), DROP the
 * placeholder and let the canonical record be the single source of truth.
 * Only when no canonical record is present (e.g. the WS is disconnected /
 * not yet delivered) do we mark the placeholder failed in place so the
 * outcome is still surfaced somewhere.
 */
export function failJob(tempId: string, err: unknown): void {
  const placeholder = useJobsStore.getState().jobs[tempId];
  if (placeholder && placeholder.isPlaceholder) {
    // Match the canonical ``failed`` record the WS just broadcast for THIS
    // operation: same kind, non-``local:`` id, ``failed``, and RECENT (within
    // a few seconds of the placeholder's registration) so we never coalesce
    // onto an unrelated older same-kind failure already sitting in History.
    const now = Date.now() / 1000;
    const canonical = Object.values(useJobsStore.getState().jobs).find(
      (j) =>
        j.id !== tempId &&
        !j.id.startsWith(LOCAL_ID_PREFIX) &&
        j.kind === placeholder.kind &&
        j.status === 'failed' &&
        now - j.updated_at < 30,
    );
    if (canonical) {
      useJobsStore.getState().removeJob(tempId);
      return;
    }
    // STUCK-PILL FIX: a failed invoke (e.g. a case-load that 422s) leaves a
    // canonical ``srv-X`` in-flight record stranded when the server coalesces
    // the failure under a DIFFERENT job_id (or no terminal WS event arrives at
    // all). The HTTP error body carries no ``job_id`` (``map_worker_error`` →
    // ``{detail, recovery, ...}``), so we can't re-key it directly. Instead,
    // when the error carries no job_id, drive any matching CANONICAL in-flight
    // record (non-``local:`` id, same kind, pending/running, recent) straight
    // to ``failed`` too — the HTTP error arrives instantly, so this clears the
    // InFlightChip pill at once without waiting for a (possibly never-arriving)
    // terminal WS event. Mirrors the kind+recency matching used above for the
    // ``failed`` race.
    if (errorJobId(err) === undefined) {
      const stuck = Object.values(useJobsStore.getState().jobs).find(
        (j) =>
          j.id !== tempId &&
          !j.id.startsWith(LOCAL_ID_PREFIX) &&
          j.kind === placeholder.kind &&
          (j.status === 'pending' || j.status === 'running') &&
          now - j.updated_at < 30,
      );
      if (stuck) {
        useJobsStore.getState().updateJob(stuck.id, problemPatch(err));
      }
    }
  }
  useJobsStore.getState().updateJob(tempId, problemPatch(err));
}

/**
 * Build the ``{status:'failed', problem}`` patch carried onto a job record from
 * a mutation error. Shared by the placeholder-fail path and the stuck-canonical
 * backstop in ``failJob`` so both surface an identical ProblemDetails envelope.
 */
function problemPatch(err: unknown): Partial<JobRecord> {
  const patch: Partial<JobRecord> = { status: 'failed' };
  if (err instanceof ProblemDetailsError) {
    patch.problem = {
      type: err.type,
      title: err.title,
      status: err.status,
      detail: err.detail ?? null,
      instance: err.instance ?? null,
      recovery:
        err.rawBody && typeof err.rawBody === 'object'
          ? (err.rawBody as Record<string, unknown>)['recovery']
          : undefined,
    };
  } else if (err instanceof Error) {
    patch.problem = { title: err.name || 'Error', detail: err.message };
  }
  return patch;
}

/**
 * Pull a substrate ``job_id`` off a mutation ERROR body, if the server embedded
 * one. Case-load / invoke failures route through ``map_worker_error`` which
 * carries ``{detail, recovery, ...}`` and NO ``job_id`` — so this returns
 * undefined for them, which is the signal ``failJob`` uses to fall back to
 * kind+recency matching against any stranded canonical in-flight record.
 */
function errorJobId(err: unknown): string | undefined {
  if (err instanceof ProblemDetailsError) {
    return extractJobId(err.rawBody);
  }
  return undefined;
}
