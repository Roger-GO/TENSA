/**
 * Fake timers for the dialogs that close themselves a beat after a success.
 *
 * A test calls `startBeatClock()` first and then crosses the beat by hand with
 * `vi.advanceTimersByTimeAsync`. The clock still ticks on its own
 * (`shouldAdvanceTime`), so `waitFor` and `userEvent` keep working, and the
 * returned `userEvent` instance is wired to the fake clock. The file restores
 * real timers in its own `afterEach`.
 */
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

export function startBeatClock() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  return userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });
}
