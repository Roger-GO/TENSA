/**
 * ``useImportExternalResults``: ``POST /api/external-results?source=...`` with
 * the export's bytes as the whole body (never multipart, no JSON wrapper), the
 * ``ProblemDetailsError`` taxonomy for the server's refusals, and the parsed
 * response on success.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { makeQueryClient, useImportExternalResults } from '@/api/queries';
import { NetworkError, ProblemDetailsError } from '@/api/client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeWrapper() {
  const client = makeQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

const RESPONSE = {
  source: 'tsat',
  samples: 2,
  series: [{ name: 'column 1', t: [0, 0.1], y: [1.0, null] }],
};

describe('useImportExternalResults', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('posts the file itself as application/octet-stream, with the source in the query string', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(RESPONSE));
    const file = new File(['xlsx-bytes'], 'export.xlsx');
    const { result } = renderHook(() => useImportExternalResults(), { wrapper: makeWrapper() });

    let reply: unknown;
    await act(async () => {
      reply = await result.current.mutateAsync({ source: 'tsat', file });
    });

    expect(reply).toEqual(RESPONSE);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/external-results?source=tsat');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(file);
    expect(init.body).not.toBeInstanceOf(FormData);
    expect((init.headers as Headers).get('Content-Type')).toBe('application/octet-stream');
  });

  it('sends source=psse when the export is a PSS/E one', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ ...RESPONSE, source: 'psse' }));
    const file = new File(['x'], 'export.xlsx');
    const { result } = renderHook(() => useImportExternalResults(), { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.mutateAsync({ source: 'psse', file });
    });

    const [url] = fetchSpy.mock.calls[0]! as [string];
    expect(url).toBe('/api/external-results?source=psse');
  });

  it('rejects with ProblemDetailsError carrying the detail of a 413', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          type: 'about:blank',
          title: 'Content Too Large',
          status: 413,
          detail: 'the export exceeds 32 MiB',
        },
        413,
      ),
    );
    const { result } = renderHook(() => useImportExternalResults(), { wrapper: makeWrapper() });

    let caught: unknown;
    await act(async () => {
      await result.current
        .mutateAsync({ source: 'tsat', file: new File(['x'], 'big.xlsx') })
        .catch((err: unknown) => {
          caught = err;
        });
    });

    expect(caught).toBeInstanceOf(ProblemDetailsError);
    expect((caught as ProblemDetailsError).status).toBe(413);
    expect((caught as ProblemDetailsError).detail).toBe('the export exceeds 32 MiB');
  });

  it('rejects with ProblemDetailsError carrying the detail of a 415', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          type: 'about:blank',
          title: 'Unsupported Media Type',
          status: 415,
          detail: "send the export's bytes as the request body, not as multipart form data",
        },
        415,
      ),
    );
    const { result } = renderHook(() => useImportExternalResults(), { wrapper: makeWrapper() });

    let caught: unknown;
    await act(async () => {
      await result.current
        .mutateAsync({ source: 'tsat', file: new File(['x'], 'export.xlsx') })
        .catch((err: unknown) => {
          caught = err;
        });
    });

    expect(caught).toBeInstanceOf(ProblemDetailsError);
    expect((caught as ProblemDetailsError).status).toBe(415);
    expect((caught as ProblemDetailsError).detail).toBe(
      "send the export's bytes as the request body, not as multipart form data",
    );
  });

  it('rejects with ProblemDetailsError carrying the detail of a 422', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          type: 'about:blank',
          title: 'Unprocessable Content',
          status: 422,
          detail: 'the file is not an .xlsx workbook',
        },
        422,
      ),
    );
    const { result } = renderHook(() => useImportExternalResults(), { wrapper: makeWrapper() });

    let caught: unknown;
    await act(async () => {
      await result.current
        .mutateAsync({ source: 'psse', file: new File(['x'], 'export.xls') })
        .catch((err: unknown) => {
          caught = err;
        });
    });

    expect(caught).toBeInstanceOf(ProblemDetailsError);
    expect((caught as ProblemDetailsError).status).toBe(422);
    expect((caught as ProblemDetailsError).detail).toBe('the file is not an .xlsx workbook');
  });

  it('rejects with NetworkError when the fetch itself fails', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('failed to fetch'));
    const { result } = renderHook(() => useImportExternalResults(), { wrapper: makeWrapper() });

    let caught: unknown;
    await act(async () => {
      await result.current
        .mutateAsync({ source: 'tsat', file: new File(['x'], 'export.xlsx') })
        .catch((err: unknown) => {
          caught = err;
        });
    });

    expect(caught).toBeInstanceOf(NetworkError);
    expect((caught as NetworkError).message).toBe(
      'Network error on POST /api/external-results?source=tsat',
    );
  });
});
