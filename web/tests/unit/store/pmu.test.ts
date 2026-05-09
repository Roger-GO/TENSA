/**
 * Tests for the PMU store (Unit 14 of the v2.0 plan).
 *
 * Covers:
 *
 * - Initial state (empty list).
 * - ``setPmus`` replaces the entire list.
 * - ``appendPmu`` adds a new entry; re-appending the same idx replaces
 *   (idempotent against refetch races).
 * - ``removePmu`` drops by idx; unknown idx is a no-op.
 * - ``clear`` resets to empty.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { usePmuStore } from '@/store/pmu';
import type { TopologyEntry } from '@/api/types';

function reset() {
  usePmuStore.setState({ pmus: [] });
}

beforeEach(reset);

function makePmu(idx: string, bus: string | number): TopologyEntry {
  return {
    idx,
    name: idx,
    kind: 'PMU',
    params: { bus, Ta: 0.05, Tv: 0.05 },
  };
}

describe('pmu store — initial state', () => {
  it('starts with an empty list', () => {
    expect(usePmuStore.getState().pmus).toEqual([]);
  });
});

describe('pmu store — setPmus', () => {
  it('replaces the entire list', () => {
    usePmuStore.getState().setPmus([makePmu('PMU_1', '1'), makePmu('PMU_2', '5')]);
    const list = usePmuStore.getState().pmus;
    expect(list.length).toBe(2);
    expect(list[0].idx).toBe('PMU_1');
    expect(list[1].idx).toBe('PMU_2');
  });

  it('clears via empty list', () => {
    usePmuStore.getState().setPmus([makePmu('PMU_1', '1')]);
    usePmuStore.getState().setPmus([]);
    expect(usePmuStore.getState().pmus).toEqual([]);
  });

  it('takes a defensive copy of the input array', () => {
    // Mutating the input after setPmus shouldn't affect the slice.
    const input = [makePmu('PMU_1', '1')];
    usePmuStore.getState().setPmus(input);
    input.push(makePmu('PMU_2', '5'));
    expect(usePmuStore.getState().pmus.length).toBe(1);
  });
});

describe('pmu store — appendPmu', () => {
  it('adds a new entry to the list', () => {
    usePmuStore.getState().appendPmu(makePmu('PMU_1', '1'));
    expect(usePmuStore.getState().pmus.length).toBe(1);
    usePmuStore.getState().appendPmu(makePmu('PMU_2', '5'));
    expect(usePmuStore.getState().pmus.map((p) => p.idx)).toEqual(['PMU_1', 'PMU_2']);
  });

  it('replaces the entry when re-appending the same idx (idempotent against refetch)', () => {
    usePmuStore.getState().appendPmu(makePmu('PMU_1', '1'));
    // Second call with the same idx but different params: the params
    // for PMU_1 update; no duplicate entry.
    usePmuStore.getState().appendPmu({
      idx: 'PMU_1',
      name: 'PMU_1',
      kind: 'PMU',
      params: { bus: '1', Ta: 0.07, Tv: 0.07 },
    });
    const list = usePmuStore.getState().pmus;
    expect(list.length).toBe(1);
    expect(list[0].params.Ta).toBe(0.07);
  });
});

describe('pmu store — removePmu', () => {
  it('drops the matching entry', () => {
    usePmuStore.getState().setPmus([
      makePmu('PMU_1', '1'),
      makePmu('PMU_2', '5'),
      makePmu('PMU_3', '9'),
    ]);
    usePmuStore.getState().removePmu('PMU_2');
    const list = usePmuStore.getState().pmus;
    expect(list.map((p) => p.idx)).toEqual(['PMU_1', 'PMU_3']);
  });

  it('is a no-op for an unknown idx', () => {
    usePmuStore.getState().setPmus([makePmu('PMU_1', '1')]);
    usePmuStore.getState().removePmu('PMU_999');
    expect(usePmuStore.getState().pmus.length).toBe(1);
  });
});

describe('pmu store — clear', () => {
  it('resets to the initial empty list', () => {
    usePmuStore.getState().setPmus([makePmu('PMU_1', '1'), makePmu('PMU_2', '5')]);
    usePmuStore.getState().clear();
    expect(usePmuStore.getState().pmus).toEqual([]);
  });
});
