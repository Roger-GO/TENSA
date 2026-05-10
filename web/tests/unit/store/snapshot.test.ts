/**
 * Tests for the snapshot store (Unit 7 of the v2.0 plan).
 *
 * Covers dialog open/close (save vs load are mutually exclusive),
 * mutation status transitions, error inline surfacing, the snapshot
 * listing cache, the restore-outcome record (used by the inline
 * fallback toast), and reset behavior.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useSnapshotStore } from '@/store/snapshot';

function reset() {
  useSnapshotStore.setState({
    saveDialogOpen: false,
    loadDialogOpen: false,
    pendingName: '',
    snapshots: [],
    saveStatus: 'idle',
    restoreStatus: 'idle',
    saveError: null,
    restoreError: null,
    lastRestoreOutcome: null,
  });
}

beforeEach(reset);

describe('snapshot store — dialog lifecycle', () => {
  it('starts with both dialogs closed and idle statuses', () => {
    const state = useSnapshotStore.getState();
    expect(state.saveDialogOpen).toBe(false);
    expect(state.loadDialogOpen).toBe(false);
    expect(state.saveStatus).toBe('idle');
    expect(state.restoreStatus).toBe('idle');
  });

  it('openSaveDialog opens the save dialog and clears stale state', () => {
    useSnapshotStore.setState({
      saveStatus: 'error',
      saveError: 'stale!',
      pendingName: 'old-name',
    });
    useSnapshotStore.getState().openSaveDialog();
    const state = useSnapshotStore.getState();
    expect(state.saveDialogOpen).toBe(true);
    expect(state.loadDialogOpen).toBe(false);
    expect(state.saveStatus).toBe('idle');
    expect(state.saveError).toBeNull();
    expect(state.pendingName).toBe('');
  });

  it('openLoadDialog opens the load dialog and closes the save dialog', () => {
    useSnapshotStore.setState({ saveDialogOpen: true });
    useSnapshotStore.getState().openLoadDialog();
    const state = useSnapshotStore.getState();
    expect(state.loadDialogOpen).toBe(true);
    expect(state.saveDialogOpen).toBe(false);
  });

  it('closeDialogs flips both dialogs closed', () => {
    useSnapshotStore.setState({ saveDialogOpen: true, loadDialogOpen: true });
    useSnapshotStore.getState().closeDialogs();
    const state = useSnapshotStore.getState();
    expect(state.saveDialogOpen).toBe(false);
    expect(state.loadDialogOpen).toBe(false);
  });
});

describe('snapshot store — pending name input', () => {
  it('setPendingName updates the input value', () => {
    useSnapshotStore.getState().setPendingName('scenario-A');
    expect(useSnapshotStore.getState().pendingName).toBe('scenario-A');
  });
});

describe('snapshot store — listing cache', () => {
  it('setSnapshots copies the input array', () => {
    const input = [
      {
        name: 'snap-a',
        saved_at: '2026-05-09T00:00:00Z',
        has_pflow: true,
        has_tds: false,
        has_dill: true,
        andes_version: '2.0.0',
        disturbance_count: 0,
      },
    ];
    useSnapshotStore.getState().setSnapshots(input);
    input.length = 0;
    expect(useSnapshotStore.getState().snapshots).toHaveLength(1);
  });
});

describe('snapshot store — save mutation status', () => {
  it('markSavePending sets pending and clears stale error', () => {
    useSnapshotStore.setState({ saveStatus: 'error', saveError: 'oops' });
    useSnapshotStore.getState().markSavePending();
    const state = useSnapshotStore.getState();
    expect(state.saveStatus).toBe('pending');
    expect(state.saveError).toBeNull();
  });

  it('markSaveSuccess sets success', () => {
    useSnapshotStore.getState().markSavePending();
    useSnapshotStore.getState().markSaveSuccess();
    expect(useSnapshotStore.getState().saveStatus).toBe('success');
    expect(useSnapshotStore.getState().saveError).toBeNull();
  });

  it('markSaveError surfaces the message', () => {
    useSnapshotStore.getState().markSaveError('Save failed: 422');
    const state = useSnapshotStore.getState();
    expect(state.saveStatus).toBe('error');
    expect(state.saveError).toBe('Save failed: 422');
  });
});

describe('snapshot store — restore mutation status + outcome', () => {
  it('markRestorePending sets pending', () => {
    useSnapshotStore.getState().markRestorePending();
    expect(useSnapshotStore.getState().restoreStatus).toBe('pending');
  });

  it('markRestoreSuccess records the outcome with no fallback_reason', () => {
    useSnapshotStore.getState().markRestoreSuccess({
      used_dill: true,
      fallback_reason: null,
      disturbances_replayed: 1,
      name: 'scenario-A',
    });
    const state = useSnapshotStore.getState();
    expect(state.restoreStatus).toBe('success');
    expect(state.lastRestoreOutcome?.used_dill).toBe(true);
    expect(state.lastRestoreOutcome?.fallback_reason).toBeNull();
  });

  it('markRestoreSuccess preserves a non-null fallback_reason', () => {
    useSnapshotStore.getState().markRestoreSuccess({
      used_dill: false,
      fallback_reason: 'ANDES version mismatch',
      disturbances_replayed: 2,
      name: 'scenario-A',
    });
    const outcome = useSnapshotStore.getState().lastRestoreOutcome;
    expect(outcome?.used_dill).toBe(false);
    expect(outcome?.fallback_reason).toBe('ANDES version mismatch');
    expect(outcome?.disturbances_replayed).toBe(2);
  });

  it('markRestoreError surfaces the message', () => {
    useSnapshotStore.getState().markRestoreError('Restore failed: 404');
    const state = useSnapshotStore.getState();
    expect(state.restoreStatus).toBe('error');
    expect(state.restoreError).toBe('Restore failed: 404');
  });
});

describe('snapshot store — reset', () => {
  it('reset returns the slice to its initial state', () => {
    useSnapshotStore.setState({
      saveDialogOpen: true,
      loadDialogOpen: true,
      pendingName: 'foo',
      snapshots: [
        {
          name: 'x',
          saved_at: 'now',
          has_pflow: false,
          has_tds: false,
          has_dill: false,
          andes_version: 'unknown',
          disturbance_count: 0,
        },
      ],
      saveStatus: 'success',
      restoreStatus: 'pending',
      saveError: 'err',
      restoreError: 'err',
      lastRestoreOutcome: {
        used_dill: true,
        fallback_reason: null,
        disturbances_replayed: 0,
        name: 'x',
      },
    });
    useSnapshotStore.getState().reset();
    const state = useSnapshotStore.getState();
    expect(state.saveDialogOpen).toBe(false);
    expect(state.loadDialogOpen).toBe(false);
    expect(state.pendingName).toBe('');
    expect(state.snapshots).toEqual([]);
    expect(state.saveStatus).toBe('idle');
    expect(state.restoreStatus).toBe('idle');
    expect(state.saveError).toBeNull();
    expect(state.restoreError).toBeNull();
    expect(state.lastRestoreOutcome).toBeNull();
  });
});
