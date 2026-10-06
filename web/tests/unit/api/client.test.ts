/**
 * Tests for the fetch wrapper in `src/api/client.ts`.
 *
 * Strategy: stub `globalThis.fetch` per test (vi.spyOn) and assert against
 * the URL, method, headers, body, and the typed-error / typed-success
 * outcomes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  andesClient,
  NetworkError,
  ProblemDetailsError,
  RateLimitedError,
  ServerError,
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
    // Cast through unknown so the spy signature stays type-clean.
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it('GET prefixes /api, sends no auth header, and returns parsed JSON', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ sessions: [] }));

    const result = await andesClient.get<{ sessions: unknown[] }>('/sessions');
    expect(result).toEqual({ sessions: [] });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/sessions');
    expect(init.method).toBe('GET');
    const headers = new Headers(init.headers);
    expect(headers.get('X-Andes-Token')).toBeNull();
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

  it('POST with a file sends it as the body, untouched, as octet-stream', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ name: 'ieee14.raw' }, { status: 201 }));
    const file = new File(['\u00ff\u0000 raw bytes'], 'ieee14.raw');

    await andesClient.post('/workspace/files', { query: { name: 'ieee14.raw' }, file });

    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/workspace/files?name=ieee14.raw');
    expect(init.method).toBe('POST');
    // The very same File, not a JSON string of it.
    expect(init.body).toBe(file);
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/octet-stream');
  });

  it('appends query params when provided', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({}));
    await andesClient.get('/workspace/layout', { query: { case_path: 'foo/bar.xlsx' } });
    const [url] = fetchSpy.mock.calls[0]! as [string];
    expect(url).toBe('/api/workspace/layout?case_path=foo%2Fbar.xlsx');
  });

  it('4xx → ProblemDetailsError with the response status', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'A system is already loaded.',
        },
        { status: 409 },
      ),
    );

    await expect(andesClient.get('/sessions')).rejects.toMatchObject({
      name: 'ProblemDetailsError',
      status: 409,
      title: 'Conflict',
      detail: 'A system is already loaded.',
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

  it('postBlob sends a JSON body and hands the answer back as the file it is', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // the first bytes of a .zip
    fetchSpy.mockResolvedValueOnce(
      new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/zip' } }),
    );

    const blob = await andesClient.postBlob('/comtrade', { body: { t: [0, 1] } });

    // Not `toBeInstanceOf(Blob)`: on Node 22 a `Response` makes Node's own Blob,
    // which is not jsdom's, the one this file sees as `Blob`.
    expect(Object.prototype.toString.call(blob)).toBe('[object Blob]');
    expect(blob.size).toBe(4);
    expect(blob.type).toBe('application/zip');
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/comtrade');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ t: [0, 1] }));
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });

  it('postBlob throws the typed error of a refusal, whose body is still JSON', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          type: 'about:blank',
          title: 'Content Too Large',
          status: 413,
          detail: 'the request holds 6000000 values',
        },
        { status: 413 },
      ),
    );

    await expect(andesClient.postBlob('/comtrade', { body: {} })).rejects.toMatchObject({
      name: 'ProblemDetailsError',
      status: 413,
      detail: 'the request holds 6000000 values',
      requestPath: '/api/comtrade',
    });
  });

  it('postBlob reports a server error and a failed fetch like every other call', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(andesClient.postBlob('/comtrade', { body: {} })).rejects.toBeInstanceOf(
      ServerError,
    );

    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(andesClient.postBlob('/comtrade', { body: {} })).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});
