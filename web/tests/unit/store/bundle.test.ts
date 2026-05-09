/**
 * Tests for the bundle store (Unit 3 of the v2.0 plan).
 *
 * Covers dialog open/close, mutation status transitions, error inline
 * surfacing, and reset behavior. The slice is intentionally minimal —
 * the actual export I/O lives in the queries layer + the dialog
 * component — so the tests focus on the state-machine contract.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useBundleStore } from '@/store/bundle';

function reset() {
  useBundleStore.setState({
    dialogOpen: false,
    previewFiles: [],
    status: 'idle',
    errorMessage: null,
    lastExportedFilename: null,
  });
}

beforeEach(reset);

describe('bundle store — dialog lifecycle', () => {
  it('starts closed with idle status', () => {
    const state = useBundleStore.getState();
    expect(state.dialogOpen).toBe(false);
    expect(state.status).toBe('idle');
    expect(state.errorMessage).toBeNull();
    expect(state.previewFiles).toEqual([]);
  });

  it('openDialog flips the dialog open and clears stale error', () => {
    useBundleStore.setState({ status: 'error', errorMessage: 'stale!' });
    useBundleStore.getState().openDialog();
    const state = useBundleStore.getState();
    expect(state.dialogOpen).toBe(true);
    expect(state.status).toBe('idle');
    expect(state.errorMessage).toBeNull();
  });

  it('closeDialog flips closed but preserves last-success state', () => {
    useBundleStore.getState().markSuccess('andes-bundle-abc.zip', [{ name: 'manifest.json' }]);
    useBundleStore.setState({ dialogOpen: true });
    useBundleStore.getState().closeDialog();
    const state = useBundleStore.getState();
    expect(state.dialogOpen).toBe(false);
    expect(state.lastExportedFilename).toBe('andes-bundle-abc.zip');
    expect(state.previewFiles).toHaveLength(1);
  });
});

describe('bundle store — mutation status transitions', () => {
  it('markPending sets status=pending and clears errorMessage', () => {
    useBundleStore.setState({ status: 'error', errorMessage: 'oops' });
    useBundleStore.getState().markPending();
    expect(useBundleStore.getState().status).toBe('pending');
    expect(useBundleStore.getState().errorMessage).toBeNull();
  });

  it('markSuccess records the filename + preview list', () => {
    useBundleStore.getState().markPending();
    useBundleStore
      .getState()
      .markSuccess('andes-bundle-abc.zip', [
        { name: 'case/ieee14.raw' },
        { name: 'manifest.json' },
      ]);
    const state = useBundleStore.getState();
    expect(state.status).toBe('success');
    expect(state.lastExportedFilename).toBe('andes-bundle-abc.zip');
    expect(state.previewFiles).toEqual([{ name: 'case/ieee14.raw' }, { name: 'manifest.json' }]);
    expect(state.errorMessage).toBeNull();
  });

  it('markError sets status=error and surfaces the message', () => {
    useBundleStore.getState().markPending();
    useBundleStore.getState().markError('Export failed: 422');
    const state = useBundleStore.getState();
    expect(state.status).toBe('error');
    expect(state.errorMessage).toBe('Export failed: 422');
  });

  it('reset returns to the initial state', () => {
    useBundleStore.getState().markSuccess('andes-bundle-abc.zip', [{ name: 'manifest.json' }]);
    useBundleStore.setState({ dialogOpen: true });
    useBundleStore.getState().reset();
    const state = useBundleStore.getState();
    expect(state.dialogOpen).toBe(false);
    expect(state.status).toBe('idle');
    expect(state.previewFiles).toEqual([]);
    expect(state.errorMessage).toBeNull();
    expect(state.lastExportedFilename).toBeNull();
  });
});

describe('bundle store — preview files copy semantics', () => {
  it('markSuccess copies the input array (caller mutation does not affect store)', () => {
    const input = [{ name: 'manifest.json' }];
    useBundleStore.getState().markSuccess('a.zip', input);
    // Mutate the source array post-call.
    input.push({ name: 'late-addition.json' });
    expect(useBundleStore.getState().previewFiles).toHaveLength(1);
  });
});
