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
  useJobsStore,
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
