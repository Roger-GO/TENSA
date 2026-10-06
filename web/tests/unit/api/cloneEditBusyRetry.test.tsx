/**
 * A clone edit sent while the session is briefly busy is sent again.
 *
 * Selecting a controller reads its diff, and for that moment the session
 * answers any other request with 409. A value committed straight after the
 * selection was refused; it is now retried for about a second.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { CLONE_EDIT_BUSY_RETRY_DELAYS_MS, makeQueryClient, useCloneEdit } from '@/api/queries';
import { parseSessionId } from '@/api/types';
import { useJobsStore } from '@/store/jobs';

const SESSION = parseSessionId('sess-1');
const EDIT = { sessionId: SESSION, model: 'EXST1', idx: '1', param: 'KA', value: 50 };
const DONE = { model: 'EXST1', idx: '1', param: 'KA', new_value: 50, undo_depth: 1, redo_depth: 0 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The substrate's answer while another request holds the session. */
function busy(): Response {
  return jsonResponse(
    {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'session is busy with an in-flight operation',
      recovery: { kind: 'wait-for-job', label: 'Wait for the running job' },
    },
    409,
  );
}

function wrapper() {
  const client = makeQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  useJobsStore.setState({ jobs: {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useCloneEdit while the session is busy', () => {
  it('sends the edit again and succeeds, as one job', async () => {
    fetchMock.mockResolvedValueOnce(busy()).mockResolvedValueOnce(jsonResponse(DONE));
    const { result } = renderHook(() => useCloneEdit(), { wrapper: wrapper() });

    act(() => result.current.mutate(EDIT));
    await vi.advanceTimersByTimeAsync(CLONE_EDIT_BUSY_RETRY_DELAYS_MS[0]!);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.data).toEqual(DONE);
    // The refusal in between is not a job of its own in the Activity list.
    expect(Object.values(useJobsStore.getState().jobs)).toHaveLength(1);
  });

  it('gives up after about a second, with the refusal it last got', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(busy()));
    const { result } = renderHook(() => useCloneEdit(), { wrapper: wrapper() });

    act(() => result.current.mutate(EDIT));
    const total = CLONE_EDIT_BUSY_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeLessThanOrEqual(1500);
    await vi.advanceTimersByTimeAsync(total);
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(CLONE_EDIT_BUSY_RETRY_DELAYS_MS.length + 1);
    expect(result.current.error?.message).toContain('session is busy');
  });

  it('does not send an edit the substrate refused for another reason again', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ title: 'Unprocessable', status: 422, detail: 'KA must be positive' }, 422),
    );
    const { result } = renderHook(() => useCloneEdit(), { wrapper: wrapper() });

    act(() => result.current.mutate(EDIT));
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
