/**
 * Tests for the connectivity store (Unit 17 of the v2.0 plan).
 *
 * Covers:
 *
 * - Initial state (null result, empty energised set).
 * - ``setResult`` derives the energised set from non-trivial islands;
 *   singletons are *excluded* from the energised set (matching ANDES's
 *   ``Bus.island_sets`` convention — degree-zero buses sit outside
 *   the connected components).
 * - ``setResult(null)`` clears both the result and the derived set.
 * - ``clear`` resets both fields.
 * - The pure helpers (``isEnergisedIsland``, ``energisedBusIdxesFor``)
 *   match the documented contract for the canonical scenarios:
 *   stock IEEE 14 (1 island, all buses energised) and a tripped-line
 *   IEEE 14 (2 islands: 13-bus connected component + lone bus 8).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  energisedBusIdxesFor,
  isEnergisedIsland,
  useConnectivityStore,
} from '@/store/connectivity';
import type { ConnectivityResult } from '@/api/types';

function reset() {
  useConnectivityStore.setState({
    result: null,
    energisedBusIdxes: new Set<string>(),
  });
}

beforeEach(reset);

describe('connectivity store — initial state', () => {
  it('starts with a null result and an empty energised set', () => {
    const state = useConnectivityStore.getState();
    expect(state.result).toBeNull();
    expect(state.energisedBusIdxes.size).toBe(0);
  });
});

describe('connectivity store — setResult', () => {
  it('stores the result and derives the energised set from islands of size > 1', () => {
    const result: ConnectivityResult = {
      island_count: 1,
      islands: [['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14']],
      islanded_bus_idxes: [],
    };
    useConnectivityStore.getState().setResult(result);
    const state = useConnectivityStore.getState();
    expect(state.result).toBe(result);
    expect(state.energisedBusIdxes.size).toBe(14);
    // Spot-check a few buses to confirm membership is keyed by string idx.
    expect(state.energisedBusIdxes.has('1')).toBe(true);
    expect(state.energisedBusIdxes.has('14')).toBe(true);
  });

  it('excludes singleton-island buses from the energised set', () => {
    // IEEE 14 with Line_20 tripped: bus 8 is islanded, the other 13
    // are interconnected. ANDES emits singletons-first in
    // ``Bus.islands`` per ``_post_process_islands``.
    const result: ConnectivityResult = {
      island_count: 2,
      islands: [
        ['8'],
        ['1', '2', '3', '4', '5', '6', '7', '9', '10', '11', '12', '13', '14'],
      ],
      islanded_bus_idxes: ['8'],
    };
    useConnectivityStore.getState().setResult(result);
    const energised = useConnectivityStore.getState().energisedBusIdxes;
    expect(energised.has('8')).toBe(false);
    expect(energised.has('1')).toBe(true);
    expect(energised.has('14')).toBe(true);
    expect(energised.size).toBe(13);
  });

  it('handles a null payload by clearing both fields', () => {
    useConnectivityStore.getState().setResult({
      island_count: 1,
      islands: [['1', '2']],
      islanded_bus_idxes: [],
    });
    expect(useConnectivityStore.getState().result).not.toBeNull();
    useConnectivityStore.getState().setResult(null);
    const state = useConnectivityStore.getState();
    expect(state.result).toBeNull();
    expect(state.energisedBusIdxes.size).toBe(0);
  });

  it('handles all-singletons (every bus de-energised) → empty energised set', () => {
    const result: ConnectivityResult = {
      island_count: 3,
      islands: [['1'], ['2'], ['3']],
      islanded_bus_idxes: ['1', '2', '3'],
    };
    useConnectivityStore.getState().setResult(result);
    expect(useConnectivityStore.getState().energisedBusIdxes.size).toBe(0);
  });
});

describe('connectivity store — clear', () => {
  it('returns the slice to its initial state', () => {
    useConnectivityStore.getState().setResult({
      island_count: 2,
      islands: [['1'], ['2', '3']],
      islanded_bus_idxes: ['1'],
    });
    useConnectivityStore.getState().clear();
    const state = useConnectivityStore.getState();
    expect(state.result).toBeNull();
    expect(state.energisedBusIdxes.size).toBe(0);
  });
});

describe('isEnergisedIsland helper', () => {
  it('treats islands of length > 1 as energised', () => {
    expect(isEnergisedIsland(['1', '2'])).toBe(true);
    expect(isEnergisedIsland(['1', '2', '3', '4'])).toBe(true);
  });

  it('treats singleton islands as de-energised', () => {
    expect(isEnergisedIsland(['8'])).toBe(false);
  });

  it('treats empty islands as de-energised (defensive)', () => {
    expect(isEnergisedIsland([])).toBe(false);
  });
});

describe('energisedBusIdxesFor helper', () => {
  it('returns an empty set for a null result', () => {
    expect(energisedBusIdxesFor(null).size).toBe(0);
  });

  it('returns the union of every non-trivial island', () => {
    const set = energisedBusIdxesFor({
      island_count: 3,
      islands: [['8'], ['1', '2'], ['3', '4', '5']],
      islanded_bus_idxes: ['8'],
    });
    expect(set.size).toBe(5);
    expect(set.has('8')).toBe(false);
    expect(set.has('1')).toBe(true);
    expect(set.has('5')).toBe(true);
  });
});
