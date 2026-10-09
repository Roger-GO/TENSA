/**
 * Reset run for the places that say a run has fixed the system and have no
 * component of their own to make the request from: a notice of the diagram,
 * the line of the Components palette, the card of the open case. The app
 * mounts one host that provides the reset, and those places ask for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const reset = vi.fn();
vi.mock('@/lib/useResetRunAction', () => ({
  useResetRunAction: () => ({ reset, isPending: false }),
}));

import { ResetRunHost } from '@/components/shell/ResetRunHost';
import { provideResetRun, providedResetRun, requestResetRun } from '@/lib/resetRunRequest';

beforeEach(() => {
  reset.mockReset();
  provideResetRun(null);
});

afterEach(() => {
  cleanup();
  provideResetRun(null);
});

describe('requestResetRun', () => {
  it('answers false, and resets nothing, while the app has mounted no host', () => {
    expect(requestResetRun()).toBe(false);
    expect(reset).not.toHaveBeenCalled();
  });

  it('resets the run through the host while one is mounted, and not after it is gone', () => {
    const view = render(<ResetRunHost />);
    expect(requestResetRun()).toBe(true);
    expect(reset).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(providedResetRun()).toBeNull();
    expect(requestResetRun()).toBe(false);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('leaves the reset of another host in place when one goes', () => {
    const first = render(<ResetRunHost />);
    const other = vi.fn();
    // A newer host has taken over: the one that goes takes back only its own.
    provideResetRun(other);
    first.unmount();
    expect(providedResetRun()).toBe(other);
    requestResetRun();
    expect(other).toHaveBeenCalledTimes(1);
  });
});
