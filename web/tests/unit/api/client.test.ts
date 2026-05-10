/**
 * Tests for the fetch wrapper in `src/api/client.ts`.
 *
 * Strategy: stub `globalThis.fetch` per test (vi.spyOn) and assert against
 * the URL, method, headers, body, and the typed-error / typed-success
 * outcomes. The token getter is swapped via `setTokenGetter` so we don't
 * need a Zustand store mounted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  andesClient,
  NetworkError,
  ProblemDetailsError,
  RateLimitedError,
  ServerError,
  setTokenGetter,
} from '@/api/client';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('andesClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setTokenGetter(() => 'test-token-value');
    // Cast through unknown so the spy signature stays type-clean.
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    setTokenGetter(() => null);
    vi.useRealTimers();
  });

  it('GET injects X-Andes-Token, prefixes /api, and returns parsed JSON', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ sessions: [] }));

    const result = await andesClient.get<{ sessions: unknown[] }>('/sessions');
    expect(result).toEqual({ sessions: [] });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/sessions');
    expect(init.method).toBe('GET');
    const headers = new Headers(init.headers);
    expect(headers.get('X-Andes-Token')).toBe('test-token-value');
  });

  it('POST stringifies body and sets Content-Type', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ session_id: 'abc', state: 'live' }, { status: 201 }),
    );

    const result = await andesClient.post<{ session_id: string }>('/sessions', {
      body: { foo: 'bar' },
    });
    expect(result.session_id).toBe('abc');

    const [, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ foo: 'bar' }));
    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('appends query params when provided', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({}));
    await andesClient.get('/workspace/layout', { query: { case_path: 'foo/bar.xlsx' } });
    const [url] = fetchSpy.mock.calls[0]! as [string];
    expect(url).toBe('/api/workspace/layout?case_path=foo%2Fbar.xlsx');
  });

  it('skips X-Andes-Token when no token is set', async () => {
    setTokenGetter(() => null);
    fetchSpy.mockResolvedValueOnce(jsonResponse({}));
    await andesClient.get('/sessions');
    const [, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(new Headers(init.headers).get('X-Andes-Token')).toBeNull();
  });

  it('401 → ProblemDetailsError with status 401', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          type: 'about:blank',
          title: 'Unauthorized',
          status: 401,
          detail: 'Missing X-Andes-Token.',
        },
        { status: 401 },
      ),
    );

    await expect(andesClient.get('/sessions')).rejects.toMatchObject({
      name: 'ProblemDetailsError',
      status: 401,
      title: 'Unauthorized',
      detail: 'Missing X-Andes-Token.',
    });
  });

  it('429 → RateLimitedError with parsed Retry-After', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ type: 'about:blank', title: 'Too Many Requests', status: 429 }),
        {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '12' },
        },
      ),
    );

    let caught: unknown;
    try {
      await andesClient.post('/sessions', { body: {} });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RateLimitedError);
    expect((caught as RateLimitedError).retryAfterSeconds).toBe(12);
    expect((caught as RateLimitedError).status).toBe(429);
  });

  it('5xx → ServerError', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        { type: 'about:blank', title: 'Internal Server Error', status: 500 },
        { status: 500 },
      ),
    );
    let caught: unknown;
    try {
      await andesClient.get('/sessions');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ServerError);
    expect((caught as ServerError).status).toBe(500);
  });

  it('ProblemDetails with missing optional fields still parses', async () => {
    // RFC 7807 makes type + instance optional. The substrate emits both
    // but a misbehaving proxy could strip them; we coerce sensibly.
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ title: 'Forbidden', status: 403 }, { status: 403 }),
    );
    let caught: unknown;
    try {
      await andesClient.get('/sessions');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProblemDetailsError);
    expect((caught as ProblemDetailsError).type).toBe('about:blank');
    expect((caught as ProblemDetailsError).instance).toBeUndefined();
  });

  it('Non-JSON error body still produces a ProblemDetailsError with a fallback title', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('boom', { status: 502, headers: { 'Content-Type': 'text/plain' } }),
    );
    let caught: unknown;
    try {
      await andesClient.get('/sessions');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ServerError);
    expect((caught as ServerError).status).toBe(502);
    expect((caught as ServerError).title).toBe('HTTP 502');
  });

  it('Network failure → NetworkError', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    let caught: unknown;
    try {
      await andesClient.get('/sessions');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NetworkError);
  });

  it('Per-call timeout fires → NetworkError mentioning timeout', async () => {
    // Mock fetch to hang until the AbortSignal fires, then reject with
    // an AbortError-shaped exception (matching the real fetch semantics).
    fetchSpy.mockImplementationOnce(
      (_url, init) =>
        new Promise((_, reject) => {
          const signal = (init as RequestInit).signal as AbortSignal;
          if (signal.aborted) {
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    vi.useFakeTimers();
    const promise = andesClient.get('/sessions', { timeoutMs: 50 });
    vi.advanceTimersByTime(60);
    let caught: unknown;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NetworkError);
    expect((caught as NetworkError).message).toMatch(/timed out/i);
  });

  it('204 returns undefined without parsing body', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await andesClient.delete<undefined>('/sessions/abc');
    expect(result).toBeUndefined();
  });
});
