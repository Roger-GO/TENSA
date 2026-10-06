/**
 * Tests for the disturbance editor slice (Unit 6 of v0.2).
 *
 * Covers add/update/remove/clear flows, dirty + committed bookkeeping,
 * the substrate-shape spec contract, the sortedDisturbances helper
 * (time order with insertion-order tie-break), and what a deleted element
 * does to the disturbances that act on it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __setUuidFactoryForTests,
  actsOn,
  blankAlterSpec,
  blankFaultSpec,
  blankToggleSpec,
  deletedElementKey,
  disturbanceSummary,
  disturbanceTime,
  disturbancesActingOn,
  sortedDisturbances,
  useDisturbanceStore,
} from '@/store/disturbance';
import type { AlterSpec, FaultSpec, ToggleSpec } from '@/api/types';

let counter = 0;
function reset() {
  counter = 0;
  __setUuidFactoryForTests(() => `id-${++counter}`);
  useDisturbanceStore.setState({
    disturbances: [],
    removedWith: {},
    dirty: false,
    committed: false,
  });
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

describe('disturbances and a deleted element', () => {
  const fault = (bus: string): FaultSpec => ({ ...blankFaultSpec(), bus_idx: bus });
  const trip = (model: string, dev: string): ToggleSpec => ({
    ...blankToggleSpec(),
    model,
    dev_idx: dev,
  });
  const store = () => useDisturbanceStore.getState();

  it('a fault acts on its bus, a toggle and an alter on their device, whatever type the idx has', () => {
    expect(actsOn(fault('3'), { model: 'Bus', idx: 3 })).toBe(true);
    expect(actsOn(fault('3'), { model: 'Bus', idx: '30' })).toBe(false);
    // The same idx in another model is another device.
    expect(actsOn(fault('3'), { model: 'PV', idx: 3 })).toBe(false);
    expect(actsOn(trip('Line', 'Line_3'), { model: 'Line', idx: 'Line_3' })).toBe(true);
    expect(actsOn(trip('PQ', 'Line_3'), { model: 'Line', idx: 'Line_3' })).toBe(false);
    const alter: AlterSpec = { ...blankAlterSpec(), model: 'PQ', dev_idx: 4, src: 'Ppf' };
    expect(actsOn(alter, { model: 'PQ', idx: '4' })).toBe(true);
  });

  it('finds the disturbances on any of the devices, in list order', () => {
    const a = store().addDisturbance(fault('3'));
    store().addDisturbance(fault('5'));
    const c = store().addDisturbance(trip('Line', 'L1'));
    const found = disturbancesActingOn(store().disturbances, [
      { model: 'Line', idx: 'L1' },
      { model: 'Bus', idx: 3 },
    ]);
    expect(found).toEqual([a, c]);
    expect(disturbancesActingOn(store().disturbances, [])).toEqual([]);
  });

  it('removeWith takes them off as an uncommitted change and remembers them by the element', () => {
    const a = store().addDisturbance(fault('3'));
    const b = store().addDisturbance(fault('5'));
    const c = store().addDisturbance(trip('Line', 'L1'));
    store().markCommitted();
    const key = deletedElementKey('Bus', 3);

    store().removeWith(key, [a.id, c.id]);

    expect(store().disturbances).toEqual([b]);
    expect(store().dirty).toBe(true);
    expect(store().committed).toBe(false);
    expect(store().removedWith[key]?.map((r) => r.disturbance.id)).toEqual([a.id, c.id]);
  });

  it('removeWith with nothing to take leaves the list, and what it holds as committed, alone', () => {
    store().addDisturbance(fault('5'));
    store().markCommitted();
    const before = store();

    store().removeWith(deletedElementKey('Bus', 3), []);

    expect(store().disturbances).toBe(before.disturbances);
    expect(store().committed).toBe(true);
    expect(store().removedWith).toEqual({});
  });

  it('restoreWith puts them back where they stood, and removeAgainWith takes them off again', () => {
    const a = store().addDisturbance(fault('3'));
    const b = store().addDisturbance(fault('5'));
    const c = store().addDisturbance(trip('Line', 'L1'));
    const key = deletedElementKey('Bus', '3');
    store().removeWith(key, [a.id, c.id]);
    // The timeline goes on being edited while the element is gone.
    const d = store().addDisturbance(fault('7'));

    expect(store().restoreWith(key)).toBe(2);
    expect(store().disturbances).toEqual([a, b, c, d]);
    // Restoring twice does not double them.
    expect(store().restoreWith(key)).toBe(0);
    expect(store().disturbances).toHaveLength(4);

    expect(store().removeAgainWith(key)).toBe(2);
    expect(store().disturbances).toEqual([b, d]);
    expect(store().removeAgainWith(key)).toBe(0);
  });

  it('an element nothing was removed with restores nothing', () => {
    store().addDisturbance(fault('5'));
    expect(store().restoreWith(deletedElementKey('Bus', 9))).toBe(0);
    expect(store().removeAgainWith(deletedElementKey('Bus', 9))).toBe(0);
    expect(store().disturbances).toHaveLength(1);
  });

  it('a number and its text name the same deleted element', () => {
    // The request carries the idx as text; the undo step may carry a number.
    expect(deletedElementKey('Bus', 3)).toBe(deletedElementKey('Bus', '3'));
    expect(deletedElementKey('Bus', 3)).not.toBe(deletedElementKey('PV', 3));
  });

  it('clearDisturbances forgets what was removed with deleted elements', () => {
    const a = store().addDisturbance(fault('3'));
    const key = deletedElementKey('Bus', 3);
    store().removeWith(key, [a.id]);

    store().clearDisturbances();

    expect(store().removedWith).toEqual({});
    expect(store().restoreWith(key)).toBe(0);
  });
});
