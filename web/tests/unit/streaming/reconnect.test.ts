import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_RECONNECT_DELAYS_MS,
  delayForAttempt,
  shouldGiveUp,
} from '@/streaming/reconnect';

describe('reconnect helper', () => {
  it('returns the documented schedule for the first six attempts', () => {
    const expected = [250, 500, 1000, 2000, 4000];
    // ``maxAttempts`` defaults to 5; the 6th call (attempt index 5) should
    // be past the cap.
    expected.forEach((ms, attempt) => {
      expect(delayForAttempt(attempt)).toBe(ms);
    });
    expect(delayForAttempt(DEFAULT_MAX_RECONNECT_ATTEMPTS)).toBeNull();
  });

  it('caps at the last delay if the schedule is shorter than maxAttempts', () => {
    const delays = [100, 200];
    expect(delayForAttempt(0, { delays, maxAttempts: 5 })).toBe(100);
    expect(delayForAttempt(1, { delays, maxAttempts: 5 })).toBe(200);
    expect(delayForAttempt(2, { delays, maxAttempts: 5 })).toBe(200);
    expect(delayForAttempt(4, { delays, maxAttempts: 5 })).toBe(200);
    expect(delayForAttempt(5, { delays, maxAttempts: 5 })).toBeNull();
  });

  it('shouldGiveUp tracks maxAttempts', () => {
    expect(shouldGiveUp(0)).toBe(false);
    expect(shouldGiveUp(DEFAULT_MAX_RECONNECT_ATTEMPTS - 1)).toBe(false);
    expect(shouldGiveUp(DEFAULT_MAX_RECONNECT_ATTEMPTS)).toBe(true);
    expect(shouldGiveUp(99)).toBe(true);
  });

  it('exposes the documented default schedule for callers that pin it', () => {
    expect(DEFAULT_RECONNECT_DELAYS_MS).toEqual([250, 500, 1000, 2000, 4000, 8000]);
  });

  it('rejects negative attempt counts', () => {
    expect(delayForAttempt(-1)).toBeNull();
  });
});
