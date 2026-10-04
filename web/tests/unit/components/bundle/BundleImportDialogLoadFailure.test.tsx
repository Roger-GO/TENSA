/**
 * `<BundleImportButton />` when the dialog body's chunk cannot be fetched (the
 * page was left open across an upgrade): the click toasts instead of opening a
 * dialog with nothing in it, and every later click does the same, because the
 * button closes the dialog again.
 *
 * This file mocks the body module to fail, so it cannot share a file with the
 * tests of the dialog that works.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const toastError = vi.fn<(message: string, opts?: unknown) => string>();
vi.mock('@/lib/toast', () => ({
  toast: { error: (message: string, opts?: unknown) => toastError(message, opts) },
}));
vi.mock('@/components/bundle/BundleImportDialogBody', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

import { BundleImportButton } from '@/components/bundle/BundleImportDialog';
import { useSessionStore } from '@/store/session';
import { parseSessionId } from '@/api/types';

beforeEach(() => {
  toastError.mockReset();
  // The loader logs the failure it swallows; keep the test output clean.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('<BundleImportButton /> — dialog chunk missing', () => {
  it('toasts on every click, and leaves the dialog closed', async () => {
    const user = userEvent.setup();
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <BundleImportButton />
      </QueryClientProvider>,
    );
    const button = screen.getByTestId('bundle-import-button');

    await user.click(button);
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0]?.[0]).toMatch(/could not be loaded/i);
    await vi.waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'false'));

    await user.click(button);
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.queryByTestId('bundle-import-dialog')).not.toBeInTheDocument();
  });
});
