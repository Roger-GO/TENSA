/**
 * Tests for the disturbance editor slice (Unit 6 of v0.2).
 *
 * Covers add/update/remove/clear flows, dirty + committed bookkeeping,
 * the substrate-shape spec contract, and the sortedDisturbances helper
 * (time order with insertion-order tie-break).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __setUuidFactoryForTests,
  blankAlterSpec,
  blankFaultSpec,
  blankToggleSpec,
  disturbanceSummary,
  disturbanceTime,
  sortedDisturbances,
  useDisturbanceStore,
} from '@/store/disturbance';
import type { AlterSpec, FaultSpec, ToggleSpec } from '@/api/types';

let counter = 0;
function reset() {
  counter = 0;
  __setUuidFactoryForTests(() => `id-${++counter}`);
  useDisturbanceStore.setState({ disturbances: [], dirty: false, committed: false });
}

beforeEach(reset);
afterEach(() => {
  __setUuidFactoryForTests(null);
});

describe('disturbance store — happy paths', () => {
  it('addDisturbance appends, sets dirty=true, committed=false', () => {
    const created = useDisturbanceStore.getState().addDisturbance(blankFaultSpec());
    const state = useDisturbanceStore.getState();
    expect(state.disturbances).toHaveLength(1);
    expect(state.disturbances[0]?.id).toBe(created.id);
    expect(state.disturbances[0]?.id).toBe('id-1');
    expect(state.dirty).toBe(true);
    expect(state.committed).toBe(false);
  });

  it('updateDisturbance preserves id and replaces spec', () => {
    const created = useDisturbanceStore.getState().addDisturbance(blankFaultSpec());
    const next: FaultSpec = { ...blankFaultSpec(), tf: 2.5, tc: 2.6, bus_idx: '5' };
    useDisturbanceStore.getState().updateDisturbance(created.id, next);
    const state = useDisturbanceStore.getState();
    expect(state.disturbances).toHaveLength(1);
    expect(state.disturbances[0]?.id).toBe(created.id);
    const spec = state.disturbances[0]?.spec as FaultSpec;
    expect(spec.kind).toBe('fault');
    expect(spec.tf).toBe(2.5);
    expect(spec.bus_idx).toBe('5');
  });

  it('removeDisturbance drops the entry; dirty stays true', () => {
    const a = useDisturbanceStore.getState().addDisturbance(blankFaultSpec());
    const b = useDisturbanceStore.getState().addDisturbance(blankToggleSpec());
    useDisturbanceStore.getState().removeDisturbance(a.id);
    const state = useDisturbanceStore.getState();
    expect(state.disturbances).toHaveLength(1);
    expect(state.disturbances[0]?.id).toBe(b.id);
    expect(state.dirty).toBe(true);
  });

  it('removeDisturbance with unknown id is a no-op', () => {
    useDisturbanceStore.getState().addDisturbance(blankFaultSpec());
    useDisturbanceStore.getState().markCommitted();
    useDisturbanceStore.getState().removeDisturbance('does-not-exist');
    const state = useDisturbanceStore.getState();
    expect(state.disturbances).toHaveLength(1);
    // Dirty stays as it was (false after markCommitted) — defensive no-op.
    expect(state.dirty).toBe(false);
    expect(state.committed).toBe(true);
  });

  it('updateDisturbance with unknown id is a no-op', () => {
    useDisturbanceStore.getState().addDisturbance(blankFaultSpec());
    useDisturbanceStore.getState().markCommitted();
    useDisturbanceStore.getState().updateDisturbance('does-not-exist', blankToggleSpec());
    expect(useDisturbanceStore.getState().dirty).toBe(false);
    expect(useDisturbanceStore.getState().committed).toBe(true);
  });

  it('clearDisturbances empties the list and resets flags', () => {
    useDisturbanceStore.getState().addDisturbance(blankFaultSpec());
    useDisturbanceStore.getState().clearDisturbances();
    const state = useDisturbanceStore.getState();
    expect(state.disturbances).toHaveLength(0);
    expect(state.dirty).toBe(false);
    expect(state.committed).toBe(false);
  });

  it('markCommitted flips dirty=false, committed=true', () => {
    useDisturbanceStore.getState().addDisturbance(blankFaultSpec());
    useDisturbanceStore.getState().markCommitted();
    const state = useDisturbanceStore.getState();
    expect(state.dirty).toBe(false);
    expect(state.committed).toBe(true);
  });

  it('subsequent edit after commit re-flips dirty=true', () => {
    const created = useDisturbanceStore.getState().addDisturbance(blankFaultSpec());
    useDisturbanceStore.getState().markCommitted();
    expect(useDisturbanceStore.getState().dirty).toBe(false);
    expect(useDisturbanceStore.getState().committed).toBe(true);

    const next: FaultSpec = { ...blankFaultSpec(), tf: 3.0, tc: 3.1 };
    useDisturbanceStore.getState().updateDisturbance(created.id, next);
    const state = useDisturbanceStore.getState();
    expect(state.dirty).toBe(true);
    expect(state.committed).toBe(false);
  });

  it('markDirty bumps dirty without touching committed', () => {
    useDisturbanceStore.getState().addDisturbance(blankFaultSpec());
    useDisturbanceStore.getState().markCommitted();
    useDisturbanceStore.getState().markDirty();
    const state = useDisturbanceStore.getState();
    expect(state.dirty).toBe(true);
    // markDirty does NOT clear committed — Unit 7 needs the prior-commit
    // signal even after a partial-failure retry.
    expect(state.committed).toBe(true);
  });
});

describe('disturbance store — substrate-shape spec contract', () => {
  it('blankFaultSpec uses the substrate field names (kind/bus_idx/tf/tc/xf/rf)', () => {
    const spec = blankFaultSpec();
    expect(spec.kind).toBe('fault');
    expect(spec).toHaveProperty('bus_idx');
    expect(spec).toHaveProperty('tf');
    expect(spec).toHaveProperty('tc');
    expect(spec).toHaveProperty('xf');
    expect(spec).toHaveProperty('rf');
  });

  it('blankToggleSpec uses kind/model/dev_idx/t', () => {
    const spec = blankToggleSpec();
    expect(spec.kind).toBe('toggle');
    expect(spec).toHaveProperty('model');
    expect(spec).toHaveProperty('dev_idx');
    expect(spec).toHaveProperty('t');
  });

  it('blankAlterSpec uses kind/model/dev_idx/src/t/method/amount (no value)', () => {
    const spec = blankAlterSpec();
    expect(spec.kind).toBe('alter');
    expect(spec).toHaveProperty('model');
    expect(spec).toHaveProperty('dev_idx');
    expect(spec).toHaveProperty('src');
    expect(spec).toHaveProperty('t');
    // ANDES's Alter model has no ``value`` — the contract is method+amount.
    expect(spec).not.toHaveProperty('value');
    expect(spec.method).toBe('=');
    expect(spec.amount).toBe(0.0);
  });
});

describe('disturbance helpers — disturbanceTime + summary', () => {
  it('returns spec.tf for fault and spec.t for toggle/alter', () => {
    const fault: FaultSpec = { ...blankFaultSpec(), tf: 1.5, tc: 1.8 };
    const toggle: ToggleSpec = { ...blankToggleSpec(), t: 2.5 };
    const alter: AlterSpec = { ...blankAlterSpec(), t: 3.5 };
    expect(disturbanceTime(fault)).toBe(1.5);
    expect(disturbanceTime(toggle)).toBe(2.5);
    expect(disturbanceTime(alter)).toBe(3.5);
  });

  it('disturbanceSummary renders kind-specific text', () => {
    const fault: FaultSpec = { ...blankFaultSpec(), bus_idx: '5', tf: 1.0 };
    expect(disturbanceSummary(fault)).toMatch(/fault/i);
    expect(disturbanceSummary(fault)).toContain('Bus 5');
    expect(disturbanceSummary(fault)).toContain('t=1.000s');

    const toggle: ToggleSpec = { ...blankToggleSpec(), model: 'Line', dev_idx: '7', t: 2.5 };
    expect(disturbanceSummary(toggle)).toMatch(/toggle/i);
    expect(disturbanceSummary(toggle)).toContain('Line 7');

    const alter: AlterSpec = {
      ...blankAlterSpec(),
      model: 'PQ',
      dev_idx: '3',
      src: 'Ppf',
      method: '+',
      amount: 0.2,
      t: 3.0,
    };
    const alterText = disturbanceSummary(alter);
    expect(alterText).toMatch(/alter/i);
    expect(alterText).toContain('PQ.3');
    expect(alterText).toContain('Ppf');
    // method '+' renders the readable verb + amount (not a '→ value').
    expect(alterText).toContain('increase by');
    expect(alterText).toContain('0.2');
    expect(alterText).not.toContain('→');

    // '=' renders "set to"; '*' renders "scale by".
    const setAlter: AlterSpec = { ...blankAlterSpec(), src: 'Ppf', method: '=', amount: 1.2 };
    expect(disturbanceSummary(setAlter)).toContain('set to');
    expect(disturbanceSummary(setAlter)).toContain('1.2');
    const scaleAlter: AlterSpec = { ...blankAlterSpec(), src: 'Ppf', method: '*', amount: 1.2 };
    expect(disturbanceSummary(scaleAlter)).toContain('scale by');
  });
});

describe('sortedDisturbances — time order with insertion-order tie-break', () => {
  it('sorts by spec.t / spec.tf ascending', () => {
    const a = useDisturbanceStore.getState().addDisturbance({ ...blankToggleSpec(), t: 5.0 });
    const b = useDisturbanceStore
      .getState()
      .addDisturbance({ ...blankFaultSpec(), tf: 1.0, tc: 1.1 });
    const c = useDisturbanceStore.getState().addDisturbance({ ...blankAlterSpec(), t: 2.5 });
    const sorted = sortedDisturbances(useDisturbanceStore.getState().disturbances);
    expect(sorted.map((d) => d.id)).toEqual([b.id, c.id, a.id]);
  });

  it('preserves insertion order on ties', () => {
    const first = useDisturbanceStore
      .getState()
      .addDisturbance({ ...blankFaultSpec(), tf: 1.0, tc: 1.1 });
    const second = useDisturbanceStore.getState().addDisturbance({ ...blankToggleSpec(), t: 1.0 });
    const third = useDisturbanceStore.getState().addDisturbance({ ...blankAlterSpec(), t: 1.0 });
    const sorted = sortedDisturbances(useDisturbanceStore.getState().disturbances);
    expect(sorted.map((d) => d.id)).toEqual([first.id, second.id, third.id]);
  });
});
