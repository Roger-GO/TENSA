/**
 * Tests for `<SaveSnapshotDialog />` (Unit 7 of the v2.0 plan).
 *
 * Covers:
 * - Validation: empty / invalid name disables the confirm button.
 * - Confirm fires the substrate mutation and flips status to success.
 * - 409 collision surfaces an inline overwrite confirm; second click
 *   re-issues with ``force=true``.
 * - Generic error response surfaces inline.
 * - Cancel closes without firing the mutation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { SaveSnapshotDialog } from '@/components/snapshot/SaveSnapshotDialog';
import { useSessionStore } from '@/store/session';
import { useSnapshotStore } from '@/store/snapshot';
import { parseSessionId } from '@/api/types';

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

function makeProblemResponse(status: number, detail: string): Response {
  return new Response(
    JSON.stringify({
      type: 'about:blank',
      title: 'Error',
      status,
      detail,
      instance: null,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

beforeEach(() => {
  fetchSpy.mockReset();
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
  useSnapshotStore.getState().reset();
  // Open the dialog so the inner body mounts.
  useSnapshotStore.getState().openSaveDialog();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

describe('<SaveSnapshotDialog /> — name validation', () => {
  it('renders the dialog with an empty input by default', async () => {
    render(withQueryClient(<SaveSnapshotDialog />));
    expect(await screen.findByTestId('save-snapshot-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('save-snapshot-name-input')).toHaveValue('');
    // Confirm is disabled with empty input.
    expect(screen.getByTestId('save-snapshot-confirm')).toBeDisabled();
  });

  it('shows a validation message for invalid characters', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<SaveSnapshotDialog />));
    await user.type(screen.getByTestId('save-snapshot-name-input'), '../bad');
    expect(
      await screen.findByTestId('save-snapshot-validation-error'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('save-snapshot-confirm')).toBeDisabled();
  });

  it('enables confirm for a valid name', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<SaveSnapshotDialog />));
    await user.type(
      screen.getByTestId('save-snapshot-name-input'),
      'scenario-A',
    );
    expect(screen.getByTestId('save-snapshot-confirm')).toBeEnabled();
  });
});

describe('<SaveSnapshotDialog /> — confirm flow', () => {
  it('confirm fires the substrate mutation and flips status to success', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValue(
      makeJsonResponse(200, {
        name: 'scenario-A',
        metadata: {
          andes_version: '2.0.0',
          andes_app_version: '0.1.0',
          case_filename: 'ieee14.raw',
          case_sha256: null,
          disturbance_log: [],
          saved_at: 'now',
          has_pflow: false,
          has_tds: false,
        },
        dill_bytes: 1024,
        metadata_bytes: 256,
      }),
    );
    render(withQueryClient(<SaveSnapshotDialog />));
    await user.type(
      screen.getByTestId('save-snapshot-name-input'),
      'scenario-A',
    );
    await user.click(screen.getByTestId('save-snapshot-confirm'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/api/sessions/test-session-id/snapshot');
    expect((init as RequestInit).method).toBe('POST');
    await waitFor(() =>
      expect(useSnapshotStore.getState().saveStatus).toBe('success'),
    );
  });

  it('409 collision surfaces an inline overwrite confirm', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValueOnce(
      makeProblemResponse(409, 'snapshot already exists'),
    );
    render(withQueryClient(<SaveSnapshotDialog />));
    await user.type(
      screen.getByTestId('save-snapshot-name-input'),
      'scenario-A',
    );
    await user.click(screen.getByTestId('save-snapshot-confirm'));

    expect(
      await screen.findByTestId('save-snapshot-collision'),
    ).toBeInTheDocument();
    // Now an Overwrite button is visible; the original Save confirm is gone.
    expect(screen.queryByTestId('save-snapshot-confirm')).toBeNull();
    expect(
      screen.getByTestId('save-snapshot-confirm-overwrite'),
    ).toBeEnabled();

    // Second click → re-issue with force=true.
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse(200, {
        name: 'scenario-A',
        metadata: {
          andes_version: '2.0.0',
          andes_app_version: '0.1.0',
          case_filename: null,
          case_sha256: null,
          disturbance_log: [],
          saved_at: 'now',
          has_pflow: false,
          has_tds: false,
        },
        dill_bytes: 1024,
        metadata_bytes: 256,
      }),
    );
    await user.click(screen.getByTestId('save-snapshot-confirm-overwrite'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const secondCallBody = JSON.parse(
      String((fetchSpy.mock.calls[1]![1] as RequestInit).body),
    );
    expect(secondCallBody.force).toBe(true);
  });

  it('422 error surfaces an inline error', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValue(makeProblemResponse(422, 'invalid name'));
    render(withQueryClient(<SaveSnapshotDialog />));
    await user.type(
      screen.getByTestId('save-snapshot-name-input'),
      'scenario-A',
    );
    await user.click(screen.getByTestId('save-snapshot-confirm'));
    await waitFor(() =>
      expect(useSnapshotStore.getState().saveStatus).toBe('error'),
    );
    expect(await screen.findByTestId('save-snapshot-error')).toHaveTextContent(
      /invalid name/i,
    );
  });

  it('cancel closes the dialog without firing the mutation', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<SaveSnapshotDialog />));
    await user.click(screen.getByTestId('save-snapshot-cancel'));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useSnapshotStore.getState().saveDialogOpen).toBe(false);
  });
});
