/**
 * Tests for `<RuntimeCrashModal />`.
 *
 * The modal is the one allowed non-destructive modal per R18 + R8
 * mapping. Locked backdrop (no Esc, no overlay-click). Reload button
 * + Copy report button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RuntimeCrashModal } from '@/components/pflow/RuntimeCrashModal';
import { ServerError, ProblemDetailsError } from '@/api/client';
import { usePflowStore } from '@/store/pflow';

describe('<RuntimeCrashModal />', () => {
  beforeEach(() => {
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  });

  afterEach(() => {
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  });

  it('does not render when there is no error', () => {
    render(<RuntimeCrashModal />);
    expect(screen.queryByTestId('runtime-crash-modal')).not.toBeInTheDocument();
  });

  it('does not render for a non-5xx ProblemDetailsError', () => {
    usePflowStore.setState({
      error: new ProblemDetailsError({
        type: 'about:blank',
        title: 'Validation',
        status: 422,
        detail: 'bad input',
      }),
    });
    render(<RuntimeCrashModal />);
    expect(screen.queryByTestId('runtime-crash-modal')).not.toBeInTheDocument();
  });

  it('renders for a ServerError (5xx)', () => {
    usePflowStore.setState({
      error: new ServerError({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'pflow crashed',
      }),
    });
    render(<RuntimeCrashModal />);

    expect(screen.getByTestId('runtime-crash-modal')).toBeInTheDocument();
    expect(screen.getByText(/something went wrong on the server/i)).toBeInTheDocument();
  });

  it('renders via the primitive modal but keeps the locked two-path footer (no neutral Close)', () => {
    usePflowStore.setState({
      error: new ServerError({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'pflow crashed',
      }),
    });
    render(<RuntimeCrashModal />);

    // The migrated wrapper renders the primitive's modal (role=dialog).
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // The bespoke "one-allowed-modal" behaviour: ONLY Copy + Reload — the
    // primitive's generic "Close" escape hatch is suppressed.
    expect(screen.getByTestId('runtime-crash-copy')).toBeInTheDocument();
    expect(screen.getByTestId('runtime-crash-reload')).toBeInTheDocument();
    expect(screen.queryByTestId('runtime-crash-modal-close')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^close$/i })).not.toBeInTheDocument();
  });

  it('expands technical detail on disclosure click', async () => {
    usePflowStore.setState({
      error: new ServerError({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'pflow crashed',
      }),
    });
    render(<RuntimeCrashModal />);

    expect(screen.queryByTestId('runtime-crash-detail')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /view technical detail/i }));

    expect(screen.getByTestId('runtime-crash-detail')).toBeInTheDocument();
    expect(screen.getByTestId('runtime-crash-detail')).toHaveTextContent(/pflow crashed/i);
  });

  it('Copy error report calls clipboard.writeText', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText }, userAgent: 'test' },
    });
    usePflowStore.setState({
      error: new ServerError({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'pflow crashed',
      }),
    });
    render(<RuntimeCrashModal />);

    await userEvent.click(screen.getByTestId('runtime-crash-copy'));

    expect(writeText).toHaveBeenCalled();
    const arg = (writeText.mock.calls[0] as unknown[])[0] as string;
    expect(arg).toContain('pflow crashed');
    expect(arg).toContain('500');
  });

  it('Reload button calls window.location.reload + clears the error', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });
    usePflowStore.setState({
      error: new ServerError({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'pflow crashed',
      }),
    });
    render(<RuntimeCrashModal />);

    await userEvent.click(screen.getByTestId('runtime-crash-reload'));

    expect(reload).toHaveBeenCalled();
    expect(usePflowStore.getState().error).toBeNull();
  });

  it('Esc does NOT close the modal (locked backdrop)', async () => {
    usePflowStore.setState({
      error: new ServerError({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'pflow crashed',
      }),
    });
    render(<RuntimeCrashModal />);

    expect(screen.getByTestId('runtime-crash-modal')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByTestId('runtime-crash-modal')).toBeInTheDocument();
    expect(usePflowStore.getState().error).not.toBeNull();
  });
});
