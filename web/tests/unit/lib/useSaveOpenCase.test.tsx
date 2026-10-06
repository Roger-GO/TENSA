/**
 * Save: writes the open case over its own file where that is safe, tells the user
 * what it did, and leaves everything else to Save system as.
 *
 * `andesClient` is stubbed, so the request each press sends is what is asserted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import type { ReactNode } from 'react';

import { ProblemDetailsError } from '@/api/client';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { ProblemDetails } from '@/api/types';
import { buildSidecarLayout } from '@/components/sld/sidecar';
import { toast } from '@/lib/toast';
import { useSaveOpenCase } from '@/lib/useSaveOpenCase';
import { useCaseStore } from '@/store/case';
import { hasEditsNotInFile, hasUnsavedEdits, useEditJournalStore } from '@/store/editJournal';
import { useSessionStore } from '@/store/session';

const postSpy = vi.fn();
const putSpy = vi.fn();
type Resolver = () => Promise<unknown>;
let nextPost: Resolver = () => Promise.resolve({ filename: 'ieee14_full.xlsx', bytes_written: 9 });

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    andesClient: {
      get: vi.fn(),
      delete: vi.fn(),
      post: (path: string, opts: { body?: unknown }) => {
        postSpy(path, opts.body);
        return nextPost();
      },
      put: (path: string, opts: { body?: unknown; query?: Record<string, string> }) => {
        putSpy(path, opts.body, opts.query);
        return Promise.resolve(undefined);
      },
    },
  };
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return React.createElement(QueryClientProvider, { client }, children);
}

/** An edit the user made and has not saved. */
function editSomething(): void {
  useEditJournalStore.getState().record({ op: 'add', model: 'Bus', params: { idx: 99, Vn: 110 } });
}

function problem(status: number, detail: string): ProblemDetailsError {
  const body: ProblemDetails = { type: 'about:blank', title: `HTTP ${status}`, status, detail };
  return new ProblemDetailsError(body);
}

let success: MockInstance<typeof toast.success>;
let failure: MockInstance<typeof toast.error>;
let info: MockInstance<typeof toast.info>;

beforeEach(() => {
  postSpy.mockClear();
  putSpy.mockClear();
  nextPost = () => Promise.resolve({ filename: 'ieee14_full.xlsx', bytes_written: 9 });
  success = vi.spyOn(toast, 'success').mockReturnValue('id');
  failure = vi.spyOn(toast, 'error').mockReturnValue('id');
  info = vi.spyOn(toast, 'info').mockReturnValue('id');
  useSessionStore.setState({ sessionId: parseSessionId('s1') });
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('ieee14_full.xlsx'), addfiles: [] },
    cloneInitialized: false,
    dragOverrides: {},
    diagramLayout: null,
  });
  useEditJournalStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useCaseStore.setState({ selection: null, dragOverrides: {}, diagramLayout: null });
  useEditJournalStore.getState().reset();
});

describe('useSaveOpenCase', () => {
  it('writes the open xlsx case over its own file, then says so', async () => {
    editSomething();
    const { result } = renderHook(() => useSaveOpenCase(), { wrapper });
    expect(result.current.target).toEqual({
      ok: true,
      filename: 'ieee14_full.xlsx',
      format: 'xlsx',
    });

    act(() => result.current.save());

    await waitFor(() => expect(success).toHaveBeenCalledWith('Saved ieee14_full.xlsx'));
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledWith('/sessions/s1/save', {
      filename: 'ieee14_full.xlsx',
      format: 'xlsx',
      overwrite: true,
    });
    // The edits are written out now, so closing the tab no longer loses them.
    expect(hasUnsavedEdits()).toBe(false);
  });

  it('makes the file the base of the journal, which a recovery would otherwise replay on top of it', async () => {
    editSomething();
    editSomething();
    const { result } = renderHook(() => useSaveOpenCase(), { wrapper });

    act(() => result.current.save());

    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(useEditJournalStore.getState().entries).toEqual([]);
    // What is done next is the journal's again, and writes the file again.
    editSomething();
    expect(useEditJournalStore.getState().entries).toHaveLength(1);
    expect(hasEditsNotInFile()).toBe(true);
    act(() => result.current.save());
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(2));
  });

  it('writes the diagram as it is drawn beside the file, dragged or not', async () => {
    editSomething();
    // What the canvas keeps in the store: every position and route on screen.
    // Nothing was dragged in this visit (`dragOverrides` is empty), which used
    // to mean no layout was written at all.
    const drawn = buildSidecarLayout(
      { '3': { x: 10, y: 20 }, '4': { x: 210, y: 20 } },
      {
        nonBusCoords: { load: { PQ_1: { x: 10, y: 90 } } },
        sections: {
          branches: {
            line: {
              L1: {
                routing: 'polyline',
                bend_points: [
                  { x: 40, y: 26 },
                  { x: 240, y: 26 },
                ],
                source_face: null,
                target_face: null,
              },
            },
          },
        },
      },
    );
    useCaseStore.setState({ diagramLayout: drawn });
    const { result } = renderHook(() => useSaveOpenCase(), { wrapper });

    act(() => result.current.save());

    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));
    expect(putSpy.mock.calls[0]?.[0]).toBe('/workspace/layout');
    expect(putSpy.mock.calls[0]?.[2]).toEqual({ case_path: 'ieee14_full.xlsx' });
    const sent = putSpy.mock.calls[0]?.[1] as typeof drawn;
    expect({ ...sent, last_modified: drawn.last_modified }).toEqual(drawn);
    // The time is the save's, not the last redraw's.
    expect(Number.isNaN(Date.parse(sent.last_modified))).toBe(false);
  });

  it('writes no layout while the diagram of the case has not been drawn', async () => {
    editSomething();
    // The server has the layout saved beside the file; there is nothing newer to send.
    useCaseStore.setState({ dragOverrides: { '3': { x: 10, y: 20 } } });
    const { result } = renderHook(() => useSaveOpenCase(), { wrapper });

    act(() => result.current.save());

    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('writes no layout for a diagram with nothing placed on it', async () => {
    editSomething();
    useCaseStore.setState({ diagramLayout: buildSidecarLayout({}) });
    const { result } = renderHook(() => useSaveOpenCase(), { wrapper });

    act(() => result.current.save());

    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('writes a json case as json', async () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('cases/kundur.json'), addfiles: [] },
    });
    editSomething();
    const { result } = renderHook(() => useSaveOpenCase(), { wrapper });

    act(() => result.current.save());

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    expect(postSpy.mock.calls[0]?.[1]).toEqual({
      filename: 'cases/kundur.json',
      format: 'json',
      overwrite: true,
    });
  });

  it('still writes the open file when the edits were saved under another name', async () => {
    editSomething();
    // Save system as, say: the edits are saved, but not in the file Save writes.
    useEditJournalStore.getState().markSaved();
    expect(hasUnsavedEdits()).toBe(false);
    const { result } = renderHook(() => useSaveOpenCase(), { wrapper });

    act(() => result.current.save());

    await waitFor(() => expect(success).toHaveBeenCalledWith('Saved ieee14_full.xlsx'));
    expect(info).not.toHaveBeenCalled();
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite a file with nothing newer than it, and says so', () => {
    const { result } = renderHook(() => useSaveOpenCase(), { wrapper });

    act(() => result.current.save());

    expect(postSpy).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/nothing to save.*ieee14_full\.xlsx/i));
  });

  it('does nothing itself where the case cannot be written back, for Save system as to take over', () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    });
    editSomething();
    const { result } = renderHook(() => useSaveOpenCase(), { wrapper });
    expect(result.current.target.ok).toBe(false);

    act(() => result.current.save());

    expect(postSpy).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('is off while the controller parameter edits live in a copy of the case', () => {
    useCaseStore.setState({ cloneInitialized: true });
    editSomething();
    const { result } = renderHook(() => useSaveOpenCase(), { wrapper });
    expect(result.current.target.ok).toBe(false);
    act(() => result.current.save());
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('is off after a bundle import or snapshot restore replaced the system, until a reload', () => {
    useEditJournalStore.getState().markReplaced();
    editSomething();
    const replaced = renderHook(() => useSaveOpenCase(), { wrapper });
    expect(replaced.result.current.target.ok).toBe(false);
    replaced.unmount();

    act(() => useEditJournalStore.getState().record({ op: 'reload' }));
    editSomething();
    const reloaded = renderHook(() => useSaveOpenCase(), { wrapper });
    expect(reloaded.result.current.target.ok).toBe(true);
  });

  it('keeps the edits unsaved and says why when the server refuses', async () => {
    nextPost = () => Promise.reject(problem(409, 'session is busy running a job'));
    editSomething();
    const { result } = renderHook(() => useSaveOpenCase(), { wrapper });

    act(() => result.current.save());

    await waitFor(() =>
      expect(failure).toHaveBeenCalledWith('Could not save ieee14_full.xlsx', {
        description: 'session is busy running a job',
      }),
    );
    expect(success).not.toHaveBeenCalled();
    expect(hasUnsavedEdits()).toBe(true);
  });

  it('sends one request however many times it is pressed while one is running', async () => {
    let finish: (value: unknown) => void = () => undefined;
    nextPost = () => new Promise((resolve) => (finish = resolve));
    editSomething();
    const { result } = renderHook(() => useSaveOpenCase(), { wrapper });

    act(() => result.current.save());
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    act(() => result.current.save());
    act(() => result.current.save());
    expect(postSpy).toHaveBeenCalledTimes(1);

    await act(async () => finish({ filename: 'ieee14_full.xlsx', bytes_written: 9 }));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
  });

  it('sends one request when the press and a second surface come while one is running', async () => {
    let finish: (value: unknown) => void = () => undefined;
    nextPost = () => new Promise((resolve) => (finish = resolve));
    editSomething();
    // The key handler, the palette and each menu call the hook on their own.
    const { result } = renderHook(() => ({ key: useSaveOpenCase(), menu: useSaveOpenCase() }), {
      wrapper,
    });

    act(() => result.current.key.save());
    act(() => result.current.menu.save());
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));

    await act(async () => finish({ filename: 'ieee14_full.xlsx', bytes_written: 9 }));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('still tells the user when the menu, palette or key that asked is gone by the time it ends', async () => {
    let finish: (value: unknown) => void = () => undefined;
    nextPost = () => new Promise((resolve) => (finish = resolve));
    editSomething();
    const { result, unmount } = renderHook(() => useSaveOpenCase(), { wrapper });

    act(() => result.current.save());
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => finish({ filename: 'ieee14_full.xlsx', bytes_written: 9 }));

    await waitFor(() => expect(success).toHaveBeenCalledWith('Saved ieee14_full.xlsx'));
  });

  it('does nothing without a session', () => {
    useSessionStore.setState({ sessionId: null });
    editSomething();
    const { result } = renderHook(() => useSaveOpenCase(), { wrapper });

    act(() => result.current.save());

    expect(postSpy).not.toHaveBeenCalled();
  });
});
