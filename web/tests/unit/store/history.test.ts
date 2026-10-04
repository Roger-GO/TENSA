/**
 * Tests for the history store (Unit 9 of the v2.0 plan).
 *
 * Minimal slice — owns drawer open/close + a transient toast string.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useHistoryStore } from '@/store/history';

function reset() {
  useHistoryStore.setState({ drawerOpen: false, toastMessage: null, renamingRunId: null });
}

beforeEach(reset);

describe('history store — drawer lifecycle', () => {
  it('starts closed with no toast', () => {
    const state = useHistoryStore.getState();
    expect(state.drawerOpen).toBe(false);
    expect(state.toastMessage).toBeNull();
  });

  it('openDrawer flips the drawer open and clears stale toast', () => {
    useHistoryStore.setState({ toastMessage: 'stale' });
    useHistoryStore.getState().openDrawer();
    const state = useHistoryStore.getState();
    expect(state.drawerOpen).toBe(true);
    expect(state.toastMessage).toBeNull();
  });

  it('closeDrawer flips closed but preserves last toast', () => {
    useHistoryStore.setState({ drawerOpen: true, toastMessage: 'Pinned' });
    useHistoryStore.getState().closeDrawer();
    const state = useHistoryStore.getState();
    expect(state.drawerOpen).toBe(false);
    expect(state.toastMessage).toBe('Pinned');
  });

  it('setToast updates the toast string; passing null clears it', () => {
    useHistoryStore.getState().setToast('Pinned to overlay');
    expect(useHistoryStore.getState().toastMessage).toBe('Pinned to overlay');
    useHistoryStore.getState().setToast(null);
    expect(useHistoryStore.getState().toastMessage).toBeNull();
  });

  it('reset returns to the initial state', () => {
    useHistoryStore.setState({ drawerOpen: true, toastMessage: 'something', renamingRunId: 'r1' });
    useHistoryStore.getState().reset();
    const state = useHistoryStore.getState();
    expect(state.drawerOpen).toBe(false);
    expect(state.toastMessage).toBeNull();
    expect(state.renamingRunId).toBeNull();
  });
});

describe('history store — renaming a run', () => {
  it('starts with no run being renamed', () => {
    expect(useHistoryStore.getState().renamingRunId).toBeNull();
  });

  it('startRenaming opens the drawer on that run', () => {
    useHistoryStore.getState().startRenaming('r1');
    const state = useHistoryStore.getState();
    expect(state.drawerOpen).toBe(true);
    expect(state.renamingRunId).toBe('r1');
  });

  it('stopRenaming leaves the drawer open', () => {
    useHistoryStore.getState().startRenaming('r1');
    useHistoryStore.getState().stopRenaming();
    const state = useHistoryStore.getState();
    expect(state.renamingRunId).toBeNull();
    expect(state.drawerOpen).toBe(true);
  });

  it('closing the drawer drops a rename that was still being typed', () => {
    useHistoryStore.getState().startRenaming('r1');
    useHistoryStore.getState().closeDrawer();
    expect(useHistoryStore.getState().renamingRunId).toBeNull();
  });
});
