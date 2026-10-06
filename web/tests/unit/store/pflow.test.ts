/**
 * Tests for the pflow slice: the latest result the tables read, and the last
 * solved power flow, which the operating point read back after a time-domain
 * run does not replace.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { isSolvedPflow, usePflowStore } from '@/store/pflow';
import { parseRunId } from '@/api/types';
import type { PflowResult } from '@/api/types';

const SOLVED: PflowResult = {
  run_id: parseRunId('run-1'),
  converged: true,
  iterations: 4,
  mismatch: 1e-8,
  bus_voltages: { '1': 1.02 },
  bus_angles: { '1': 0 },
  line_flows: {},
  generator_outputs: {},
  summary: {
    generation_p: 10,
    generation_q: 2,
    load_p: 9.8,
    load_q: 1.9,
    shunt_p: 0,
    shunt_q: 0,
    loss_p: 0.2,
    loss_q: 0.1,
  },
};

const DIVERGED: PflowResult = {
  run_id: parseRunId('run-2'),
  converged: false,
  iterations: 25,
  mismatch: 3.2,
  bus_voltages: {},
  bus_angles: {},
};

// What ``GET /operating-point`` answers with after a time-domain run.
const OPERATING_POINT: PflowResult = {
  run_id: parseRunId('run-3'),
  converged: true,
  iterations: 0,
  mismatch: 0,
  bus_voltages: { '1': 0.97 },
  bus_angles: { '1': -0.1 },
};

beforeEach(() => {
  usePflowStore.getState().clearPflow();
});

describe('isSolvedPflow', () => {
  it('takes a converged power flow by its totals, and one that did not converge as it is', () => {
    expect(isSolvedPflow(SOLVED)).toBe(true);
    expect(isSolvedPflow(DIVERGED)).toBe(true);
  });

  it('does not take the operating point read back after a run for a power flow', () => {
    expect(isSolvedPflow(OPERATING_POINT)).toBe(false);
    expect(isSolvedPflow({ ...OPERATING_POINT, summary: null })).toBe(false);
  });
});

describe('usePflowStore', () => {
  it('holds a power flow as the latest result and as the last solved one', () => {
    usePflowStore.getState().setLastRun(SOLVED);
    expect(usePflowStore.getState().lastRun).toBe(SOLVED);
    expect(usePflowStore.getState().lastSolved).toBe(SOLVED);
  });

  it('keeps the last solved power flow when an operating point takes its place', () => {
    usePflowStore.getState().setLastRun(SOLVED);
    usePflowStore.getState().setLastRun(OPERATING_POINT);
    expect(usePflowStore.getState().lastRun).toBe(OPERATING_POINT);
    expect(usePflowStore.getState().lastSolved).toBe(SOLVED);
  });

  it('has no solved power flow after a run that was made without one', () => {
    usePflowStore.getState().setLastRun(OPERATING_POINT);
    expect(usePflowStore.getState().lastSolved).toBeNull();
  });

  it('replaces the last solved power flow with one that did not converge', () => {
    usePflowStore.getState().setLastRun(SOLVED);
    usePflowStore.getState().setLastRun(DIVERGED);
    expect(usePflowStore.getState().lastSolved).toBe(DIVERGED);
  });

  it('clears both', () => {
    usePflowStore.getState().setLastRun(SOLVED);
    usePflowStore.getState().setLastRun(OPERATING_POINT);
    usePflowStore.getState().clearPflow();
    expect(usePflowStore.getState().lastRun).toBeNull();
    expect(usePflowStore.getState().lastSolved).toBeNull();
  });
});
