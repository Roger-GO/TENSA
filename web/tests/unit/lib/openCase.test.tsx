/**
 * Opening a case file: which workspace files count as cases, and what the hook
 * does with a pick. The saved-cases list and the palette's Open case page share
 * both, so both are pinned here as well as through them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import { isPrimaryCase, useOpenCase } from '@/lib/openCase';
import { toast } from '@/lib/toast';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { WorkspaceFile } from '@/api/types';
import { ProblemDetailsError } from '@/api/client';

const mutateAsync = vi.fn();
let pending = false;
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return { ...actual, useLoadCase: () => ({ mutateAsync, isPending: pending }) };
});

const file = (name: string, format: string): WorkspaceFile =>
  ({ name, format, size_bytes: 1, modified_iso: '2026-10-01T00:00:00Z' }) as WorkspaceFile;

beforeEach(() => {
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue({});
  pending = false;
  useSessionStore.setState({ sessionId: parseSessionId('s1') });
  useCaseStore.setState({ selection: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isPrimaryCase', () => {
  it('accepts the four case formats', () => {
    for (const f of ['xlsx', 'raw', 'json', 'm']) {
      expect(isPrimaryCase(file(`case.${f}`, f))).toBe(true);
    }
  });

  it('rejects layout sidecars, which are json, and formats a session cannot load', () => {
    expect(isPrimaryCase(file('case.raw.layout.json', 'json'))).toBe(false);
    expect(isPrimaryCase(file('case.dyr', 'dyr'))).toBe(false);
    expect(isPrimaryCase(file('notes.txt', 'txt'))).toBe(false);
  });
});

describe('useOpenCase', () => {
  it('loads the file with no addfiles, and records the case once it has loaded', async () => {
    let finish: (value: unknown) => void = () => {};
    mutateAsync.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { result } = renderHook(() => useOpenCase());
    result.current.openCase('cases/ieee14.raw');
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0]?.[0]).toEqual({
      sessionId: 's1',
      request: { primary_path: 'cases/ieee14.raw', addfiles: null },
    });
    // Not recorded while the load runs.
    expect(useCaseStore.getState().selection).toBeNull();
    finish({});
    await waitFor(() =>
      expect(useCaseStore.getState().selection).toMatchObject({
        primaryPath: 'cases/ieee14.raw',
        addfiles: [],
      }),
    );
  });

  it('loads the case with the dynamic files it is given, and records them', async () => {
    const { result } = renderHook(() => useOpenCase());
    result.current.openCase('ieee14.raw', ['ieee14.dyr']);
    expect(mutateAsync.mock.calls[0]?.[0]).toEqual({
      sessionId: 's1',
      request: { primary_path: 'ieee14.raw', addfiles: ['ieee14.dyr'] },
    });
    await waitFor(() =>
      expect(useCaseStore.getState().selection).toMatchObject({
        primaryPath: 'ieee14.raw',
        addfiles: ['ieee14.dyr'],
      }),
    );
  });

  it('loads nothing for the case that is already open with the same dynamic files', () => {
    useCaseStore.setState({
      selection: {
        primaryPath: parseWorkspacePath('ieee14.raw'),
        addfiles: [parseWorkspacePath('ieee14.dyr')],
      },
    });
    const { result } = renderHook(() => useOpenCase());
    result.current.openCase('ieee14.raw', ['ieee14.dyr']);
    expect(mutateAsync).not.toHaveBeenCalled();
    // Other files, or none, make it a different case to open.
    result.current.openCase('ieee14.raw', ['other.dyr']);
    result.current.openCase('ieee14.raw');
    expect(mutateAsync).toHaveBeenCalledTimes(2);
  });

  it('loads nothing for a file that is being opened at this moment', () => {
    // A second click on its row, or a click while the page opens it again
    // after a reload: the session is busy with the first load and would
    // refuse a second.
    useCaseStore.setState({ loadingPath: parseWorkspacePath('ieee14.raw') });
    try {
      const { result } = renderHook(() => useOpenCase());
      result.current.openCase('ieee14.raw');
      expect(mutateAsync).not.toHaveBeenCalled();
      // Another file is another matter.
      result.current.openCase('kundur.xlsx');
      expect(mutateAsync).toHaveBeenCalledTimes(1);
    } finally {
      useCaseStore.setState({ loadingPath: null });
    }
  });

  it('refuses a dynamic file path that leaves the workspace, with a toast', () => {
    const error = vi.spyOn(toast, 'error').mockReturnValue('id');
    const { result } = renderHook(() => useOpenCase());
    result.current.openCase('ieee14.raw', ['../outside.dyr']);
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Invalid workspace path'));
  });

  it('loads nothing for the case that is already open', () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    });
    const { result } = renderHook(() => useOpenCase());
    result.current.openCase('ieee14.raw');
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('reloads the open case when it was opened with addfiles, since this opens it without them', () => {
    useCaseStore.setState({
      selection: {
        primaryPath: parseWorkspacePath('ieee14.raw'),
        addfiles: [parseWorkspacePath('ieee14.dyr')],
      },
    });
    const { result } = renderHook(() => useOpenCase());
    result.current.openCase('ieee14.raw');
    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a session', () => {
    useSessionStore.setState({ sessionId: null });
    const { result } = renderHook(() => useOpenCase());
    result.current.openCase('ieee14.raw');
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('refuses a path that leaves the workspace, with a toast', () => {
    const error = vi.spyOn(toast, 'error').mockReturnValue('id');
    const { result } = renderHook(() => useOpenCase());
    result.current.openCase('../outside.raw');
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Invalid workspace path'));
  });

  it('says why a load failed, from the problem details when the server gave them', async () => {
    const error = vi.spyOn(toast, 'error').mockReturnValue('id');
    const { result } = renderHook(() => useOpenCase());
    mutateAsync.mockRejectedValueOnce(
      new ProblemDetailsError({
        type: 'about:blank',
        title: 'Unprocessable',
        status: 422,
        detail: 'bad.raw has no Bus section',
        instance: null,
      }),
    );
    result.current.openCase('bad.raw');
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith('Load failed: bad.raw has no Bus section'),
    );
    mutateAsync.mockRejectedValueOnce(new Error('network down'));
    result.current.openCase('bad2.raw');
    await waitFor(() => expect(error).toHaveBeenLastCalledWith('Load failed: network down'));
    expect(useCaseStore.getState().selection).toBeNull();
  });

  it('reports a load in flight', () => {
    pending = true;
    const { result } = renderHook(() => useOpenCase());
    expect(result.current.isPending).toBe(true);
  });
});
