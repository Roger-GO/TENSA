/**
 * What the notice of a converged power flow says under its headline: where
 * the result was kept, and that the run has fixed the system. A first-time
 * user learned of the lock only when the next edit was refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { PflowResult } from '@/api/types';
import { parseSessionId } from '@/api/types';

const mutate = vi.fn();
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return { ...actual, useRunPflow: () => ({ mutate }) };
});

import { usePflowRunAction } from '@/lib/usePflowRunAction';
import { toast } from '@/lib/toast';
import { usePflowHistoryStore } from '@/store/pflowHistory';
import { useSessionStore } from '@/store/session';

const SOLVED = { run_id: 'pf-7', converged: true, iterations: 3 } as unknown as PflowResult;

/** Run the action and answer the request with `data`, as the hook that sends it does. */
function runAndAnswer(data: PflowResult): void {
  const { result } = renderHook(() => usePflowRunAction());
  result.current();
  const callbacks = mutate.mock.calls.at(-1)?.[1] as { onSuccess: (data: PflowResult) => void };
  callbacks.onSuccess(data);
}

beforeEach(() => {
  mutate.mockReset();
  useSessionStore.setState({ sessionId: parseSessionId('s-1') });
  usePflowHistoryStore.getState().clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  usePflowHistoryStore.getState().clear();
});

describe('usePflowRunAction', () => {
  it('says under which name the result was kept, and that the run has fixed the system', () => {
    const success = vi.spyOn(toast, 'success');
    // The hook that ran the power flow has recorded it by the time it answers.
    usePflowHistoryStore.getState().record(SOLVED, { caseName: 'ieee14', names: {} as never });
    runAndAnswer(SOLVED);
    expect(success).toHaveBeenCalledExactlyOnceWith('PF converged in 3 iterations.', {
      description:
        'Kept as PF #1 under Analysis > Compare. The run has fixed the system: elements cannot be added or changed until Reset run, which keeps this result.',
      duration: 8000,
    });
  });

  it('says that the run has fixed the system where the result was not kept', () => {
    const success = vi.spyOn(toast, 'success');
    runAndAnswer(SOLVED);
    expect(success).toHaveBeenCalledWith(
      'PF converged in 3 iterations.',
      expect.objectContaining({
        description:
          'The run has fixed the system: elements cannot be added or changed until Reset run, which keeps this result.',
      }),
    );
  });

  it('says nothing for a power flow that did not converge, which has a panel of its own', () => {
    const success = vi.spyOn(toast, 'success');
    runAndAnswer({ ...SOLVED, converged: false } as PflowResult);
    expect(success).not.toHaveBeenCalled();
  });
});
