/**
 * Tests for the MAT export client.
 *
 * Covers:
 *  - Happy path: 200 → Blob with octet-stream MIME
 *  - 404 / 409 with no body → ProblemDetailsError with fallback copy
 *  - Network failure → NetworkError
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProblemDetailsError, NetworkError } from '@/api/client';
import { fetchEigStateMatrixMat } from '@/components/export/exportToMat';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('fetchEigStateMatrixMat', () => {
  it('returns the response Blob on 200', async () => {
    const fakeBytes = new Uint8Array([0x4d, 0x41, 0x54, 0x4c]); // "MATL"
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(fakeBytes, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );
    globalThis.fetch = fetchSpy as typeof fetch;

    const blob = await fetchEigStateMatrixMat('sess-abc');
    expect(blob.size).toBe(4);
    expect(blob.type).toBe('application/octet-stream');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/sessions/sess-abc/eig/state-matrix.mat');
    expect((init as RequestInit).method).toBe('GET');
  });

  it('sends the Accept header and no auth header', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );
    globalThis.fetch = fetchSpy as typeof fetch;
    await fetchEigStateMatrixMat('sess-1');
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('X-Andes-Token')).toBeNull();
    expect(headers.get('Accept')).toBe('application/octet-stream');
  });

  it('throws ProblemDetailsError with fallback copy on a 404 with no body', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 404 })) as typeof fetch;
    await expect(fetchEigStateMatrixMat('sess-1')).rejects.toMatchObject({
      status: 404,
      title: 'Session not found',
    });
    await expect(fetchEigStateMatrixMat('sess-1')).rejects.toBeInstanceOf(ProblemDetailsError);
  });

  it('says EIG has not been run on a 409 with no body', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('not json', { status: 409 })) as typeof fetch;
    await expect(fetchEigStateMatrixMat('sess-1')).rejects.toMatchObject({
      status: 409,
      title: 'EIG has not been run',
      detail: 'Run EIG, then export the state matrix.',
    });
  });

  it('parses RFC 7807 body when the substrate provides one', async () => {
    const body = {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'Run EIG first',
    };
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 409,
        headers: { 'Content-Type': 'application/problem+json' },
      }),
    ) as typeof fetch;
    await expect(fetchEigStateMatrixMat('sess-1')).rejects.toMatchObject({
      status: 409,
      title: 'Conflict',
      detail: 'Run EIG first',
    });
  });

  it('throws NetworkError when fetch itself fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection refused')) as typeof fetch;
    await expect(fetchEigStateMatrixMat('sess-1')).rejects.toBeInstanceOf(NetworkError);
  });

  it('url-encodes the session id', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );
    globalThis.fetch = fetchSpy as typeof fetch;
    await fetchEigStateMatrixMat('sess/with/slash');
    expect(fetchSpy.mock.calls[0]![0]).toBe(
      '/api/sessions/sess%2Fwith%2Fslash/eig/state-matrix.mat',
    );
  });
});
