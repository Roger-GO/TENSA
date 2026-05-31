/**
 * Tests for the jobs slice (`web/src/store/jobs.ts`) — v3.1 Unit 6.
 *
 * Coverage:
 *  - addJob/updateJob produce a chronological record; removeJob evicts.
 *  - upsertJob from a JobStream event updates the store.
 *  - reconcileJob re-keys an optimistic placeholder onto the server id,
 *    and merges when the WS event raced ahead.
 *  - Retention: the 101st TERMINAL job evicts the oldest terminal; in-flight
 *    records are NEVER evicted.
 *  - SECURITY (F2): partialize persists ONLY dismissedJobIds — the full
 *    JobRecord map is NOT in the persisted shape.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  JOBS_STORAGE_KEY,
  LOCAL_ID_PREFIX,
  MAX_TERMINAL,
  STALE_INFLIGHT_THRESHOLD_S,
  useJobsStore,
  isTerminalStatus,
  type JobEventEnvelope,
} from '@/store/jobs';

function clearStorage(): void {
  window.localStorage.clear();
}

function resetJobsStore(): void {
  useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
}

describe('useJobsStore — happy path', () => {
  beforeEach(() => {
    clearStorage();
    resetJobsStore();
  });

  it('addJob registers a pending placeholder and returns its id', () => {
    const id = useJobsStore.getState().addJob({ kind: 'pflow' });
    expect(id.startsWith(LOCAL_ID_PREFIX)).toBe(true);
    const rec = useJobsStore.getState().jobs[id];
    expect(rec).toBeDefined();
    expect(rec!.status).toBe('pending');
    expect(rec!.kind).toBe('pflow');
    expect(rec!.isPlaceholder).toBe(true);
  });

  it('addJob honours a caller-supplied id (e.g. a substrate job_id)', () => {
    const id = useJobsStore.getState().addJob({ id: 'job-server-1', kind: 'eig' });
    expect(id).toBe('job-server-1');
    expect(useJobsStore.getState().jobs['job-server-1']!.kind).toBe('eig');
  });

  it('updateJob patches a record and bumps updated_at chronologically', () => {
    const id = useJobsStore.getState().addJob({ kind: 'cpf' });
    const t0 = useJobsStore.getState().jobs[id]!.updated_at;
    useJobsStore.getState().updateJob(id, { status: 'running' });
    const rec = useJobsStore.getState().jobs[id]!;
    expect(rec.status).toBe('running');
    expect(rec.updated_at).toBeGreaterThanOrEqual(t0);
    // A terminal patch stamps ended_at.
    useJobsStore.getState().updateJob(id, { status: 'done' });
    expect(useJobsStore.getState().jobs[id]!.ended_at).toBeDefined();
  });

  it('updateJob is a no-op for an unknown id', () => {
    useJobsStore.getState().updateJob('nope', { status: 'done' });
    expect(useJobsStore.getState().jobs['nope']).toBeUndefined();
  });

  it('removeJob evicts a record', () => {
    const id = useJobsStore.getState().addJob({ kind: 'se' });
    useJobsStore.getState().removeJob(id);
    expect(useJobsStore.getState().jobs[id]).toBeUndefined();
  });

  it('insertion order is chronological across multiple adds', () => {
    const a = useJobsStore.getState().addJob({ id: 'a', kind: 'pflow' });
    const b = useJobsStore.getState().addJob({ id: 'b', kind: 'eig' });
    const c = useJobsStore.getState().addJob({ id: 'c', kind: 'cpf' });
    expect(Object.keys(useJobsStore.getState().jobs)).toEqual([a, b, c]);
  });
});

describe('useJobsStore — upsert + reconcile', () => {
  beforeEach(() => {
    clearStorage();
    resetJobsStore();
  });

  it('upsertJob from a status event inserts a canonical record', () => {
    const env: JobEventEnvelope = {
      job_id: 'srv-1',
      kind: 'pflow',
      status: 'running',
    };
    useJobsStore.getState().upsertJob(env);
    const rec = useJobsStore.getState().jobs['srv-1']!;
    expect(rec.status).toBe('running');
    expect(rec.isPlaceholder).toBeUndefined();
  });

  it('upsertJob merges a lean transition onto an existing record without wiping prior data', () => {
    useJobsStore.getState().upsertJob({
      job_id: 'srv-2',
      kind: 'sweep',
      status: 'running',
      progress: 0.5,
      request_summary: { steps: 10 },
    });
    // A lean done event omits progress + request_summary — those must persist.
    useJobsStore.getState().upsertJob({ job_id: 'srv-2', kind: 'sweep', status: 'done' });
    const rec = useJobsStore.getState().jobs['srv-2']!;
    expect(rec.status).toBe('done');
    expect(rec.progress).toBe(0.5);
    expect(rec.request_summary).toEqual({ steps: 10 });
    expect(rec.ended_at).toBeDefined();
  });

  it('reconcileJob re-keys a placeholder onto the server id (onMutate before WS)', () => {
    const tempId = useJobsStore.getState().addJob({
      kind: 'pflow',
      request_summary: { foo: 'bar' },
    });
    useJobsStore.getState().reconcileJob(tempId, 'srv-3', { status: 'done' });
    expect(useJobsStore.getState().jobs[tempId]).toBeUndefined();
    const rec = useJobsStore.getState().jobs['srv-3']!;
    expect(rec.id).toBe('srv-3');
    expect(rec.status).toBe('done');
    expect(rec.request_summary).toEqual({ foo: 'bar' });
    expect(rec.isPlaceholder).toBeUndefined();
  });

  it('reconcileJob merges onto a canonical record when the WS event raced ahead', () => {
    const tempId = useJobsStore.getState().addJob({
      kind: 'eig',
      request_summary: { seed: 1 },
    });
    // WS event lands first under the server id.
    useJobsStore.getState().upsertJob({ job_id: 'srv-4', kind: 'eig', status: 'running' });
    // Mutation response reconciles the temp onto it.
    useJobsStore.getState().reconcileJob(tempId, 'srv-4', { status: 'done' });
    expect(useJobsStore.getState().jobs[tempId]).toBeUndefined();
    const rec = useJobsStore.getState().jobs['srv-4']!;
    expect(rec.status).toBe('done');
    // The placeholder's request_summary folds in (the WS record had none).
    expect(rec.request_summary).toEqual({ seed: 1 });
  });

  it('upsertJob coalesces an orphaned failed placeholder onto the canonical failed record', () => {
    // Mutation onError marked the local placeholder failed in place (no
    // job_id in the error body). Then the canonical WS failed event lands.
    const tempId = useJobsStore.getState().addJob({ kind: 'pflow' });
    useJobsStore.getState().updateJob(tempId, {
      status: 'failed',
      problem: { title: 'boom', detail: 'no case loaded' },
    });
    expect(useJobsStore.getState().jobs[tempId]!.status).toBe('failed');
    // Canonical failed event for the same operation.
    useJobsStore.getState().upsertJob({ job_id: 'srv-pf', kind: 'pflow', status: 'failed' });
    const jobs = useJobsStore.getState().jobs;
    // The orphaned placeholder is gone; only the canonical failed row remains.
    expect(jobs[tempId]).toBeUndefined();
    expect(jobs['srv-pf']!.status).toBe('failed');
    const failedRows = Object.values(jobs).filter((j) => j.status === 'failed');
    expect(failedRows).toHaveLength(1);
  });

  it('upsertJob leaves a reconciled (non-placeholder) failed record untouched', () => {
    // A failed record that is NOT a local placeholder must not be coalesced
    // away by a later same-kind canonical event.
    useJobsStore.getState().upsertJob({ job_id: 'srv-a', kind: 'eig', status: 'failed' });
    useJobsStore.getState().upsertJob({ job_id: 'srv-b', kind: 'eig', status: 'failed' });
    const jobs = useJobsStore.getState().jobs;
    expect(jobs['srv-a']).toBeDefined();
    expect(jobs['srv-b']).toBeDefined();
  });

  it('syncJobs replaces canonical records but preserves in-flight local placeholders', () => {
    const tempId = useJobsStore.getState().addJob({ kind: 'pflow' });
    useJobsStore.getState().upsertJob({ job_id: 'srv-old', kind: 'eig', status: 'done' });
    useJobsStore.getState().syncJobs([{ job_id: 'srv-new', kind: 'cpf', status: 'running' }]);
    const jobs = useJobsStore.getState().jobs;
    // The stale canonical record is gone; the new one is in.
    expect(jobs['srv-old']).toBeUndefined();
    expect(jobs['srv-new']).toBeDefined();
    // The in-flight local placeholder survives the re-sync (its server id
    // hasn't landed yet, so it's not in the snapshot).
    expect(jobs[tempId]).toBeDefined();
  });

  it('syncJobs preserves a reconciled non-local in-flight record absent from the snapshot', () => {
    // The mutation path already reconciled an optimistic record onto a
    // canonical id (srv-X, running, with a request_summary), but a reconnect
    // snapshot was captured by the server BEFORE that job registered. The
    // in-flight canonical record must survive (dropping it would lose the
    // optimistic request_summary the row needs); a terminal one absent from
    // the snapshot is genuinely gone.
    useJobsStore.getState().upsertJob({
      job_id: 'srv-X',
      kind: 'sweep',
      status: 'running',
      request_summary: { steps: 12 },
    });
    useJobsStore.getState().upsertJob({ job_id: 'srv-Y', kind: 'eig', status: 'done' });
    useJobsStore.getState().syncJobs([{ job_id: 'srv-Z', kind: 'cpf', status: 'running' }]);
    const jobs = useJobsStore.getState().jobs;
    // In-flight canonical record absent from the snapshot is preserved...
    expect(jobs['srv-X']).toBeDefined();
    expect(jobs['srv-X']!.request_summary).toEqual({ steps: 12 });
    // ...while a terminal record absent from the snapshot is dropped.
    expect(jobs['srv-Y']).toBeUndefined();
    expect(jobs['srv-Z']).toBeDefined();
  });

  it('reconcileJob synthesizes a record when neither placeholder nor server id exists', () => {
    // Defensive third branch: the response references a server id with no
    // local placeholder and no prior canonical record — synthesize from patch
    // so the response is not silently dropped.
    useJobsStore.getState().reconcileJob('missing-temp', 'srv-Z', { status: 'done', kind: 'eig' });
    const rec = useJobsStore.getState().jobs['srv-Z'];
    expect(rec).toBeDefined();
    expect(rec!.id).toBe('srv-Z');
    expect(rec!.status).toBe('done');
    expect(rec!.kind).toBe('eig');
    expect(useJobsStore.getState().jobs['missing-temp']).toBeUndefined();
  });

  it('mergeEnvelope clears a problem on explicit problem:null but leaves it on omission', () => {
    // Seed a record carrying a problem.
    useJobsStore.getState().upsertJob({
      job_id: 'srv-rec',
      kind: 'pflow',
      status: 'failed',
      problem: { title: 'boom', detail: 'x' },
    });
    expect(useJobsStore.getState().jobs['srv-rec']!.problem).toBeTruthy();
    // An event OMITTING problem leaves it intact.
    useJobsStore.getState().upsertJob({ job_id: 'srv-rec', kind: 'pflow', status: 'running' });
    expect(useJobsStore.getState().jobs['srv-rec']!.problem).toBeTruthy();
    // An explicit problem:null clears it (the job recovered).
    useJobsStore
      .getState()
      .upsertJob({ job_id: 'srv-rec', kind: 'pflow', status: 'done', problem: null });
    expect(useJobsStore.getState().jobs['srv-rec']!.problem).toBeNull();
  });
});

describe('useJobsStore — retention (KTD-19 mirror)', () => {
  beforeEach(() => {
    clearStorage();
    resetJobsStore();
  });

  it('the 101st TERMINAL job evicts the oldest terminal', () => {
    // Add MAX_TERMINAL done jobs.
    for (let i = 0; i < MAX_TERMINAL; i += 1) {
      useJobsStore.getState().addJob({ id: `done-${i}`, kind: 'pflow', status: 'done' });
    }
    expect(Object.keys(useJobsStore.getState().jobs).length).toBe(MAX_TERMINAL);
    expect(useJobsStore.getState().jobs['done-0']).toBeDefined();
    // The 101st terminal pushes the cap over; oldest terminal evicts.
    useJobsStore.getState().addJob({ id: 'done-100', kind: 'pflow', status: 'done' });
    expect(Object.keys(useJobsStore.getState().jobs).length).toBe(MAX_TERMINAL);
    expect(useJobsStore.getState().jobs['done-0']).toBeUndefined();
    expect(useJobsStore.getState().jobs['done-100']).toBeDefined();
  });

  it('NEVER evicts in-flight records even past the cap', () => {
    // Fill with in-flight (pending/running) jobs well past the cap.
    for (let i = 0; i < MAX_TERMINAL + 20; i += 1) {
      useJobsStore.getState().addJob({ id: `live-${i}`, kind: 'pflow', status: 'running' });
    }
    // In-flight records are never counted/evicted by the terminal cap.
    expect(Object.keys(useJobsStore.getState().jobs).length).toBe(MAX_TERMINAL + 20);
    expect(useJobsStore.getState().jobs['live-0']).toBeDefined();
  });

  it('evicts only terminal records when in-flight + terminal coexist past the cap', () => {
    // 5 in-flight jobs that must survive.
    for (let i = 0; i < 5; i += 1) {
      useJobsStore.getState().addJob({ id: `live-${i}`, kind: 'sweep', status: 'running' });
    }
    // MAX_TERMINAL + 1 terminal jobs — exactly one terminal should evict.
    for (let i = 0; i <= MAX_TERMINAL; i += 1) {
      useJobsStore.getState().addJob({ id: `done-${i}`, kind: 'pflow', status: 'done' });
    }
    const jobs = useJobsStore.getState().jobs;
    // All in-flight survive.
    for (let i = 0; i < 5; i += 1) expect(jobs[`live-${i}`]).toBeDefined();
    // The oldest terminal evicted.
    expect(jobs['done-0']).toBeUndefined();
    expect(jobs['done-1']).toBeDefined();
  });
});

describe('useJobsStore — staleness sweep (stuck-pill backstop)', () => {
  beforeEach(() => {
    clearStorage();
    resetJobsStore();
  });

  it('marks an orphaned canonical running case-load record failed once stale', () => {
    // A case-load failure can strand a canonical ``srv-X`` record stuck
    // ``running`` (server coalesced the failure under a different id / no
    // terminal WS event arrived). The sweep is the guaranteed backstop.
    const now = 1_000_000;
    useJobsStore.getState().upsertJob({
      job_id: 'srv-load',
      kind: 'case-load',
      status: 'running',
      updated_at: now - (STALE_INFLIGHT_THRESHOLD_S + 5),
    });
    // While still fresh it is NOT swept.
    useJobsStore.getState().sweepStaleJobs(now - STALE_INFLIGHT_THRESHOLD_S - 5 + 1);
    expect(useJobsStore.getState().jobs['srv-load']!.status).toBe('running');
    // Past the threshold it is driven to ``failed`` with a synthetic problem.
    useJobsStore.getState().sweepStaleJobs(now);
    const rec = useJobsStore.getState().jobs['srv-load']!;
    expect(rec.status).toBe('failed');
    expect(isTerminalStatus(rec.status)).toBe(true);
    expect(rec.ended_at).toBe(now);
    expect(rec.problem?.title).toBeTruthy();
  });

  it('NEVER sweeps long-running streaming kinds (tds-stream / tds-batch / sweep)', () => {
    const old = 1; // ancient updated_at — well past any threshold.
    for (const kind of ['tds-stream', 'tds-batch', 'sweep'] as const) {
      useJobsStore.getState().upsertJob({
        job_id: `srv-${kind}`,
        kind,
        status: 'running',
        updated_at: old,
      });
    }
    useJobsStore.getState().sweepStaleJobs(1_000_000);
    for (const kind of ['tds-stream', 'tds-batch', 'sweep'] as const) {
      expect(useJobsStore.getState().jobs[`srv-${kind}`]!.status).toBe('running');
    }
  });

  it('leaves a fresh in-flight invoke record untouched', () => {
    const now = 1_000_000;
    useJobsStore.getState().upsertJob({
      job_id: 'srv-eig',
      kind: 'eig',
      status: 'running',
      updated_at: now - 1,
    });
    useJobsStore.getState().sweepStaleJobs(now);
    expect(useJobsStore.getState().jobs['srv-eig']!.status).toBe('running');
  });

  it('leaves already-terminal records untouched (idempotent)', () => {
    const now = 1_000_000;
    useJobsStore.getState().upsertJob({
      job_id: 'srv-done',
      kind: 'pflow',
      status: 'done',
      updated_at: now - 10_000,
    });
    useJobsStore.getState().sweepStaleJobs(now);
    expect(useJobsStore.getState().jobs['srv-done']!.status).toBe('done');
  });
});

describe('useJobsStore — dismissals', () => {
  beforeEach(() => {
    clearStorage();
    resetJobsStore();
  });

  it('dismissJob / undismissJob toggle the id idempotently', () => {
    useJobsStore.getState().dismissJob('x');
    useJobsStore.getState().dismissJob('x');
    expect(useJobsStore.getState().dismissedJobIds).toEqual(['x']);
    useJobsStore.getState().undismissJob('x');
    expect(useJobsStore.getState().dismissedJobIds).toEqual([]);
  });
});

describe('useJobsStore — SECURITY F2: partialize whitelist', () => {
  beforeEach(() => {
    clearStorage();
    resetJobsStore();
  });

  afterEach(() => {
    clearStorage();
  });

  it('persists ONLY dismissedJobIds — the JobRecord map is NOT in the persisted shape', async () => {
    // Register a job carrying a request_summary + problem (sensitive in-memory data).
    const id = useJobsStore.getState().addJob({
      kind: 'pflow',
      request_summary: { primary_path: 'secret/case.xlsx', token: 'should-not-persist' },
    });
    useJobsStore.getState().updateJob(id, {
      status: 'failed',
      problem: { title: 'boom', detail: 'sensitive error detail' },
    });
    useJobsStore.getState().dismissJob(id);

    // Drain the microtask queue so the persist middleware flushes.
    await Promise.resolve();

    const raw = window.localStorage.getItem(JOBS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as { state: Record<string, unknown> };

    // The ONLY persisted field is dismissedJobIds.
    expect(parsed.state.dismissedJobIds).toEqual([id]);
    // The full job map MUST NOT be persisted (security F2 / KTD-16).
    expect(parsed.state.jobs).toBeUndefined();
    // Defence-in-depth: the serialized blob must not contain the sensitive
    // request_summary / problem payloads anywhere.
    expect(raw).not.toContain('should-not-persist');
    expect(raw).not.toContain('sensitive error detail');
    expect(raw).not.toContain('secret/case.xlsx');
  });
});
