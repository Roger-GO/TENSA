/**
 * useProfilesStore — append/remove/set/clear semantics for the
 * TimeSeries profile slice (Unit 15).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useProfilesStore } from '@/store/profiles';
import type { TopologyEntry } from '@/api/types';

const PROFILE_A: TopologyEntry = {
  idx: 'TimeSeries_1',
  name: 'TimeSeries_1',
  kind: 'TimeSeries',
  params: { mode: 1, model: 'PQ', dev: 'PQ_5', tkey: 't' },
};
const PROFILE_B: TopologyEntry = {
  idx: 'TimeSeries_2',
  name: 'TimeSeries_2',
  kind: 'TimeSeries',
  params: { mode: 1, model: 'PV', dev: 'PV_3', tkey: 't' },
};

describe('useProfilesStore', () => {
  beforeEach(() => {
    useProfilesStore.setState({ profiles: [] });
  });

  it('starts empty', () => {
    expect(useProfilesStore.getState().profiles).toEqual([]);
  });

  it('setProfiles replaces the entire list', () => {
    useProfilesStore.getState().setProfiles([PROFILE_A]);
    expect(useProfilesStore.getState().profiles).toEqual([PROFILE_A]);
    useProfilesStore.getState().setProfiles([PROFILE_B]);
    expect(useProfilesStore.getState().profiles).toEqual([PROFILE_B]);
  });

  it('setProfiles defensively copies the input', () => {
    const input = [PROFILE_A];
    useProfilesStore.getState().setProfiles(input);
    // mutating the input array shouldn't leak into the store.
    input.push(PROFILE_B);
    expect(useProfilesStore.getState().profiles).toEqual([PROFILE_A]);
  });

  it('appendProfile adds a new entry at the end', () => {
    useProfilesStore.getState().setProfiles([PROFILE_A]);
    useProfilesStore.getState().appendProfile(PROFILE_B);
    expect(useProfilesStore.getState().profiles.map((p) => String(p.idx))).toEqual([
      'TimeSeries_1',
      'TimeSeries_2',
    ]);
  });

  it('appendProfile is idempotent on the same idx (replaces, no duplicates)', () => {
    useProfilesStore.getState().setProfiles([PROFILE_A]);
    const updated: TopologyEntry = {
      ...PROFILE_A,
      params: { ...PROFILE_A.params, dev: 'PQ_8' },
    };
    useProfilesStore.getState().appendProfile(updated);
    const state = useProfilesStore.getState().profiles;
    expect(state).toHaveLength(1);
    expect(state[0]?.params?.dev).toBe('PQ_8');
  });

  it('removeProfile drops the entry by idx', () => {
    useProfilesStore.getState().setProfiles([PROFILE_A, PROFILE_B]);
    useProfilesStore.getState().removeProfile('TimeSeries_1');
    expect(useProfilesStore.getState().profiles.map((p) => String(p.idx))).toEqual([
      'TimeSeries_2',
    ]);
  });

  it('removeProfile is no-op for unknown idx', () => {
    useProfilesStore.getState().setProfiles([PROFILE_A]);
    useProfilesStore.getState().removeProfile('TimeSeries_999');
    expect(useProfilesStore.getState().profiles).toEqual([PROFILE_A]);
  });

  it('clear empties the slice', () => {
    useProfilesStore.getState().setProfiles([PROFILE_A, PROFILE_B]);
    useProfilesStore.getState().clear();
    expect(useProfilesStore.getState().profiles).toEqual([]);
  });
});
