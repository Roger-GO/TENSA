/**
 * The hooks of the example cases: the catalog is read from `GET /examples`, and an add is
 * `POST /examples/{id}/add`, after which the list and the workspace listing are read again
 * whatever the answer (a 409 means the case is there already, which the list then shows).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { makeQueryClient, queryKeys, useAddExample, useListExamples } from '@/api/queries';
import { makeCatalog } from '../helpers/exampleCatalog';

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
  return { client, Wrapper };
}

describe('example case hooks', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('lists the catalog from GET /examples', async () => {
    const examples = makeCatalog();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ examples }));
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useListExamples(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.examples.map((e) => e.id)).toEqual([
      'ieee14',
      'wscc9',
      'texas-dynamic',
    ]);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/examples');
    expect(init.method).toBe('GET');
  });

  it('posts the add without overwrite, and reads the list and the workspace again', async () => {
    const added = {
      id: 'wscc9',
      primary: 'wscc9.xlsx',
      files: [{ name: 'wscc9.xlsx', size_bytes: 10, replaced: false }],
      warnings: [],
      sources_file: 'EXAMPLE-SOURCES.md',
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(added, 201));
    const { client, Wrapper } = makeWrapper();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useAddExample(), { wrapper: Wrapper });
    let reply: unknown;
    await act(async () => {
      reply = await result.current.mutateAsync({ id: 'wscc9' });
    });
    expect(reply).toEqual(added);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/examples/wscc9/add?overwrite=false');
    expect(init.method).toBe('POST');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.examples });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.workspaceFiles });
  });

  it('asks to replace the files only when told to, and encodes the id', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({}, 201));
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useAddExample(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'a b', overwrite: true });
    });
    const [url] = fetchSpy.mock.calls[0]! as [string];
    expect(url).toBe('/api/examples/a%20b/add?overwrite=true');
  });

  it('reads the lists again when the add is refused, so a case that is there shows as added', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        { type: 'about:blank', title: 'Conflict', status: 409, detail: 'wscc9.xlsx exists' },
        409,
      ),
    );
    const { client, Wrapper } = makeWrapper();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useAddExample(), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ id: 'wscc9' })).rejects.toMatchObject({
        status: 409,
      });
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.examples });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.workspaceFiles });
  });
});
