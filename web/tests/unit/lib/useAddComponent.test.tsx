/**
 * Adding a component by kind from outside the Add element form: a click on a
 * row of the palette opens the form (`add`), and a row dropped where no
 * diagram is drawn yet places a draft (`place`). With no case open either
 * first starts a blank system, and neither does anything while a run has
 * locked the system.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { ProblemDetailsError } from '@/api/client';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';

const blankMutate = vi.fn();
let mockTopology: TopologySummary | null = null;
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => mockTopology,
    useBlankSystem: () => ({ mutate: blankMutate, isPending: false }),
  };
});

const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { useAddComponent } from '@/lib/useAddComponent';
import { useCaseStore } from '@/store/case';
import { BLANK_CASE_KEY, useDraftsStore } from '@/store/drafts';
import { usePflowStore } from '@/store/pflow';
import { useReloadedCaseStore } from '@/store/reloadedCase';
import { useSessionStore } from '@/store/session';
import { useSldStore } from '@/store/sld';

const CASE = 'ieee14.raw';
const topology = (state: TopologySummary['state']): TopologySummary => ({
  state,
  buses: [],
  lines: [],
  transformers: [],
  generators: [],
  loads: [],
  shunts: [],
});

beforeEach(() => {
  blankMutate.mockReset();
  toastError.mockReset();
  mockTopology = null;
  useSessionStore.setState({ sessionId: parseSessionId('s-1') });
  useCaseStore.getState().clearCase();
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useDraftsStore.setState({ byCase: {}, placements: {} });
  useSldStore.getState().clearSelectedNodeId();
});

afterEach(() => {
  cleanup();
  useCaseStore.getState().clearCase();
  useDraftsStore.setState({ byCase: {}, placements: {} });
});

describe('placing a draft where no diagram is drawn yet', () => {
  it('starts a blank system first with no case open, then places the draft on it, picked', async () => {
    const { result } = renderHook(() => useAddComponent());
    act(() => result.current.place('Bus'));
    expect(blankMutate).toHaveBeenCalledTimes(1);
    expect(blankMutate.mock.calls[0]?.[0]).toBe('s-1');
    // Nothing is placed until the server has made the system.
    expect(useDraftsStore.getState().byCase).toEqual({});
    const callbacks = blankMutate.mock.calls[0]?.[1] as { onSuccess: () => void };
    // The drafts are the diagram's, whose code is fetched for this drop.
    await act(async () => {
      callbacks.onSuccess();
      await vi.dynamicImportSettled();
    });
    expect(useCaseStore.getState().selection).toMatchObject({ blank: true, primaryPath: null });
    expect(useDraftsStore.getState().byCase[BLANK_CASE_KEY]).toMatchObject([{ kind: 'Bus' }]);
    expect(useSldStore.getState().selectedNodeId).toBe('draft-1');
    // No form is opened over it: the Inspector has the draft's own.
    expect(useCaseStore.getState().addPanelOpen).toBe(false);
  });

  it('places the draft on the case that is open', async () => {
    mockTopology = topology('pre-setup');
    useCaseStore.setState({ selection: { primaryPath: parseWorkspacePath(CASE), addfiles: [] } });
    const { result } = renderHook(() => useAddComponent());
    await act(async () => {
      result.current.place('PQ');
      await vi.dynamicImportSettled();
    });
    expect(blankMutate).not.toHaveBeenCalled();
    expect(useDraftsStore.getState().byCase[CASE]).toMatchObject([{ kind: 'PQ' }]);
  });

  it('hands a system that cannot be started to the caller, in words', () => {
    const { result } = renderHook(() => useAddComponent());
    const onError = vi.fn();
    act(() => result.current.place('Bus', onError));
    const callbacks = blankMutate.mock.calls[0]?.[1] as { onError: (e: Error) => void };
    act(() =>
      callbacks.onError(
        new ProblemDetailsError({ status: 409, title: 'Conflict', type: 'about:blank' }),
      ),
    );
    expect(onError).toHaveBeenCalledWith(
      'A system is already loaded; discard it first or open a fresh tab.',
    );
    expect(toastError).not.toHaveBeenCalled();
    expect(useDraftsStore.getState().byCase).toEqual({});
  });

  it('does nothing while a run has locked the system, and says why', async () => {
    mockTopology = topology('committed');
    useCaseStore.setState({ selection: { primaryPath: parseWorkspacePath(CASE), addfiles: [] } });
    const { result } = renderHook(() => useAddComponent());
    expect(result.current.blockedReason).toMatch(/^A run has fixed the system\. Reset run lets/);
    expect(result.current.lockedByRun).toBe(true);
    await act(async () => {
      result.current.place('PQ');
      await vi.dynamicImportSettled();
    });
    expect(useDraftsStore.getState().byCase).toEqual({});
  });
});

describe('after a reload of the page, while the case it had open is on its way back', () => {
  afterEach(() => useReloadedCaseStore.setState({ closed: null }));

  it('starts no blank system in its way, and says why', async () => {
    useReloadedCaseStore.setState({ closed: { primaryPath: CASE, addfiles: [] } });
    const { result, rerender } = renderHook(() => useAddComponent());
    expect(result.current.blockedReason).toBe('The case this page had open is being opened again.');
    expect(result.current.lockedByRun).toBe(false);
    act(() => result.current.add('Bus'));
    await act(async () => {
      result.current.place('Bus');
      await vi.dynamicImportSettled();
    });
    expect(blankMutate).not.toHaveBeenCalled();
    // Once the case is open, or could not be opened, adding is as ever.
    act(() => useReloadedCaseStore.setState({ closed: null }));
    rerender();
    expect(result.current.blockedReason).toBeNull();
  });
});

describe('opening the form on a kind', () => {
  it('opens it at once on a case that is open, and after the blank system with none', () => {
    const { result, rerender } = renderHook(() => useAddComponent());
    act(() => result.current.add('PV'));
    expect(useCaseStore.getState().addPanelOpen).toBe(false);
    const callbacks = blankMutate.mock.calls[0]?.[1] as { onSuccess: () => void };
    act(() => callbacks.onSuccess());
    expect(useCaseStore.getState()).toMatchObject({ addPanelOpen: true, addPanelKind: 'PV' });
    // With the system there, the next one opens directly.
    mockTopology = topology('pre-setup');
    rerender();
    act(() => result.current.add('PQ'));
    expect(blankMutate).toHaveBeenCalledTimes(1);
    expect(useCaseStore.getState().addPanelKind).toBe('PQ');
  });
});
