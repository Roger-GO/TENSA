/**
 * Tests for `<LoadSnapshotDialog />` (Unit 7 of the v2.0 plan).
 *
 * Covers:
 * - Empty state renders when the substrate listing is empty.
 * - Listing renders one row per snapshot with metadata.
 * - Selecting a row + clicking Restore fires the substrate mutation.
 * - Restore success surfaces the inline outcome (used_dill +
 *   fallback_reason).
 * - Delete arms + confirms (two-click pattern).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();
const toastInfoMock = vi.fn();
const toastWarningMock = vi.fn();

vi.mock('@/lib/toast', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
    info: (...args: unknown[]) => toastInfoMock(...args),
    warning: (...args: unknown[]) => toastWarningMock(...args),
    dismiss: vi.fn(),
  },
}));

import { LoadSnapshotDialog } from '@/components/snapshot/LoadSnapshotDialog';
import { useSessionStore } from '@/store/session';
import { useSnapshotStore } from '@/store/snapshot';
import { useCaseStore } from '@/store/case';
import { parseSessionId, parseWorkspacePath } from '@/api/types';

const fetchSpy = vi.fn();
const originalFetch = globalThis.fetch;

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function makeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchSpy.mockReset();
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
  // ``useListSnapshots`` is gated on a loaded case (the listing endpoint
  // 409s on a no-case session), so set a case selection here or the
  // snapshot rows never render.
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
  });
  useSnapshotStore.getState().reset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  toastInfoMock.mockReset();
  toastWarningMock.mockReset();
  // Open the dialog so the inner body mounts.
  useSnapshotStore.getState().openLoadDialog();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  useCaseStore.setState({ selection: null, topology: null, layoutSidecar: null });
  cleanup();
});

describe('<LoadSnapshotDialog /> — empty state', () => {
  it('renders the empty state when the listing is empty', async () => {
    fetchSpy.mockResolvedValue(makeJsonResponse(200, { snapshots: [] }));
    render(withQueryClient(<LoadSnapshotDialog />));
    expect(await screen.findByTestId('load-snapshot-dialog')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('load-snapshot-loading')).toBeNull());
    expect(await screen.findByTestId('load-snapshot-empty')).toBeInTheDocument();
    expect(screen.getByTestId('load-snapshot-confirm')).toBeDisabled();
  });
});

describe('<LoadSnapshotDialog /> — listing + restore', () => {
  it('renders one row per snapshot and enables Restore on selection', async () => {
    fetchSpy.mockResolvedValue(
      makeJsonResponse(200, {
        snapshots: [
          {
            name: 'snap-a',
            saved_at: '2026-05-09T00:00:00Z',
            has_pflow: true,
            has_tds: false,
            has_dill: true,
            andes_version: '2.0.0',
            disturbance_count: 0,
          },
          {
            name: 'snap-b',
            saved_at: '2026-05-09T00:01:00Z',
            has_pflow: true,
            has_tds: true,
            has_dill: true,
            andes_version: '2.0.0',
            disturbance_count: 2,
          },
        ],
      }),
    );
    const user = userEvent.setup();
    render(withQueryClient(<LoadSnapshotDialog />));

    expect(await screen.findByTestId('load-snapshot-row-snap-a')).toBeInTheDocument();
    expect(screen.getByTestId('load-snapshot-row-snap-b')).toBeInTheDocument();

    // Restore disabled until a row is selected.
    expect(screen.getByTestId('load-snapshot-confirm')).toBeDisabled();

    await user.click(screen.getByTestId('load-snapshot-select-snap-a'));
    expect(screen.getByTestId('load-snapshot-confirm')).toBeEnabled();
  });

  it('restore confirm fires the substrate mutation and surfaces the outcome', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse(200, {
        snapshots: [
          {
            name: 'snap-a',
            saved_at: 'now',
            has_pflow: true,
            has_tds: false,
            has_dill: true,
            andes_version: '2.0.0',
            disturbance_count: 1,
          },
        ],
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse(200, {
        used_dill: false,
        fallback_reason: 'ANDES version mismatch',
        disturbances_replayed: 1,
        metadata: {
          andes_version: '2.0.0',
          tensa_version: '0.1.0',
          case_filename: 'ieee14.raw',
          case_sha256: null,
          disturbance_log: [],
          saved_at: 'now',
          has_pflow: true,
          has_tds: false,
        },
      }),
    );
    const user = userEvent.setup();
    render(withQueryClient(<LoadSnapshotDialog />));
    await user.click(await screen.findByTestId('load-snapshot-select-snap-a'));
    await user.click(screen.getByTestId('load-snapshot-confirm'));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    // Second call is the restore POST.
    const [restoreUrl, restoreInit] = fetchSpy.mock.calls[1]!;
    expect(String(restoreUrl)).toContain('/api/sessions/test-session-id/snapshot/restore');
    expect((restoreInit as RequestInit).method).toBe('POST');

    const success = await screen.findByTestId('load-snapshot-success');
    expect(success).toHaveTextContent(/replay\+PF/);
    expect(success).toHaveTextContent(/ANDES version mismatch/);
  });

  it('Force replay (debug) toggle sends use_dill_optimization=false on restore', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse(200, {
        snapshots: [
          {
            name: 'snap-a',
            saved_at: 'now',
            has_pflow: true,
            has_tds: false,
            has_dill: true,
            andes_version: '2.0.0',
            disturbance_count: 0,
          },
        ],
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse(200, {
        used_dill: false,
        fallback_reason: 'forced replay (debug)',
        disturbances_replayed: 0,
        metadata: {
          andes_version: '2.0.0',
          tensa_version: '0.1.0',
          case_filename: 'ieee14.raw',
          case_sha256: null,
          disturbance_log: [],
          saved_at: 'now',
          has_pflow: true,
          has_tds: false,
        },
      }),
    );
    const user = userEvent.setup();
    render(withQueryClient(<LoadSnapshotDialog />));
    await user.click(await screen.findByTestId('load-snapshot-select-snap-a'));

    // Open the Advanced disclosure and flip the Force-replay toggle ON.
    await user.click(screen.getByTestId('load-snapshot-advanced'));
    const forceReplay = screen.getByTestId('load-snapshot-force-replay');
    expect(forceReplay).not.toBeChecked();
    await user.click(forceReplay);
    expect(forceReplay).toBeChecked();
    // Flipping force-replay ON unchecks + disables the dill checkbox.
    expect(screen.getByTestId('load-snapshot-use-dill')).toBeDisabled();

    await user.click(screen.getByTestId('load-snapshot-confirm'));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const [restoreUrl, restoreInit] = fetchSpy.mock.calls[1]!;
    expect(String(restoreUrl)).toContain('/api/sessions/test-session-id/snapshot/restore');
    const body = JSON.parse((restoreInit as RequestInit).body as string);
    expect(body.use_dill_optimization).toBe(false);
  });
});

describe('<LoadSnapshotDialog /> — error toast (Unit 3)', () => {
  it('restore failure fires toast.error with a Retry action', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse(200, {
        snapshots: [
          {
            name: 'snap-a',
            saved_at: 'now',
            has_pflow: true,
            has_tds: false,
            has_dill: true,
            andes_version: '2.0.0',
            disturbance_count: 0,
          },
        ],
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: 'about:blank',
          title: 'Internal Server Error',
          status: 500,
          detail: 'disk full',
          instance: null,
        }),
        { status: 500, headers: { 'content-type': 'application/problem+json' } },
      ),
    );
    const user = userEvent.setup();
    render(withQueryClient(<LoadSnapshotDialog />));
    await user.click(await screen.findByTestId('load-snapshot-select-snap-a'));
    await user.click(screen.getByTestId('load-snapshot-confirm'));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        expect.stringMatching(/restore failed.*disk full/i),
        expect.objectContaining({
          action: expect.objectContaining({ label: 'Retry' }),
        }),
      ),
    );
    // Inline error block was retired in Unit 3 of the v2.0 polish plan.
    expect(screen.queryByTestId('load-snapshot-error')).toBeNull();
  });
});

describe('<LoadSnapshotDialog /> — delete', () => {
  it('first click arms the delete; second click confirms and fires DELETE', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse(200, {
        snapshots: [
          {
            name: 'snap-a',
            saved_at: 'now',
            has_pflow: false,
            has_tds: false,
            has_dill: true,
            andes_version: '2.0.0',
            disturbance_count: 0,
          },
        ],
      }),
    );
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
    fetchSpy.mockResolvedValue(makeJsonResponse(200, { snapshots: [] }));

    const user = userEvent.setup();
    render(withQueryClient(<LoadSnapshotDialog />));
    const deleteBtn = await screen.findByTestId('load-snapshot-delete-snap-a');
    expect(deleteBtn).toHaveTextContent(/^Delete$/);
    await user.click(deleteBtn);
    // After arming the button label flips.
    await waitFor(() =>
      expect(screen.getByTestId('load-snapshot-delete-snap-a')).toHaveTextContent(/Confirm delete/),
    );
    await user.click(screen.getByTestId('load-snapshot-delete-snap-a'));

    // The DELETE call should fire — count >=2 (initial GET + DELETE).
    await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2));
    const deleteCall = fetchSpy.mock.calls.find((c) => {
      const init = c[1] as RequestInit | undefined;
      return init?.method === 'DELETE';
    });
    expect(deleteCall).toBeDefined();
    expect(String(deleteCall![0])).toContain('/api/sessions/test-session-id/snapshot/snap-a');
  });
});
