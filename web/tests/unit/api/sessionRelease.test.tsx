/**
 * The session is given back when the tab goes away: a closed or reloaded page
 * sends ``DELETE /sessions/{id}`` on ``pagehide``, with ``keepalive`` so the
 * browser finishes it after the page is gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { releaseSession, useSessionRelease } from '@/api/useSessionRelease';
import { useSessionStore } from '@/store/session';
import { parseSessionId } from '@/api/types';

const fetchMock = vi.fn();

function pageHide(persisted: boolean): void {
  const event = new Event('pagehide');
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  useSessionStore.setState({ sessionId: parseSessionId('s1') });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useSessionStore.setState({ sessionId: null });
});

describe('useSessionRelease', () => {
  it('closes the session when the page goes away', () => {
    renderHook(() => useSessionRelease());
    pageHide(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1', {
      method: 'DELETE',
      keepalive: true,
    });
  });

  it('closes the session the tab holds at that moment, not the one it started with', () => {
    renderHook(() => useSessionRelease());
    useSessionStore.setState({ sessionId: parseSessionId('s2') });
    pageHide(false);
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s2', expect.anything());
  });

  it('keeps the session of a page the browser keeps for Back and Forward', () => {
    renderHook(() => useSessionRelease());
    pageHide(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing when there is no session', () => {
    useSessionStore.setState({ sessionId: null });
    renderHook(() => useSessionRelease());
    pageHide(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops listening when it is unmounted', () => {
    const { unmount } = renderHook(() => useSessionRelease());
    unmount();
    pageHide(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('releaseSession', () => {
  it('does not throw when the request is refused or fails', async () => {
    fetchMock.mockImplementationOnce(() => {
      throw new TypeError('keepalive is not supported');
    });
    expect(() => releaseSession(parseSessionId('s1'))).not.toThrow();
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    expect(() => releaseSession(parseSessionId('s1'))).not.toThrow();
    // The rejection is swallowed, not left unhandled.
    await Promise.resolve();
  });

  it('escapes the id in the path', () => {
    releaseSession(parseSessionId('a/b'));
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/a%2Fb', expect.anything());
  });
});
