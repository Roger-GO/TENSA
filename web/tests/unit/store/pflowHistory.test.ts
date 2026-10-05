/**
 * Tests for the power-flow history slice: which results it keeps, which one a
 * newer run pushes out, and which two are compared.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRunId } from '@/api/types';
import type { PflowResult } from '@/api/types';
import { NO_ELEMENT_NAMES } from '@/lib/elementNames';
import {
  MAX_PFLOW_SNAPSHOTS,
  resolveComparePair,
  snapshotLabel,
  usePflowHistoryStore,
  type PflowSnapshot,
} from '@/store/pflowHistory';

function result(id: string, overrides: Partial<PflowResult> = {}): PflowResult {
  return {
    run_id: parseRunId(id),
    converged: true,
    iterations: 3,
    mismatch: 1e-9,
    bus_voltages: { '1': 1.0 },
    bus_angles: { '1': 0 },
    line_flows: {},
    ...overrides,
  };
}

const CONTEXT = { caseName: 'ieee14', names: NO_ELEMENT_NAMES };

function record(id: string, overrides: Partial<PflowResult> = {}): void {
  usePflowHistoryStore.getState().record(result(id, overrides), CONTEXT);
}

function ids(): string[] {
  return usePflowHistoryStore.getState().snapshots.map((s) => s.id);
}

function pair(): [string | null, string | null] {
  const { a, b } = resolveComparePair(usePflowHistoryStore.getState());
  return [a?.id ?? null, b?.id ?? null];
}

beforeEach(() => {
  usePflowHistoryStore.getState().clear();
});

afterEach(() => {
  vi.useRealTimers();
  usePflowHistoryStore.getState().clear();
});

describe('pflow history: record', () => {
  it('keeps a converged result with its case, its names, a number and the time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T10:00:00Z'));
    const names = { ...NO_ELEMENT_NAMES, buses: { '1': 'North' } };
    usePflowHistoryStore.getState().record(result('pf-1'), { caseName: 'kundur_full', names });

    const [snapshot] = usePflowHistoryStore.getState().snapshots;
    expect(snapshot).toMatchObject({ id: 'pf-1', ordinal: 1, caseName: 'kundur_full', names });
    expect(snapshot?.takenAt).toBe(Date.parse('2026-03-04T10:00:00Z'));
    expect(snapshot?.result.bus_voltages).toEqual({ '1': 1.0 });
    expect(snapshot).not.toHaveProperty('name');
  });

  it('ignores a power flow that did not converge', () => {
    record('pf-1', { converged: false });
    expect(ids()).toEqual([]);
    expect(usePflowHistoryStore.getState().count).toBe(0);
  });

  it('numbers the results in the order they were solved, and never reuses a number', () => {
    record('pf-1');
    record('pf-2');
    usePflowHistoryStore.getState().remove('pf-2');
    record('pf-3');
    expect(usePflowHistoryStore.getState().snapshots.map((s) => s.ordinal)).toEqual([1, 3]);
  });

  it('keeps the newest results and pushes out the oldest past the cap', () => {
    for (let i = 1; i <= MAX_PFLOW_SNAPSHOTS + 2; i += 1) record(`pf-${i}`);
    expect(ids()).toHaveLength(MAX_PFLOW_SNAPSHOTS);
    expect(ids()[0]).toBe('pf-3');
    expect(ids().at(-1)).toBe(`pf-${MAX_PFLOW_SNAPSHOTS + 2}`);
  });

  it('spares a named result and the reference when it pushes one out', () => {
    for (let i = 1; i <= MAX_PFLOW_SNAPSHOTS; i += 1) record(`pf-${i}`);
    usePflowHistoryStore.getState().rename('pf-1', 'Base case');
    usePflowHistoryStore.getState().setBaseline('pf-2');

    record('pf-next');

    expect(ids()).toHaveLength(MAX_PFLOW_SNAPSHOTS);
    expect(ids().slice(0, 3)).toEqual(['pf-1', 'pf-2', 'pf-4']);
    expect(usePflowHistoryStore.getState().baselineId).toBe('pf-2');
  });

  it('still holds the cap when every result is named', () => {
    for (let i = 1; i <= MAX_PFLOW_SNAPSHOTS; i += 1) {
      record(`pf-${i}`);
      usePflowHistoryStore.getState().rename(`pf-${i}`, `Case ${i}`);
    }
    record('pf-next');
    expect(ids()).toHaveLength(MAX_PFLOW_SNAPSHOTS);
    expect(ids()).not.toContain('pf-1');
    expect(ids().at(-1)).toBe('pf-next');
  });
});

describe('pflow history: rename and remove', () => {
  it('names a result, trims the name, and an empty name puts the default label back', () => {
    record('pf-1');
    usePflowHistoryStore.getState().rename('pf-1', '  Line 5 out  ');
    expect(usePflowHistoryStore.getState().snapshots[0]?.name).toBe('Line 5 out');
    expect(snapshotLabel(usePflowHistoryStore.getState().snapshots[0]!)).toBe('Line 5 out');

    usePflowHistoryStore.getState().rename('pf-1', '   ');
    expect(usePflowHistoryStore.getState().snapshots[0]).not.toHaveProperty('name');
    expect(snapshotLabel(usePflowHistoryStore.getState().snapshots[0]!)).toBe('PF #1');
  });

  it('leaves the list as it is when a rename changes nothing', () => {
    record('pf-1');
    const before = usePflowHistoryStore.getState().snapshots;
    usePflowHistoryStore.getState().rename('pf-1', '');
    usePflowHistoryStore.getState().rename('missing', 'x');
    expect(usePflowHistoryStore.getState().snapshots).toBe(before);
  });

  it('drops a result, and a pick that named it', () => {
    record('pf-1');
    record('pf-2');
    record('pf-3');
    usePflowHistoryStore.getState().setBaseline('pf-1');
    usePflowHistoryStore.getState().setCompared('pf-2');

    usePflowHistoryStore.getState().remove('pf-1');
    expect(usePflowHistoryStore.getState().baselineId).toBeNull();
    expect(usePflowHistoryStore.getState().comparedId).toBe('pf-2');

    usePflowHistoryStore.getState().remove('pf-2');
    expect(usePflowHistoryStore.getState().comparedId).toBeNull();
    expect(ids()).toEqual(['pf-3']);
  });

  it('clear drops everything and starts numbering again', () => {
    record('pf-1');
    usePflowHistoryStore.getState().setBaseline('pf-1');
    usePflowHistoryStore.getState().clear();
    expect(usePflowHistoryStore.getState()).toMatchObject({
      snapshots: [],
      count: 0,
      baselineId: null,
      comparedId: null,
    });
    record('pf-2');
    expect(usePflowHistoryStore.getState().snapshots[0]?.ordinal).toBe(1);
  });
});

describe('pflow history: which two are compared', () => {
  it('has nothing to compare with no result, and no reference with one', () => {
    expect(pair()).toEqual([null, null]);
    record('pf-1');
    expect(pair()).toEqual([null, 'pf-1']);
  });

  it('compares the latest with the one before it, and follows each new run', () => {
    record('pf-1');
    record('pf-2');
    expect(pair()).toEqual(['pf-1', 'pf-2']);
    record('pf-3');
    expect(pair()).toEqual(['pf-2', 'pf-3']);
  });

  it('keeps a picked reference while B goes on following the latest', () => {
    record('pf-1');
    record('pf-2');
    usePflowHistoryStore.getState().setBaseline('pf-1');
    record('pf-3');
    record('pf-4');
    expect(pair()).toEqual(['pf-1', 'pf-4']);
  });

  it('treats picking the latest as B as "the latest", not as that run', () => {
    record('pf-1');
    record('pf-2');
    usePflowHistoryStore.getState().setCompared('pf-2');
    expect(usePflowHistoryStore.getState().comparedId).toBeNull();
    record('pf-3');
    expect(pair()[1]).toBe('pf-3');
  });

  it('keeps an older result picked as B, with the one before it as the reference', () => {
    record('pf-1');
    record('pf-2');
    record('pf-3');
    usePflowHistoryStore.getState().setCompared('pf-2');
    record('pf-4');
    expect(pair()).toEqual(['pf-1', 'pf-2']);
  });

  it('never compares a result with itself', () => {
    record('pf-1');
    record('pf-2');
    // The oldest as B has nothing before it: the one after it is the reference.
    usePflowHistoryStore.getState().setCompared('pf-1');
    expect(pair()).toEqual(['pf-2', 'pf-1']);
    // A reference that is also B is no reference.
    usePflowHistoryStore.getState().setBaseline('pf-1');
    expect(pair()).toEqual(['pf-2', 'pf-1']);
  });

  it('ignores a pick of a result that is not kept', () => {
    record('pf-1');
    usePflowHistoryStore.getState().setBaseline('gone');
    usePflowHistoryStore.getState().setCompared('gone');
    expect(usePflowHistoryStore.getState()).toMatchObject({ baselineId: null, comparedId: null });
  });
});

describe('pflow history: restore', () => {
  function kept(id: string, ordinal: number, name?: string): PflowSnapshot {
    return {
      id,
      ordinal,
      takenAt: 1_000 * ordinal,
      caseName: 'ieee14',
      result: result(id),
      names: NO_ELEMENT_NAMES,
      ...(name === undefined ? {} : { name }),
    };
  }

  it('puts back what was kept, with its picks and its numbering', () => {
    usePflowHistoryStore.getState().restore({
      snapshots: [kept('pf-1', 1, 'Base'), kept('pf-4', 4)],
      count: 6,
      baselineId: 'pf-1',
      comparedId: null,
    });
    expect(ids()).toEqual(['pf-1', 'pf-4']);
    expect(usePflowHistoryStore.getState().baselineId).toBe('pf-1');
    // The next result does not take a number that was already given out.
    record('pf-new');
    expect(usePflowHistoryStore.getState().snapshots.at(-1)?.ordinal).toBe(7);
  });

  it('goes in front of results recorded since, and does not double one already there', () => {
    record('pf-live');
    usePflowHistoryStore.getState().restore({
      snapshots: [kept('pf-old', 3), kept('pf-live', 9, 'stale copy')],
      count: 3,
      baselineId: null,
      comparedId: null,
    });
    expect(ids()).toEqual(['pf-old', 'pf-live']);
    expect(usePflowHistoryStore.getState().snapshots[1]).not.toHaveProperty('name');
    expect(usePflowHistoryStore.getState().count).toBe(3);
  });

  it('drops a restored pick whose result did not come back, and holds the cap', () => {
    const many = Array.from({ length: MAX_PFLOW_SNAPSHOTS + 3 }, (_, i) =>
      kept(`pf-${i + 1}`, i + 1),
    );
    usePflowHistoryStore.getState().restore({
      snapshots: many,
      count: many.length,
      baselineId: 'pf-missing',
      comparedId: 'pf-5',
    });
    expect(ids()).toHaveLength(MAX_PFLOW_SNAPSHOTS);
    expect(usePflowHistoryStore.getState().baselineId).toBeNull();
    expect(usePflowHistoryStore.getState().comparedId).toBe('pf-5');
  });
});
