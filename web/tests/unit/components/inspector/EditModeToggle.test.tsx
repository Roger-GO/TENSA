/**
 * Tests for `<EditModeToggle />` (v3.1 Unit 22).
 *
 * Covers:
 * - Starts in Run mode; aria-checked reflects the case-store editMode.
 * - Clicking flips Run → Edit and fires the clone-init POST.
 * - Clicking again flips Edit → Run WITHOUT a second init.
 * - Disabled while a TDS run is streaming.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { EditModeToggle } from '@/components/inspector/EditModeToggle';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { useRunsStore } from '@/store/runs';
import { parseSessionId } from '@/api/types';

const fetchSpy = vi.fn();
const originalFetch = globalThis.fetch;

function withProviders(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>
  );
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
  useCaseStore.setState({ editMode: 'run', cloneInitialized: false });
  useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set<string>() });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  useCaseStore.setState({ editMode: 'run', cloneInitialized: false });
});

describe('<EditModeToggle />', () => {
  it('starts in Run mode (aria-checked false)', () => {
    render(withProviders(<EditModeToggle />));
    const toggle = screen.getByTestId('edit-mode-toggle');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveTextContent('Run');
  });

  it('clicking Run → Edit flips mode and fires clone-init POST', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValue(
      makeJsonResponse(200, {
        clone_dir: '/tmp/clone',
        clone_files: ['/tmp/clone/kundur_full.xlsx'],
        already_initialized: false,
        job_id: 'job-1',
      }),
    );
    render(withProviders(<EditModeToggle />));
    await user.click(screen.getByTestId('edit-mode-toggle'));

    // Mode flips immediately.
    expect(useCaseStore.getState().editMode).toBe('edit');
    // Clone init POST fired.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/api/sessions/test-session-id/case/clone');
    expect((init as RequestInit).method).toBe('POST');
    await waitFor(() => expect(useCaseStore.getState().cloneInitialized).toBe(true));
  });

  it('Edit → Run does not fire a second init', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValue(
      makeJsonResponse(200, {
        clone_dir: '/tmp/clone',
        clone_files: [],
        already_initialized: false,
        job_id: 'job-1',
      }),
    );
    render(withProviders(<EditModeToggle />));
    const toggle = screen.getByTestId('edit-mode-toggle');
    await user.click(toggle); // → edit (init fires)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await user.click(toggle); // → run (no init)
    expect(useCaseStore.getState().editMode).toBe('run');
    // Still only one POST.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('is disabled while a TDS run is streaming', () => {
    useRunsStore.setState({
      runs: {
        r1: {
          // Minimal RunRecord shape — the toggle only reads `state`.
          state: 'streaming',
        } as never,
      },
      activeRunId: 'r1',
      overlayRunIds: new Set<string>(),
    });
    render(withProviders(<EditModeToggle />));
    expect(screen.getByTestId('edit-mode-toggle')).toBeDisabled();
  });
});
