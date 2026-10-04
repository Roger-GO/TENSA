/**
 * The unload guard cancels ``beforeunload`` (which makes the browser prompt) only
 * while the tab holds work that a reload would lose.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useUnsavedWorkGuard } from '@/lib/useUnsavedWorkGuard';
import { useEditJournalStore } from '@/store/editJournal';
import { useRunsStore } from '@/store/runs';
import { useCaseStore } from '@/store/case';
import { parseWorkspacePath } from '@/api/types';

/** Fire ``beforeunload`` the way the browser does and report whether it was cancelled. */
function leave(): { cancelled: boolean } {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return { cancelled: event.defaultPrevented };
}

beforeEach(() => {
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
  });
  useEditJournalStore.getState().reset();
  useRunsStore.getState().clearRuns();
});

afterEach(() => {
  useEditJournalStore.getState().reset();
  useRunsStore.getState().clearRuns();
  useCaseStore.setState({ selection: null });
});

describe('useUnsavedWorkGuard', () => {
  it('lets a tab with nothing to lose go without a prompt', () => {
    renderHook(() => useUnsavedWorkGuard());

    expect(leave().cancelled).toBe(false);
  });

  it('asks before a tab with unsaved edits is left', () => {
    renderHook(() => useUnsavedWorkGuard());
    useEditJournalStore.getState().record({ op: 'add', model: 'Bus', params: { idx: 1 } });

    expect(leave().cancelled).toBe(true);
  });

  it('asks before a tab holding run results is left', () => {
    renderHook(() => useUnsavedWorkGuard());
    useRunsStore.getState().startRun({ runId: 'r1', tf: 5, columnNames: ['Bus_1_v'] });

    expect(leave().cancelled).toBe(true);
  });

  it('reads the state at the moment of leaving, not when it was mounted', () => {
    renderHook(() => useUnsavedWorkGuard());
    useEditJournalStore.getState().record({ op: 'add', model: 'Bus', params: { idx: 1 } });
    expect(leave().cancelled).toBe(true);

    useEditJournalStore.getState().markSaved();

    expect(leave().cancelled).toBe(false);
  });

  it('stops asking once the app unmounts', () => {
    const { unmount } = renderHook(() => useUnsavedWorkGuard());
    useEditJournalStore.getState().record({ op: 'add', model: 'Bus', params: { idx: 1 } });
    unmount();

    expect(leave().cancelled).toBe(false);
  });
});
