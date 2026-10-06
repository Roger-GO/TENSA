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
  __requestUnitExpanded,
  subscribeOpenSldSearch,
  subscribeSldCommand,
  subscribeUnitExpanded,
} from '@/store/sld';

beforeEach(() => {
  // Reset the store to initial defaults before each test.
  useSldStore.setState({ selectedNodeId: null, selectedOnDiagram: false });
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

  it('takes a pick for one made away from the diagram unless told otherwise', () => {
    useSldStore.getState().setSelectedNodeId('generator-5');
    expect(useSldStore.getState().selectedOnDiagram).toBe(false);
  });

  it('records a pick made on the diagram, until the next pick or a clear', () => {
    useSldStore.getState().setSelectedNodeId('generator-5', 'diagram');
    expect(useSldStore.getState().selectedOnDiagram).toBe(true);

    // The same node picked again from a table row is a request to be shown it.
    useSldStore.getState().setSelectedNodeId('generator-5');
    expect(useSldStore.getState().selectedOnDiagram).toBe(false);

    useSldStore.getState().setSelectedNodeId('generator-5', 'diagram');
    useSldStore.getState().clearSelectedNodeId();
    expect(useSldStore.getState().selectedOnDiagram).toBe(false);

    useSldStore.getState().setSelectedNodeId('generator-5', 'diagram');
    useSldStore.getState().setSelectedNodeId(null, 'diagram');
    expect(useSldStore.getState().selectedOnDiagram).toBe(false);
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

describe('generating-unit bridge', () => {
  it('hands a request to draw a chain out or fold it away to every subscriber, until they unsubscribe', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubscribeA = subscribeUnitExpanded(a);
    const unsubscribeB = subscribeUnitExpanded(b);
    __requestUnitExpanded('GENROU_1', true);
    __requestUnitExpanded('2', false);
    expect(a.mock.calls).toEqual([
      ['GENROU_1', true],
      ['2', false],
    ]);
    expect(b.mock.calls).toEqual(a.mock.calls);

    unsubscribeA();
    __requestUnitExpanded('2', true);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(3);
    unsubscribeB();
  });

  it('reaches nobody, without an error, when no canvas is mounted', () => {
    expect(() => __requestUnitExpanded('1', true)).not.toThrow();
  });
});
