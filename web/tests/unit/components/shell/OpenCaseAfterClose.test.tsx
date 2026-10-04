/**
 * Picking a case on the palette's Open case page closes the palette, and the
 * page is gone before the load answers. What follows the load (recording the case
 * so the diagram opens, or saying why it failed) must not depend on the page
 * still being there. This runs the real load mutation, not a stub, because a
 * stub would call back whether or not anything was mounted, which is the thing
 * under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ProblemDetailsError } from '@/api/client';
import { CommandPalette } from '@/components/shell/CommandPalette';
import { toast } from '@/lib/toast';
import { useCaseStore } from '@/store/case';
import { useCommandPaletteStore } from '@/store/commandPalette';
import { useSessionStore } from '@/store/session';
import { parseSessionId } from '@/api/types';

let answerLoad: (outcome: { ok: unknown } | { fail: Error }) => void = () => {};
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    andesClient: {
      get: (path: string) =>
        path === '/workspace/files'
          ? Promise.resolve({
              files: [
                {
                  name: 'ieee14_full.xlsx',
                  format: 'xlsx',
                  size_bytes: 1,
                  modified_iso: '2026-10-01T00:00:00Z',
                },
              ],
            })
          : Promise.reject(new Error(`unexpected GET ${path}`)),
      post: (path: string) =>
        path.endsWith('/case')
          ? new Promise((resolve, reject) => {
              answerLoad = (outcome) =>
                'ok' in outcome ? resolve(outcome.ok) : reject(outcome.fail);
            })
          : Promise.reject(new Error(`unexpected POST ${path}`)),
      put: () => Promise.reject(new Error('unexpected PUT')),
      delete: () => Promise.reject(new Error('unexpected DELETE')),
    },
  };
});

const TOPOLOGY = {
  state: 'pre-setup',
  buses: [],
  lines: [],
  transformers: [],
  generators: [],
  loads: [],
  shunts: [],
};

function renderPalette() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <CommandPalette />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useSessionStore.setState({ sessionId: parseSessionId('s1') });
  useCaseStore.setState({ selection: null, loadingPath: null });
  useCommandPaletteStore.setState({ open: true, page: 'open-case' });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useCommandPaletteStore.setState({ open: false, page: 'commands' });
  useCaseStore.setState({ selection: null, loadingPath: null });
});

describe('Open case, after the palette has closed', () => {
  it('records the case when the load answers, so the diagram opens', async () => {
    renderPalette();
    await userEvent.click(await screen.findByTestId('open-case-item-ieee14_full.xlsx'));
    // The palette and its page are gone; the load is still in flight.
    expect(useCommandPaletteStore.getState().open).toBe(false);
    await waitFor(() => expect(screen.queryByTestId('command-palette-open-case')).toBeNull());
    await waitFor(() => expect(useCaseStore.getState().loadingPath).toBe('ieee14_full.xlsx'));
    expect(useCaseStore.getState().selection).toBeNull();

    answerLoad({ ok: TOPOLOGY });
    await waitFor(() =>
      expect(useCaseStore.getState().selection).toMatchObject({
        primaryPath: 'ieee14_full.xlsx',
        addfiles: [],
      }),
    );
  });

  it('says why the load failed, with the palette long gone', async () => {
    const error = vi.spyOn(toast, 'error').mockReturnValue('id');
    renderPalette();
    await userEvent.click(await screen.findByTestId('open-case-item-ieee14_full.xlsx'));
    await waitFor(() => expect(useCaseStore.getState().loadingPath).toBe('ieee14_full.xlsx'));
    answerLoad({
      fail: new ProblemDetailsError({
        type: 'about:blank',
        title: 'Unprocessable',
        status: 422,
        detail: 'no Bus sheet',
        instance: null,
      }),
    });
    await waitFor(() => expect(error).toHaveBeenCalledWith('Load failed: no Bus sheet'));
    expect(useCaseStore.getState().selection).toBeNull();
  });
});
