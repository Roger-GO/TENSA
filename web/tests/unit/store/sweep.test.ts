/**
 * Tests for the sweep store (Unit 18 of the v2.0 plan).
 *
 * Covers:
 * - startSweep: registers a record + sets activeSweepId.
 * - appendIteration: appends, dedups by iteration index, sorts by index.
 * - markSweepFinished: state transition + clears activeSweepId on the
 *   active sweep + truncated/error fields applied.
 * - resetSweep: removes the record + clears activeSweepId when active.
 * - clearSweeps: nukes everything.
 * - setActiveSweep: direct selection without state changes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useSweepStore } from '@/store/sweep';
import type { SweepIteration } from '@/store/sweep';

beforeEach(() => {
  useSweepStore.setState({ sweeps: {}, activeSweepId: null });
});

describe('useSweepStore — startSweep', () => {
  it('registers a record and sets activeSweepId', () => {
    useSweepStore.getState().startSweep({
      sweepId: 'sw1',
      parameterKind: 'disturbance.fault.tc',
      parameterTarget: 0,
      snapshotName: 'snap-A',
      total: 10,
    });
    const state = useSweepStore.getState();
    expect(state.activeSweepId).toBe('sw1');
    expect(state.sweeps['sw1']).toBeDefined();
    expect(state.sweeps['sw1']!.total).toBe(10);
    expect(state.sweeps['sw1']!.state).toBe('pending');
    expect(state.sweeps['sw1']!.iterations).toEqual([]);
  });

  it('preserves earlier sweeps when a new one starts', () => {
    const start = useSweepStore.getState().startSweep;
    start({
      sweepId: 'sw1',
      parameterKind: 'disturbance.fault.tc',
      parameterTarget: 0,
      snapshotName: 'snap-A',
      total: 5,
    });
    start({
      sweepId: 'sw2',
      parameterKind: 'disturbance.fault.tc',
      parameterTarget: 0,
      snapshotName: 'snap-A',
      total: 7,
    });
    const state = useSweepStore.getState();
    expect(Object.keys(state.sweeps)).toEqual(['sw1', 'sw2']);
    expect(state.activeSweepId).toBe('sw2');
  });
});

describe('useSweepStore — appendIteration', () => {
  beforeEach(() => {
    useSweepStore.getState().startSweep({
      sweepId: 'sw1',
      parameterKind: 'disturbance.fault.tc',
      parameterTarget: 0,
      snapshotName: 'snap-A',
      total: 3,
    });
  });

  it('appends and flips state to running on first iteration', () => {
    const iter: SweepIteration = {
      iteration: 0,
      parameter_value: 1.0,
      converged: true,
      final_t: 0.5,
      callpert_count: 60,
      error: null,
    };
    useSweepStore.getState().appendIteration('sw1', iter);
    const sweep = useSweepStore.getState().sweeps['sw1']!;
    expect(sweep.iterations).toHaveLength(1);
    expect(sweep.state).toBe('running');
  });

  it('dedups by iteration index (replace, not append)', () => {
    const iter0: SweepIteration = {
      iteration: 0,
      parameter_value: 1.0,
      converged: true,
      final_t: 0.5,
      callpert_count: 60,
      error: null,
    };
    const iter0Updated: SweepIteration = { ...iter0, converged: false };
    const a = useSweepStore.getState().appendIteration;
    a('sw1', iter0);
    a('sw1', iter0Updated);
    const sweep = useSweepStore.getState().sweeps['sw1']!;
    expect(sweep.iterations).toHaveLength(1);
    expect(sweep.iterations[0]!.converged).toBe(false);
  });

  it('keeps iterations sorted by iteration index', () => {
    const a = useSweepStore.getState().appendIteration;
    const make = (i: number): SweepIteration => ({
      iteration: i,
      parameter_value: i,
      converged: true,
      final_t: 0.5,
      callpert_count: 60,
      error: null,
    });
    a('sw1', make(2));
    a('sw1', make(0));
    a('sw1', make(1));
    const indices = useSweepStore.getState().sweeps['sw1']!.iterations.map((i) => i.iteration);
    expect(indices).toEqual([0, 1, 2]);
  });

  it('is a no-op for unknown sweep ids', () => {
    useSweepStore.getState().appendIteration('unknown-sweep', {
      iteration: 0,
      parameter_value: 0,
      converged: true,
      final_t: 0,
      callpert_count: 0,
      error: null,
    });
    expect(useSweepStore.getState().sweeps['unknown-sweep']).toBeUndefined();
  });
});

describe('useSweepStore — markSweepFinished', () => {
  beforeEach(() => {
    useSweepStore.getState().startSweep({
      sweepId: 'sw1',
      parameterKind: 'disturbance.fault.tc',
      parameterTarget: 0,
      snapshotName: 'snap-A',
      total: 5,
    });
  });

  it('transitions state and clears activeSweepId on the active sweep', () => {
    useSweepStore.getState().markSweepFinished('sw1', 'completed');
    const state = useSweepStore.getState();
    expect(state.sweeps['sw1']!.state).toBe('completed');
    expect(state.activeSweepId).toBeNull();
  });

  it('records truncated + error when supplied', () => {
    useSweepStore.getState().markSweepFinished('sw1', 'aborted', {
      truncated: true,
      error: { category: 'cancelled', detail: 'user pressed stop' },
    });
    const sweep = useSweepStore.getState().sweeps['sw1']!;
    expect(sweep.truncated).toBe(true);
    expect(sweep.error).toEqual({
      category: 'cancelled',
      detail: 'user pressed stop',
    });
    expect(sweep.state).toBe('aborted');
  });

  it('does not touch activeSweepId when finishing a non-active sweep', () => {
    useSweepStore.getState().startSweep({
      sweepId: 'sw2',
      parameterKind: 'disturbance.fault.tc',
      parameterTarget: 0,
      snapshotName: 'snap-A',
      total: 3,
    });
    // Activate a third one so finishing sw1 doesn't clear the active.
    expect(useSweepStore.getState().activeSweepId).toBe('sw2');
    useSweepStore.getState().markSweepFinished('sw1', 'completed');
    expect(useSweepStore.getState().activeSweepId).toBe('sw2');
  });
});

describe('useSweepStore — resetSweep + clearSweeps', () => {
  it('resetSweep removes the record + clears active when active', () => {
    useSweepStore.getState().startSweep({
      sweepId: 'sw1',
      parameterKind: 'disturbance.fault.tc',
      parameterTarget: 0,
      snapshotName: 'snap-A',
      total: 3,
    });
    useSweepStore.getState().resetSweep('sw1');
    const state = useSweepStore.getState();
    expect(state.sweeps).toEqual({});
    expect(state.activeSweepId).toBeNull();
  });

  it('clearSweeps nukes everything', () => {
    useSweepStore.getState().startSweep({
      sweepId: 'sw1',
      parameterKind: 'disturbance.fault.tc',
      parameterTarget: 0,
      snapshotName: 'snap-A',
      total: 3,
    });
    useSweepStore.getState().clearSweeps();
    const state = useSweepStore.getState();
    expect(state.sweeps).toEqual({});
    expect(state.activeSweepId).toBeNull();
  });
});

describe('useSweepStore — setActiveSweep', () => {
  it('selects an existing sweep without changing its state', () => {
    useSweepStore.getState().startSweep({
      sweepId: 'sw1',
      parameterKind: 'disturbance.fault.tc',
      parameterTarget: 0,
      snapshotName: 'snap-A',
      total: 3,
    });
    useSweepStore.getState().markSweepFinished('sw1', 'completed');
    expect(useSweepStore.getState().activeSweepId).toBeNull();
    useSweepStore.getState().setActiveSweep('sw1');
    expect(useSweepStore.getState().activeSweepId).toBe('sw1');
    expect(useSweepStore.getState().sweeps['sw1']!.state).toBe('completed');
  });
});
