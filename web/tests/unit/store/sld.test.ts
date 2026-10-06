/**
 * Tests for the SLD slice (`web/src/store/sld.ts`) — Unit 11.
 *
 * Coverage:
 *
 *  - `selectedNodeId` defaults to null and round-trips through the
 *    setter + clearer.
 *  - The "open SLD search" pub-sub channel fires every subscriber and
 *    drops listeners after their unsubscribe is called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useSldStore,
  __requestOpenSldSearch,
  __requestSldCommand,
  subscribeOpenSldSearch,
  subscribeSldCommand,
} from '@/store/sld';

beforeEach(() => {
  // Reset the store to initial defaults before each test.
  useSldStore.setState({ selectedNodeId: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useSldStore — selectedNodeId', () => {
  it('defaults to null', () => {
    expect(useSldStore.getState().selectedNodeId).toBeNull();
  });

  it('setSelectedNodeId writes the id', () => {
    useSldStore.getState().setSelectedNodeId('bus-7');
    expect(useSldStore.getState().selectedNodeId).toBe('bus-7');
  });

  it('setSelectedNodeId(null) clears the slot', () => {
    useSldStore.getState().setSelectedNodeId('bus-7');
    useSldStore.getState().setSelectedNodeId(null);
    expect(useSldStore.getState().selectedNodeId).toBeNull();
  });

  it('clearSelectedNodeId resets to null', () => {
    useSldStore.getState().setSelectedNodeId('generator-5');
    useSldStore.getState().clearSelectedNodeId();
    expect(useSldStore.getState().selectedNodeId).toBeNull();
  });
});

describe('SLD search pub-sub bridge', () => {
  it('subscribers fire when __requestOpenSldSearch is invoked', () => {
    const listener = vi.fn();
    const unsub = subscribeOpenSldSearch(listener);
    __requestOpenSldSearch();
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    __requestOpenSldSearch();
    // Unsubscribed listeners should not receive subsequent events.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('multiple subscribers all receive the event', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeOpenSldSearch(a);
    const unsubB = subscribeOpenSldSearch(b);
    __requestOpenSldSearch();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    unsubB();
  });
});

describe('canvas command bridge', () => {
  it('hands each command to every subscriber, in order, until they unsubscribe', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubscribeA = subscribeSldCommand(a);
    const unsubscribeB = subscribeSldCommand(b);
    __requestSldCommand('fit-view');
    __requestSldCommand('reset-layout');
    expect(a.mock.calls).toEqual([['fit-view'], ['reset-layout']]);
    expect(b.mock.calls).toEqual([['fit-view'], ['reset-layout']]);

    unsubscribeA();
    __requestSldCommand('fit-view');
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(3);
    unsubscribeB();
  });

  it('reaches nobody, without an error, when no canvas is mounted', () => {
    expect(() => __requestSldCommand('fit-view')).not.toThrow();
  });

  it('carries the choice of how device connectors are drawn', () => {
    const seen = vi.fn();
    const unsubscribe = subscribeSldCommand(seen);
    __requestSldCommand('connectors-elbow');
    __requestSldCommand('connectors-straight');
    unsubscribe();
    expect(seen.mock.calls).toEqual([['connectors-elbow'], ['connectors-straight']]);
  });
});
