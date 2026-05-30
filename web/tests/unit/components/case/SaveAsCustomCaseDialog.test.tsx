/**
 * Tests for `<SaveAsCustomCaseDialog />` (v3.1 Unit 22).
 *
 * Covers:
 * - Validation: empty / invalid-shape name disables confirm.
 * - Name collision (case-insensitive vs existing workspace files) → inline
 *   error + disabled confirm.
 * - Confirm fires the clone save-as POST and flips to the success state.
 * - Cancel closes without firing the mutation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { SaveAsCustomCaseDialog } from '@/components/case/SaveAsCustomCaseDialog';
import { useSessionStore } from '@/store/session';
import { useAuthStore } from '@/store/auth';
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

const WORKSPACE_FILES = {
  files: [
    { name: 'kundur_full.xlsx', size_bytes: 100, modified_iso: 'now', format: 'xlsx' },
    { name: 'ieee14.raw', size_bytes: 100, modified_iso: 'now', format: 'raw' },
  ],
};

/** Route fetch: GET /workspace/files → file list; everything else → save-as ok. */
function routeFetch(saveResponse?: Response) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/workspace/files') && method === 'GET') {
      return Promise.resolve(makeJsonResponse(200, WORKSPACE_FILES));
    }
    return Promise.resolve(
      saveResponse ??
        makeJsonResponse(201, { name: 'kundur_tuned', files: ['/ws/kundur_tuned.xlsx'], job_id: 'j1' }),
    );
  };
}

beforeEach(() => {
  fetchSpy.mockReset();
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
  // Mark auth disabled so the workspace-files query (gated on useAuthReady)
  // fires under a no-auth test backend.
  useAuthStore.setState({ authDisabled: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

describe('<SaveAsCustomCaseDialog /> — validation', () => {
  it('confirm disabled with an empty name', async () => {
    fetchSpy.mockImplementation(routeFetch());
    render(withQueryClient(<SaveAsCustomCaseDialog open onOpenChange={() => {}} />));
    expect(await screen.findByTestId('save-as-custom-case-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('save-as-custom-confirm')).toBeDisabled();
  });

  it('shows a shape-validation error for an invalid name', async () => {
    const user = userEvent.setup();
    fetchSpy.mockImplementation(routeFetch());
    render(withQueryClient(<SaveAsCustomCaseDialog open onOpenChange={() => {}} />));
    await user.type(screen.getByTestId('save-as-custom-name-input'), '../bad');
    expect(await screen.findByTestId('save-as-custom-validation-error')).toBeInTheDocument();
    expect(screen.getByTestId('save-as-custom-confirm')).toBeDisabled();
  });

  it('rejects a name colliding with an existing workspace file (case-insensitive)', async () => {
    const user = userEvent.setup();
    fetchSpy.mockImplementation(routeFetch());
    render(withQueryClient(<SaveAsCustomCaseDialog open onOpenChange={() => {}} />));
    // Wait for the workspace-files query to resolve.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    // 'KUNDUR_FULL' collides with 'kundur_full.xlsx' stem case-insensitively.
    await user.type(screen.getByTestId('save-as-custom-name-input'), 'KUNDUR_FULL');
    await waitFor(() =>
      expect(screen.getByTestId('save-as-custom-validation-error')).toHaveTextContent(
        /already in use/i,
      ),
    );
    expect(screen.getByTestId('save-as-custom-confirm')).toBeDisabled();
  });
});

describe('<SaveAsCustomCaseDialog /> — confirm flow', () => {
  it('confirm fires the clone save-as POST and flips to success', async () => {
    const user = userEvent.setup();
    fetchSpy.mockImplementation(routeFetch());
    render(withQueryClient(<SaveAsCustomCaseDialog open onOpenChange={() => {}} />));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await user.type(screen.getByTestId('save-as-custom-name-input'), 'kundur_tuned');
    await user.click(screen.getByTestId('save-as-custom-confirm'));

    await waitFor(() => {
      const saveCall = fetchSpy.mock.calls.find(
        ([u, i]) =>
          String(u).includes('/case/clone/save-as') &&
          ((i as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'POST',
      );
      expect(saveCall).toBeDefined();
    });
    expect(await screen.findByTestId('save-as-custom-success')).toBeInTheDocument();
  });

  it('cancel closes without firing the save-as mutation', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    fetchSpy.mockImplementation(routeFetch());
    render(withQueryClient(<SaveAsCustomCaseDialog open onOpenChange={onOpenChange} />));
    await user.click(screen.getByTestId('save-as-custom-cancel'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // No save-as POST fired (only the workspace-files GET may have).
    const saveCall = fetchSpy.mock.calls.find(([u]) => String(u).includes('/case/clone/save-as'));
    expect(saveCall).toBeUndefined();
  });
});
