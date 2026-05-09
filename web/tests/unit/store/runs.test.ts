/**
 * Tests for the ``runs`` slice — typed-array growth, cap eviction, and
 * lifecycle transitions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __internal, DEFAULT_MEMORY_BUDGET_BYTES, useRunsStore } from '@/store/runs';

function reset(): void {
  useRunsStore.setState({
    runs: {},
    activeRunId: null,
    memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
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

  it('clearRuns drops every run', () => {
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: [] });
    useRunsStore.getState().startRun({ runId: 'r2', tf: 1.0, columnNames: [] });
    useRunsStore.getState().clearRuns();
    expect(Object.keys(useRunsStore.getState().runs)).toHaveLength(0);
    expect(useRunsStore.getState().activeRunId).toBeNull();
  });
});

describe('runs store — eviction policy', () => {
  beforeEach(reset);
  afterEach(reset);

  it('startRun trims to comparison limit (1 prior + 1 new)', () => {
    // Even though only "1 active + 1 completed" is the production cap,
    // the in-place ``trimToComparisonLimit`` enforces the simpler "max
    // 1 retained when starting a third" rule by dropping the oldest.
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1.0, columnNames: [] });
    useRunsStore.getState().markRunDone('r1', 1.0);
    useRunsStore.getState().startRun({ runId: 'r2', tf: 1.0, columnNames: [] });
    useRunsStore.getState().markRunDone('r2', 1.0);
    useRunsStore.getState().startRun({ runId: 'r3', tf: 1.0, columnNames: [] });
    // r1 dropped; r2 (completed) + r3 (active) remain.
    const ids = Object.keys(useRunsStore.getState().runs);
    expect(ids).toEqual(['r2', 'r3']);
  });

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
});
