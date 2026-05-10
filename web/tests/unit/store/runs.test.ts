/**
 * Tests for the ``runs`` slice — typed-array growth, cap eviction, and
 * lifecycle transitions.
 *
 * Unit 9 (v2.0) extends this with retention-policy + overlay-set tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __internal,
  DEFAULT_MEMORY_BUDGET_BYTES,
  DEFAULT_RETENTION_LIMIT,
  MAX_RETENTION_LIMIT,
  useRunsStore,
} from '@/store/runs';

function reset(): void {
  useRunsStore.setState({
    runs: {},
    activeRunId: null,
    memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
    overlayRunIds: new Set<string>(),
    retentionLimit: DEFAULT_RETENTION_LIMIT,
  });
}

describe('runs store — startRun + appendFrame', () => {
  beforeEach(reset);
  afterEach(reset);

  it('startRun seeds a record with empty typed arrays per column', () => {
    useRunsStore.getState().startRun({
      runId: 'r1',
      tf: 1.0,
      columnNames: ['Bus_1_v', 'Bus_2_v'],
    });
    const r = useRunsStore.getState().runs.r1!;
    expect(r.runId).toBe('r1');
    expect(r.tf).toBe(1.0);
    expect(r.state).toBe('starting');
    expect(r.connection).toBe('connected');
    expect(r.seqCount).toBe(0);
    expect(r.t.length).toBe(0);
    expect(r.columnNames).toEqual(['Bus_1_v', 'Bus_2_v']);
    expect(useRunsStore.getState().activeRunId).toBe('r1');
  });

  it('appendFrame grows typed arrays geometrically and tracks seqCount', () => {
    useRunsStore.getState().startRun({
      runId: 'r1',
      tf: 1.0,
      columnNames: ['Bus_1_v'],
    });
    // First frame: 3 rows. Capacity bumps to INITIAL_CAPACITY (256).
    useRunsStore.getState().appendFrame('r1', {
      t: new Float64Array([0.0, 0.01, 0.02]),
      columns: { Bus_1_v: new Float64Array([1.0, 0.999, 0.998]) },
    });
    let r = useRunsStore.getState().runs.r1!;
    expect(r.seqCount).toBe(3);
    expect(r.t.length).toBe(__internal.INITIAL_CAPACITY);
    expect(Array.from(r.t.subarray(0, 3))).toEqual([0.0, 0.01, 0.02]);
    expect(Array.from(r.columns.Bus_1_v!.subarray(0, 3))).toEqual([1.0, 0.999, 0.998]);
    expect(r.state).toBe('streaming');
    expect(r.tCurrent).toBe(0.02);

    // Append until we cross the initial capacity → array doubles.
    const overflow = new Float64Array(__internal.INITIAL_CAPACITY);
    for (let i = 0; i < overflow.length; i += 1) overflow[i] = i + 100;
    useRunsStore.getState().appendFrame('r1', {
      t: overflow,
      columns: { Bus_1_v: overflow },
    });
    r = useRunsStore.getState().runs.r1!;
    expect(r.seqCount).toBe(3 + __internal.INITIAL_CAPACITY);
    expect(r.t.length).toBeGreaterThanOrEqual(r.seqCount);
    // Doubling: from 256 → 512.
    expect(r.t.length).toBe(__internal.INITIAL_CAPACITY * 2);
  });

  it('appendFrame ignores frames for unknown run_id', () => {
    useRunsStore.getState().appendFrame('does-not-exist', {
      t: new Float64Array([0.0]),
      columns: {},
    });
    expect(Object.keys(useRunsStore.getState().runs)).toHaveLength(0);
  });

  it('appendFrame ignores zero-row frames', () => {
    useRunsStore.getState().startRun({
      runId: 'r1',
      tf: 1.0,
      columnNames: ['Bus_1_v'],
    });
    useRunsStore.getState().appendFrame('r1', {
      t: new Float64Array([]),
      columns: { Bus_1_v: new Float64Array([]) },
    });
    expect(useRunsStore.getState().runs.r1!.seqCount).toBe(0);
    expect(useRunsStore.getState().runs.r1!.state).toBe('starting');
  });

  it('appendFrame skips columns absent from the run definition (forward-compat)', () => {
    useRunsStore.getState().startRun({
      runId: 'r1',
      tf: 1.0,
      columnNames: ['Bus_1_v'],
    });
    useRunsStore.getState().appendFrame('r1', {
      t: new Float64Array([0.0]),
      columns: {
        Bus_1_v: new Float64Array([1.0]),
        // Future column not registered at startRun time — should be ignored
        // by the runs slice (the DecodedFrame still carries it for any
        // surface that opts in).
        Future_col: new Float64Array([42]),
      },
    });
    const r = useRunsStore.getState().runs.r1!;
    expect(Object.keys(r.columns)).toEqual(['Bus_1_v']);
  });
});

describe('runs store — done / error / aborted / connection', () => {
  beforeEach(reset);
  afterEach(reset);

  it('markRunDone transitions state and bumps tCurrent to finalT if larger', () => {
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: [] });
    useRunsStore.getState().appendFrame('r1', {
      t: new Float64Array([0.5]),
      columns: {},
    });
    useRunsStore.getState().markRunDone('r1', 1.0);
    expect(useRunsStore.getState().runs.r1!.state).toBe('done');
    expect(useRunsStore.getState().runs.r1!.tCurrent).toBe(1.0);
  });

  it('markRunError records the reason and flips state', () => {
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: [] });
    useRunsStore.getState().markRunError('r1', 'numerical instability');
    expect(useRunsStore.getState().runs.r1!.state).toBe('error');
    expect(useRunsStore.getState().runs.r1!.errorReason).toBe('numerical instability');
  });

  it('markRunAborted flips state to aborted', () => {
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: [] });
    useRunsStore.getState().markRunAborted('r1');
    expect(useRunsStore.getState().runs.r1!.state).toBe('aborted');
  });

  it('setRunConnection + setAbortedLocally update only the targeted fields', () => {
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: [] });
    useRunsStore.getState().setRunConnection('r1', 'reconnecting');
    useRunsStore.getState().setAbortedLocally('r1', true);
    expect(useRunsStore.getState().runs.r1!.connection).toBe('reconnecting');
    expect(useRunsStore.getState().runs.r1!.abortedLocally).toBe(true);
  });

  it('resetRun fully drops the run and clears activeRunId if it was active', () => {
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: [] });
    expect(useRunsStore.getState().activeRunId).toBe('r1');
    useRunsStore.getState().resetRun('r1');
    expect(useRunsStore.getState().runs.r1).toBeUndefined();
    expect(useRunsStore.getState().activeRunId).toBeNull();
  });

  it('clearRuns drops every run and clears the overlay set', () => {
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: [] });
    useRunsStore.getState().startRun({ runId: 'r2', tf: 1.0, columnNames: [] });
    useRunsStore.getState().addOverlayRun('r2');
    useRunsStore.getState().clearRuns();
    expect(Object.keys(useRunsStore.getState().runs)).toHaveLength(0);
    expect(useRunsStore.getState().activeRunId).toBeNull();
    expect(useRunsStore.getState().overlayRunIds.size).toBe(0);
  });
});

describe('runs store — retention policy (Unit 9 v2.0)', () => {
  beforeEach(reset);
  afterEach(reset);

  it('default retention keeps up to 5 completed runs + the active one', () => {
    // Start + complete 5 runs, then start a 6th.
    for (let i = 1; i <= 5; i += 1) {
      useRunsStore.getState().startRun({ runId: `r${i}`, tf: 1.0, columnNames: [] });
      useRunsStore.getState().markRunDone(`r${i}`, 1.0);
    }
    // After 5 completed, all 5 still retained.
    expect(Object.keys(useRunsStore.getState().runs)).toHaveLength(5);
    // Start a 6th run. Retention applies on startRun (the just-completed
    // 5 are eligible; the new active one is shielded).
    useRunsStore.getState().startRun({ runId: 'r6', tf: 1.0, columnNames: [] });
    const ids = Object.keys(useRunsStore.getState().runs);
    // Oldest completed (r1) evicted; r2..r5 (4 completed) + r6 (active) = 5.
    expect(ids).toEqual(['r2', 'r3', 'r4', 'r5', 'r6']);
  });

  it('6th run starting triggers eviction of the oldest completed', () => {
    for (let i = 1; i <= 5; i += 1) {
      useRunsStore.getState().startRun({ runId: `r${i}`, tf: 1.0, columnNames: [] });
      useRunsStore.getState().markRunDone(`r${i}`, 1.0);
    }
    useRunsStore.getState().startRun({ runId: 'r6', tf: 1.0, columnNames: [] });
    expect(useRunsStore.getState().runs.r1).toBeUndefined();
    expect(useRunsStore.getState().runs.r6).toBeDefined();
  });

  it('still-streaming runs are NEVER evicted by retention', () => {
    // Start 5 runs but DO NOT complete them; they stay in 'starting' state.
    for (let i = 1; i <= 5; i += 1) {
      useRunsStore.getState().startRun({ runId: `r${i}`, tf: 1.0, columnNames: [] });
    }
    // Start a 6th. The first 5 are 'starting' (not 'done') so the
    // retention policy treats them as non-evictable.
    useRunsStore.getState().startRun({ runId: 'r6', tf: 1.0, columnNames: [] });
    expect(Object.keys(useRunsStore.getState().runs)).toHaveLength(6);
  });

  it('setRetentionLimit(3) when 5 are retained evicts the 2 oldest completed', () => {
    for (let i = 1; i <= 5; i += 1) {
      useRunsStore.getState().startRun({ runId: `r${i}`, tf: 1.0, columnNames: [] });
      useRunsStore.getState().markRunDone(`r${i}`, 1.0);
    }
    expect(Object.keys(useRunsStore.getState().runs)).toHaveLength(5);
    // Active run is r5. Total cap = 3. dropTarget = 5 - 3 = 2.
    // Eligible (completed, non-active) = {r1, r2, r3, r4}. Drop oldest
    // 2 → r1, r2. Remaining = {r3, r4, r5}.
    useRunsStore.getState().setRetentionLimit(3);
    const ids = Object.keys(useRunsStore.getState().runs);
    expect(ids).toEqual(['r3', 'r4', 'r5']);
  });

  it('setRetentionLimit clamps to [1, MAX_RETENTION_LIMIT]', () => {
    useRunsStore.getState().setRetentionLimit(0);
    expect(useRunsStore.getState().retentionLimit).toBe(1);
    useRunsStore.getState().setRetentionLimit(99);
    expect(useRunsStore.getState().retentionLimit).toBe(MAX_RETENTION_LIMIT);
    useRunsStore.getState().setRetentionLimit(7);
    expect(useRunsStore.getState().retentionLimit).toBe(7);
  });

  it('setRetentionLimit is no-op when value is unchanged', () => {
    const before = useRunsStore.getState().runs;
    useRunsStore.getState().setRetentionLimit(DEFAULT_RETENTION_LIMIT);
    // Reference equality: no copy happened.
    expect(useRunsStore.getState().runs).toBe(before);
  });

  it('error/aborted runs count toward the retention cap', () => {
    useRunsStore.getState().setRetentionLimit(2);
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: [] });
    useRunsStore.getState().markRunError('r1', 'oops');
    // r1 error, then r2 starts; r1 becomes completed-non-active. After
    // r2 inserted, total=2 = retention. No eviction.
    useRunsStore.getState().startRun({ runId: 'r2', tf: 1.0, columnNames: [] });
    expect(Object.keys(useRunsStore.getState().runs)).toHaveLength(2);
    useRunsStore.getState().markRunAborted('r2');
    // r2 still active (active flag is independent of state). No eviction.
    expect(Object.keys(useRunsStore.getState().runs)).toHaveLength(2);
    // Start r3. Total = 3, retention=2, dropTarget=1; eligible = {r1, r2}
    // (both non-active settled). Drop oldest = r1.
    useRunsStore.getState().startRun({ runId: 'r3', tf: 1.0, columnNames: [] });
    expect(useRunsStore.getState().runs.r1).toBeUndefined();
    expect(useRunsStore.getState().runs.r2).toBeDefined();
    expect(useRunsStore.getState().runs.r3).toBeDefined();
  });
});

describe('runs store — overlay set (Unit 9 v2.0)', () => {
  beforeEach(reset);
  afterEach(reset);

  it('addOverlayRun adds an existing run id to the set', () => {
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: [] });
    useRunsStore.getState().addOverlayRun('r1');
    expect(useRunsStore.getState().overlayRunIds.has('r1')).toBe(true);
  });

  it('addOverlayRun is a no-op for unknown run ids (defensive against stale ids)', () => {
    useRunsStore.getState().addOverlayRun('does-not-exist');
    expect(useRunsStore.getState().overlayRunIds.size).toBe(0);
  });

  it('removeOverlayRun drops a run from the set; idempotent for absent ids', () => {
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: [] });
    useRunsStore.getState().addOverlayRun('r1');
    useRunsStore.getState().removeOverlayRun('r1');
    expect(useRunsStore.getState().overlayRunIds.has('r1')).toBe(false);
    // Idempotent: removing again doesn't throw.
    useRunsStore.getState().removeOverlayRun('r1');
    expect(useRunsStore.getState().overlayRunIds.size).toBe(0);
  });

  it('setOverlayRuns replaces the set wholesale, filtering unknown ids', () => {
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: [] });
    useRunsStore.getState().startRun({ runId: 'r2', tf: 1.0, columnNames: [] });
    useRunsStore.getState().setOverlayRuns(['r1', 'r2', 'ghost']);
    const set = useRunsStore.getState().overlayRunIds;
    expect(set.has('r1')).toBe(true);
    expect(set.has('r2')).toBe(true);
    expect(set.has('ghost')).toBe(false);
    expect(set.size).toBe(2);
  });

  it('resetRun also unpins the run from the overlay set', () => {
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: [] });
    useRunsStore.getState().addOverlayRun('r1');
    useRunsStore.getState().resetRun('r1');
    expect(useRunsStore.getState().overlayRunIds.has('r1')).toBe(false);
  });

  it('retention eviction removes the run from the overlay set too', () => {
    useRunsStore.getState().setRetentionLimit(1);
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: [] });
    useRunsStore.getState().markRunDone('r1', 1.0);
    useRunsStore.getState().addOverlayRun('r1');
    expect(useRunsStore.getState().overlayRunIds.has('r1')).toBe(true);
    // Start r2; r1 is the oldest completed-non-active; retention 1
    // means we evict everything except r2 (active). r1 should be
    // dropped from both the runs map and the overlay set.
    useRunsStore.getState().startRun({ runId: 'r2', tf: 1.0, columnNames: [] });
    expect(useRunsStore.getState().runs.r1).toBeUndefined();
    expect(useRunsStore.getState().overlayRunIds.has('r1')).toBe(false);
  });
});

describe('runs store — eviction policy (memory budget)', () => {
  beforeEach(reset);
  afterEach(reset);

  it('cap eviction drops completed runs first when the budget is exceeded', () => {
    // Set a tight budget that one run worth of data overflows.
    useRunsStore.setState({ memoryBudgetBytes: 4096 });
    useRunsStore.getState().startRun({ runId: 'old', tf: 1.0, columnNames: ['Bus_1_v'] });
    // Append 200 rows × 8 bytes × 2 cols = 3200 bytes plus over-allocation
    // (one column × INITIAL_CAPACITY × 8 = 2048 bytes). Total > 4096.
    useRunsStore.getState().appendFrame('old', {
      t: new Float64Array(200),
      columns: { Bus_1_v: new Float64Array(200) },
    });
    useRunsStore.getState().markRunDone('old', 2.0);

    useRunsStore.getState().startRun({ runId: 'new', tf: 1.0, columnNames: ['Bus_1_v'] });
    // First append on the new run triggers cap eviction.
    useRunsStore.getState().appendFrame('new', {
      t: new Float64Array(50),
      columns: { Bus_1_v: new Float64Array(50) },
    });
    // ``old`` should have been dropped (it was completed) before ``new``
    // would have been head-evicted.
    expect(useRunsStore.getState().runs.old).toBeUndefined();
    expect(useRunsStore.getState().runs.new).toBeDefined();
  });

  it('cap eviction shrinks the active run head + flips connection to "lagged"', () => {
    // Tight budget; only one run in the store so no completed runs to drop.
    useRunsStore.setState({ memoryBudgetBytes: 1024 });
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: ['Bus_1_v'] });
    // 200 rows × 8 bytes × 2 cols + over-allocation overruns 1024.
    useRunsStore.getState().appendFrame('r1', {
      t: new Float64Array(200),
      columns: { Bus_1_v: new Float64Array(200) },
    });
    const r = useRunsStore.getState().runs.r1!;
    expect(r.connection).toBe('lagged');
    // 10% of 200 = 20 rows dropped from the head.
    expect(r.seqCount).toBeLessThan(200);
    expect(r.seqCount).toBeGreaterThan(0);
  });
});

describe('runs store — internals', () => {
  it('growFloat64 doubles capacity and preserves existing values', () => {
    const start = new Float64Array([1, 2, 3]);
    const grown = __internal.growFloat64(start, 4);
    // Doubles: 3 → 6.
    expect(grown.length).toBeGreaterThanOrEqual(4);
    expect(Array.from(grown.subarray(0, 3))).toEqual([1, 2, 3]);
  });

  it('runBytes counts the over-allocated tail (heap footprint, not logical length)', () => {
    const fakeRun = {
      runId: 'x',
      startedAt: 0,
      tf: 1,
      tCurrent: 0,
      seqCount: 5,
      t: new Float64Array(256),
      columns: { col: new Float64Array(256) },
      columnNames: ['col'] as const,
      state: 'streaming' as const,
      connection: 'connected' as const,
      abortedLocally: false,
      errorReason: null,
    };
    expect(__internal.runBytes(fakeRun)).toBe(256 * 8 * 2);
  });

  it('isCompletedState classifies run-state correctly', () => {
    expect(__internal.isCompletedState('starting')).toBe(false);
    expect(__internal.isCompletedState('streaming')).toBe(false);
    expect(__internal.isCompletedState('done')).toBe(true);
    expect(__internal.isCompletedState('error')).toBe(true);
    expect(__internal.isCompletedState('aborted')).toBe(true);
  });
});

describe('runs store — per-run displayName + colorOverride (Unit 20 v2.0)', () => {
  beforeEach(reset);
  afterEach(reset);

  it('setRunDisplayName stores a trimmed name on the run', () => {
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: [] });
    useRunsStore.getState().setRunDisplayName('r1', '  Fault @ tc=0.1  ');
    expect(useRunsStore.getState().runs.r1!.displayName).toBe('Fault @ tc=0.1');
  });

  it('setRunDisplayName clears the override when given an empty / whitespace value', () => {
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: [] });
    useRunsStore.getState().setRunDisplayName('r1', 'first');
    expect(useRunsStore.getState().runs.r1!.displayName).toBe('first');
    useRunsStore.getState().setRunDisplayName('r1', '   ');
    expect(useRunsStore.getState().runs.r1!.displayName).toBeUndefined();
  });

  it('setRunDisplayName is a no-op for unknown run ids', () => {
    useRunsStore.getState().setRunDisplayName('ghost', 'whatever');
    expect(useRunsStore.getState().runs.ghost).toBeUndefined();
  });

  it('setRunDisplayName is a no-op when value is unchanged (no churn)', () => {
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: [] });
    useRunsStore.getState().setRunDisplayName('r1', 'foo');
    const before = useRunsStore.getState().runs;
    useRunsStore.getState().setRunDisplayName('r1', 'foo');
    expect(useRunsStore.getState().runs).toBe(before);
  });

  it('setRunColorOverride stores a colour string on the run', () => {
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: [] });
    useRunsStore.getState().setRunColorOverride('r1', '#3366ff');
    expect(useRunsStore.getState().runs.r1!.colorOverride).toBe('#3366ff');
  });

  it('setRunColorOverride(null) clears the override', () => {
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: [] });
    useRunsStore.getState().setRunColorOverride('r1', '#3366ff');
    useRunsStore.getState().setRunColorOverride('r1', null);
    expect(useRunsStore.getState().runs.r1!.colorOverride).toBeUndefined();
  });

  it('setRunColorOverride("") clears the override (defensive)', () => {
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: [] });
    useRunsStore.getState().setRunColorOverride('r1', '#3366ff');
    useRunsStore.getState().setRunColorOverride('r1', '');
    expect(useRunsStore.getState().runs.r1!.colorOverride).toBeUndefined();
  });

  it('setRunColorOverride is a no-op for unknown run ids', () => {
    useRunsStore.getState().setRunColorOverride('ghost', '#ff0000');
    expect(useRunsStore.getState().runs.ghost).toBeUndefined();
  });

  it('setRunColorOverride is a no-op when value is unchanged', () => {
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: [] });
    useRunsStore.getState().setRunColorOverride('r1', '#abc');
    const before = useRunsStore.getState().runs;
    useRunsStore.getState().setRunColorOverride('r1', '#abc');
    expect(useRunsStore.getState().runs).toBe(before);
  });

  it('appendFrame preserves displayName + colorOverride across frames', () => {
    useRunsStore.getState().startRun({
      runId: 'r1',
      tf: 1.0,
      columnNames: ['Bus_1_v'],
    });
    useRunsStore.getState().setRunDisplayName('r1', 'Custom');
    useRunsStore.getState().setRunColorOverride('r1', '#ff00aa');
    useRunsStore.getState().appendFrame('r1', {
      t: new Float64Array([0.0]),
      columns: { Bus_1_v: new Float64Array([1.0]) },
    });
    const r = useRunsStore.getState().runs.r1!;
    expect(r.displayName).toBe('Custom');
    expect(r.colorOverride).toBe('#ff00aa');
  });
});
