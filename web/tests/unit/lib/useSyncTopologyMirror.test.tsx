/**
 * The case store's mirror of the topology query: filled when the query has the
 * case, filled again when ``setCase`` empties it after the load has answered
 * (opening a case from the saved-cases list did that and left the badge on
 * "Loading"), and left alone while the topology is being read again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { makeQueryClient, queryKeys } from '@/api/queries';
import { useSyncTopologyMirror } from '@/lib/useSyncTopologyMirror';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';

const SESSION = parseSessionId('s1');
const SELECTION = { primaryPath: parseWorkspacePath('kundur_full.xlsx'), addfiles: [] };

function topology(name: string): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [{ idx: 1, name, kind: 'Bus', params: {} }],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
  } as unknown as TopologySummary;
}

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  client = makeQueryClient();
  useSessionStore.setState({ sessionId: SESSION, recoveryInProgress: false });
  useCaseStore.setState({ selection: null, topology: null });
});

afterEach(() => {
  client.clear();
  vi.unstubAllGlobals();
});

describe('useSyncTopologyMirror', () => {
  it('mirrors the topology the query holds', async () => {
    const loaded = topology('A');
    client.setQueryData(queryKeys.topology(SESSION), loaded);
    useCaseStore.getState().setCase(SELECTION);
    renderHook(() => useSyncTopologyMirror(), { wrapper });
    await waitFor(() => expect(useCaseStore.getState().topology).toBe(loaded));
  });

  it('fills the mirror again when the case is recorded after the load has answered', async () => {
    // What a load does: the answer goes into the query and into the mirror...
    const loaded = topology('A');
    client.setQueryData(queryKeys.topology(SESSION), loaded);
    useCaseStore.getState().setTopology(loaded);
    renderHook(() => useSyncTopologyMirror(), { wrapper });
    await waitFor(() => expect(useCaseStore.getState().topology).toBe(loaded));

    // ...and what ``useOpenCase`` does once its promise resolves, a moment later:
    // it records the case, which empties the mirror. The query has not changed.
    act(() => useCaseStore.getState().setCase(SELECTION));
    await waitFor(() => expect(useCaseStore.getState().topology).toBe(loaded));
  });

  it('does not mirror the case the query still holds while the topology is read again', async () => {
    // A bundle import: the topology is marked stale and read again, then the
    // case is recorded. Until the read is back the query holds the old case.
    const old = topology('old');
    const imported = topology('imported');
    client.setQueryData(queryKeys.topology(SESSION), old);
    useCaseStore.getState().setCase(SELECTION);
    renderHook(() => useSyncTopologyMirror(), { wrapper });
    await waitFor(() => expect(useCaseStore.getState().topology).toBe(old));

    let answer: (response: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))),
    );
    act(() => {
      void client.invalidateQueries({ queryKey: queryKeys.topology(SESSION) });
    });
    await waitFor(() => expect(client.isFetching()).toBe(1));
    act(() => useCaseStore.getState().setCase(SELECTION));
    // Give the effect its chance to run on the emptied mirror.
    await act(async () => {
      await Promise.resolve();
    });
    expect(useCaseStore.getState().topology).toBeNull();

    answer(
      new Response(JSON.stringify(imported), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await waitFor(() => expect(useCaseStore.getState().topology).toEqual(imported));
  });

  it('leaves the mirror empty when there is no case to mirror', async () => {
    renderHook(() => useSyncTopologyMirror(), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });
    expect(useCaseStore.getState().topology).toBeNull();
  });
});
