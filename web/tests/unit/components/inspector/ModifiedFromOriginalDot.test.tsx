/**
 * Tests for `<ModifiedFromOriginalDot />` (v3.1 Unit 23).
 *
 * Covers:
 * - Renders the warning dot with an accessible label.
 * - Tooltip surfaces "Original: X → Y".
 * - The "Revert this field" mini-button fires a clone-edit PUT with the
 *   original value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { ModifiedFromOriginalDot } from '@/components/inspector/ModifiedFromOriginalDot';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSessionStore } from '@/store/session';
import { parseSessionId } from '@/api/types';
import type { CloneDiffPair } from '@/api/types';

const fetchSpy = vi.fn();
const originalFetch = globalThis.fetch;

function withProviders(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>
    </QueryClientProvider>
  );
}

function makeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const DIFF: CloneDiffPair = { original: 1.5, current: 2 };

beforeEach(() => {
  fetchSpy.mockReset();
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

describe('<ModifiedFromOriginalDot />', () => {
  it('renders the warning dot with an accessible label', () => {
    render(
      withProviders(<ModifiedFromOriginalDot model="IEEEX1" idx="1" param="Vrmax" diff={DIFF} />),
    );
    const dot = screen.getByTestId('modified-dot-Vrmax');
    expect(dot).toBeInTheDocument();
    // A real focusable button (keyboard-reachable), with the diff in its name.
    expect(dot.tagName).toBe('BUTTON');
    expect(dot.getAttribute('aria-label')).toMatch(/vrmax modified from original/i);

  });

  it('popover surfaces "Original: X → Y" on activate', async () => {
    const user = userEvent.setup();
    render(
      withProviders(<ModifiedFromOriginalDot model="IEEEX1" idx="1" param="Vrmax" diff={DIFF} />),
    );
    await user.click(screen.getByTestId('modified-dot-Vrmax'));
    const pop = await screen.findAllByTestId('modified-dot-popover-Vrmax');
    expect(pop[0]).toHaveTextContent('Original: 1.5 → 2');
  });

  it('Revert this field fires a clone-edit PUT with the original value', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValue(
      makeJsonResponse(200, {
        model: 'IEEEX1',
        idx: '1',
        param: 'Vrmax',
        new_value: 1.5,
        undo_depth: 2,
        redo_depth: 0,
        job_id: 'j1',
      }),
    );
    render(
      withProviders(<ModifiedFromOriginalDot model="IEEEX1" idx="1" param="Vrmax" diff={DIFF} />),
    );
    await user.click(screen.getByTestId('modified-dot-Vrmax'));
    const revertBtns = await screen.findAllByTestId('modified-dot-revert-Vrmax');
    await user.click(revertBtns[0]!);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain(
      '/api/sessions/test-session-id/case/clone/params/IEEEX1/1/Vrmax',
    );
    expect((init as RequestInit).method).toBe('PUT');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.value).toBe(1.5);
  });
});
