/**
 * The unit tests run in jsdom, whose `Blob` is jsdom's while `Response` is
 * Node's. `tests/setup.ts` makes a Response built from a Blob read back the
 * Blob's bytes and type, as in a browser, whichever Node runs the suite.
 */
import { describe, expect, it } from 'vitest';

describe('Response in the test environment', () => {
  it('reads back the bytes and the type of the Blob it was built from', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const response = new Response(new Blob([bytes], { type: 'application/zip' }));
    expect(response.headers.get('Content-Type')).toBe('application/zip');
    const blob = await response.blob();
    expect(blob.type).toBe('application/zip');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });

  it('keeps the type the response is given over the type of the Blob', async () => {
    const response = new Response(new Blob(['PK'], { type: 'text/plain' }), {
      status: 201,
      headers: { 'Content-Type': 'application/zip' },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('Content-Type')).toBe('application/zip');
    expect(await response.text()).toBe('PK');
  });

  it('still counts the responses Node makes itself as responses', () => {
    expect(Response.json({})).toBeInstanceOf(Response);
    expect(Response.error()).toBeInstanceOf(Response);
  });
});
