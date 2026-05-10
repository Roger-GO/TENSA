/**
 * Tests for `<BundleExportDialog />` and `<BundleExportButton />`
 * (Unit 3 of the v2.0 plan).
 *
 * Stubs the substrate fetch path because the bundle endpoint returns
 * `application/zip`, which the regular `andesClient` doesn't surface.
 * The mutation hook in `queries.ts` calls `fetch` directly; we mock
 * `globalThis.fetch` to return a synthetic `Response` carrying a fake
 * zip blob.
 *
 * Coverage:
 * - Button enable/disable gating on session + case selection.
 * - Open-dialog flow shows the preview file list.
 * - Confirm fires the substrate mutation and triggers `downloadBlob`.
 * - Error path surfaces the inline error and re-enables the confirm button.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { BundleExportButton, BundleExportDialog } from '@/components/bundle/BundleExportDialog';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useDisturbanceStore } from '@/store/disturbance';
import { useRunsStore } from '@/store/runs';
import { useBundleStore } from '@/store/bundle';
import { parseSessionId, parseWorkspacePath } from '@/api/types';

const fetchSpy = vi.fn();
const originalFetch = globalThis.fetch;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function makeZipResponse(): Response {
  // Synthetic "zip" payload — the dialog only inspects the Blob; the
  // bytes don't have to be a valid zip for the test.
  const body = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], { type: 'application/zip' });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/zip' },
  });
}

function makeProblemResponse(status: number, detail: string): Response {
  return new Response(
    JSON.stringify({ type: 'about:blank', title: 'Error', status, detail, instance: null }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

beforeEach(() => {
  fetchSpy.mockReset();
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  URL.createObjectURL = vi.fn(() => 'blob:fake-bundle-url');
  URL.revokeObjectURL = vi.fn();
  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
  useCaseStore.setState({
    selection: {
      primaryPath: parseWorkspacePath('cases/ieee14.raw'),
      addfiles: [],
    },
    topology: null,
    layoutSidecar: null,
    selectedElement: null,
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDirty: false,
    dragOverrides: {},
    pendingDependents: [],
  });
  useDisturbanceStore.setState({ disturbances: [], dirty: false, committed: false });
  useRunsStore.setState({ runs: {}, activeRunId: null });
  useBundleStore.setState({
    dialogOpen: false,
    previewFiles: [],
    status: 'idle',
    errorMessage: null,
    lastExportedFilename: null,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  cleanup();
});

describe('<BundleExportButton />', () => {
  it('is enabled when a session + case selection are present', () => {
    render(withQueryClient(<BundleExportButton />));
    expect(screen.getByTestId('bundle-export-button')).toBeEnabled();
  });

  it('is disabled when no session is present', () => {
    useSessionStore.setState({ sessionId: null });
    render(withQueryClient(<BundleExportButton />));
    expect(screen.getByTestId('bundle-export-button')).toBeDisabled();
  });

  it('is disabled when no case selection is present', () => {
    useCaseStore.setState({ selection: null });
    render(withQueryClient(<BundleExportButton />));
    expect(screen.getByTestId('bundle-export-button')).toBeDisabled();
  });

  it('opens the bundle dialog on click', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<BundleExportButton />));
    await user.click(screen.getByTestId('bundle-export-button'));
    expect(useBundleStore.getState().dialogOpen).toBe(true);
  });
});

describe('<BundleExportDialog /> — preview list', () => {
  it('renders the case file + manifest in the minimal preview', async () => {
    useBundleStore.getState().openDialog();
    render(withQueryClient(<BundleExportDialog />));
    expect(await screen.findByTestId('bundle-export-dialog')).toBeInTheDocument();
    const list = await screen.findByTestId('bundle-export-preview-list');
    expect(list).toHaveTextContent('case/ieee14.raw');
    expect(list).toHaveTextContent('manifest.json');
    expect(list).not.toHaveTextContent('disturbances.json');
    expect(list).not.toHaveTextContent('sim_params.json');
    expect(list).not.toHaveTextContent('results.csv');
  });

  it('adds disturbances.json when the local list is non-empty', async () => {
    useDisturbanceStore.setState({
      disturbances: [
        {
          id: 'd1',
          spec: { kind: 'fault', bus_idx: 5, tf: 1.0, tc: 1.1, xf: 0.0001, rf: 0.0 },
        },
      ],
      dirty: true,
      committed: false,
    });
    useBundleStore.getState().openDialog();
    render(withQueryClient(<BundleExportDialog />));
    const list = await screen.findByTestId('bundle-export-preview-list');
    expect(list).toHaveTextContent('disturbances.json');
  });

  it('adds sim_params.json + results.csv when an active run with frames is present', async () => {
    useRunsStore.setState({
      activeRunId: 'r1',
      runs: {
        r1: {
          runId: 'r1',
          startedAt: 0,
          tf: 2.0,
          tCurrent: 0.1,
          seqCount: 2,
          t: new Float64Array([0, 0.01]),
          columns: { Bus_5_v: new Float64Array([1.06, 1.0599]) },
          columnNames: ['Bus_5_v'],
          state: 'streaming',
          connection: 'connected',
          abortedLocally: false,
          errorReason: null,
        },
      },
    });
    useBundleStore.getState().openDialog();
    render(withQueryClient(<BundleExportDialog />));
    const list = await screen.findByTestId('bundle-export-preview-list');
    expect(list).toHaveTextContent('sim_params.json');
    expect(list).toHaveTextContent('results.csv');
  });
});

describe('<BundleExportDialog /> — confirm flow', () => {
  it('confirm fires the substrate mutation and triggers a download', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValue(makeZipResponse());
    useBundleStore.getState().openDialog();
    render(withQueryClient(<BundleExportDialog />));

    await user.click(await screen.findByTestId('bundle-export-confirm'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/api/sessions/test-session-id/bundle/export');
    expect((init as RequestInit).method).toBe('POST');
    // createObjectURL is called by downloadBlob.
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    // Status flips to success after the response lands.
    await waitFor(() => expect(useBundleStore.getState().status).toBe('success'));
  });

  it('error response surfaces inline and re-enables the confirm button', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValue(makeProblemResponse(409, 'no case loaded'));
    useBundleStore.getState().openDialog();
    render(withQueryClient(<BundleExportDialog />));

    await user.click(await screen.findByTestId('bundle-export-confirm'));
    await waitFor(() => expect(useBundleStore.getState().status).toBe('error'));
    expect(await screen.findByTestId('bundle-export-error')).toHaveTextContent(/no case loaded/i);
    // Confirm button is back to enabled so the user can retry.
    expect(screen.getByTestId('bundle-export-confirm')).toBeEnabled();
  });

  it('cancel closes the dialog without firing the mutation', async () => {
    const user = userEvent.setup();
    useBundleStore.getState().openDialog();
    render(withQueryClient(<BundleExportDialog />));
    await user.click(await screen.findByTestId('bundle-export-cancel'));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useBundleStore.getState().dialogOpen).toBe(false);
  });
});
