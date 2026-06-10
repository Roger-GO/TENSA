/**
 * Tests for `<ProblemDetailsErrorSurface />` (Unit 7).
 *
 * Covers the three variants:
 *
 * - `banner`: title + detail + raw-JSON disclosure + dismiss + recovery CTA.
 * - `modal`: Radix dialog (backdrop + single Close + recovery CTA).
 * - `toast`: registers a `toast.error` (with the recovery as the `action`
 *   field per the AGENTS.md policy).
 *
 * Plus: `recovery=null` → no CTA; raw extras (e.g. `dependents`) surface in
 * the disclosure.
 *
 * `lib/toast` is mocked so the toast variant's registration is assertable.
 * `<RecoveryActionButton>` is mocked to a deterministic stub so this suite
 * isolates the SURFACE's behaviour (the routing switch has its own suite).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

interface ToastErrorOpts {
  description?: string;
  action?: { label: string; onClick: () => void };
}
const toastErrorMock = vi.fn((_message: string, _opts?: ToastErrorOpts) => 'toast-id');

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: (message: string, opts?: ToastErrorOpts) => toastErrorMock(message, opts),
    warning: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock('@/components/error/RecoveryActionButton', () => ({
  RecoveryActionButton: ({ recovery }: { recovery: { label: string } | null }) =>
    recovery ? <button data-testid="stub-recovery">{recovery.label}</button> : null,
}));

import { ProblemDetailsErrorSurface } from '@/components/error/ProblemDetailsErrorSurface';
import { ProblemDetailsError } from '@/api/client';
import type { RecoveryDescriptor } from '@/lib/recovery';

const RELOAD: RecoveryDescriptor = { kind: 'reload-case', label: 'Reload the case' };

/** A ProblemDetails-shaped object with a recovery + a raw extra. */
function problemShape(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'about:blank',
    title: 'Power flow did not converge',
    status: 422,
    detail: 'The Newton iteration diverged after 30 steps.',
    recovery: RELOAD,
    ...overrides,
  };
}

describe('<ProblemDetailsErrorSurface />', () => {
  beforeEach(() => {
    toastErrorMock.mockClear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ---- banner -------------------------------------------------------------

  describe('variant="banner"', () => {
    it('renders title + detail', () => {
      render(<ProblemDetailsErrorSurface error={problemShape()} variant="banner" />);
      expect(screen.getByText('Power flow did not converge')).toBeInTheDocument();
      expect(screen.getByText('The Newton iteration diverged after 30 steps.')).toBeInTheDocument();
    });

    it('renders an alert role', () => {
      render(<ProblemDetailsErrorSurface error={problemShape()} variant="banner" />);
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('renders the raw-JSON disclosure (collapsed → expanded)', async () => {
      render(<ProblemDetailsErrorSurface error={problemShape()} variant="banner" />);
      // Collapsed by default.
      expect(screen.queryByTestId('problem-error-surface-raw')).not.toBeInTheDocument();
      await userEvent.click(screen.getByTestId('problem-error-surface-raw-toggle'));
      const raw = screen.getByTestId('problem-error-surface-raw');
      expect(raw).toBeInTheDocument();
      // The full body (incl. recovery) is serialised in the disclosure.
      expect(raw).toHaveTextContent('reload-case');
    });

    it('surfaces raw extras (e.g. dependents) in the disclosure', async () => {
      const err = problemShape({
        title: 'Delete blocked',
        dependents: [{ model: 'Line', idx: 'L1' }],
      });
      render(<ProblemDetailsErrorSurface error={err} variant="banner" />);
      await userEvent.click(screen.getByTestId('problem-error-surface-raw-toggle'));
      const raw = screen.getByTestId('problem-error-surface-raw');
      expect(raw).toHaveTextContent('dependents');
      expect(raw).toHaveTextContent('L1');
    });

    it('renders the recovery CTA when a recovery is present', () => {
      render(<ProblemDetailsErrorSurface error={problemShape()} variant="banner" />);
      expect(screen.getByTestId('stub-recovery')).toHaveTextContent('Reload the case');
    });

    it('recovery=null → no CTA, still renders title + detail + dismiss', () => {
      render(
        <ProblemDetailsErrorSurface
          error={problemShape({ recovery: null })}
          variant="banner"
          onDismiss={() => {}}
        />,
      );
      expect(screen.queryByTestId('stub-recovery')).not.toBeInTheDocument();
      expect(screen.getByText('Power flow did not converge')).toBeInTheDocument();
      expect(screen.getByTestId('problem-error-surface-dismiss')).toBeInTheDocument();
    });

    it('recovery kind="none" → no CTA', () => {
      render(
        <ProblemDetailsErrorSurface
          error={problemShape({ recovery: { kind: 'none', label: 'x' } })}
          variant="banner"
        />,
      );
      expect(screen.queryByTestId('stub-recovery')).not.toBeInTheDocument();
    });

    it('clicking Dismiss fires onDismiss', async () => {
      const onDismiss = vi.fn();
      render(
        <ProblemDetailsErrorSurface
          error={problemShape()}
          variant="banner"
          onDismiss={onDismiss}
        />,
      );
      await userEvent.click(screen.getByTestId('problem-error-surface-dismiss'));
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('no onDismiss → no dismiss affordance', () => {
      render(<ProblemDetailsErrorSurface error={problemShape()} variant="banner" />);
      expect(screen.queryByTestId('problem-error-surface-dismiss')).not.toBeInTheDocument();
    });

    it('reads recovery off a live ProblemDetailsError instance', () => {
      const err = new ProblemDetailsError(
        {
          type: 'about:blank',
          title: 'EIG mutated dae',
          status: 409,
          detail: 'reload',
          instance: null,
        },
        { title: 'EIG mutated dae', status: 409, recovery: RELOAD },
        '/api/sessions/s/pflow',
      );
      render(<ProblemDetailsErrorSurface error={err} variant="banner" />);
      expect(screen.getByTestId('stub-recovery')).toHaveTextContent('Reload the case');
    });
  });

  // ---- modal --------------------------------------------------------------

  describe('variant="modal"', () => {
    it('renders the dialog content with a backdrop', () => {
      render(<ProblemDetailsErrorSurface error={problemShape()} variant="modal" />);
      expect(screen.getByTestId('problem-error-surface')).toBeInTheDocument();
      // Radix renders the dialog in a role=dialog node.
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('renders title + detail', () => {
      render(<ProblemDetailsErrorSurface error={problemShape()} variant="modal" />);
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText('Power flow did not converge')).toBeInTheDocument();
      expect(
        within(dialog).getByText('The Newton iteration diverged after 30 steps.'),
      ).toBeInTheDocument();
    });

    it('renders a single Close affordance + the recovery action', () => {
      render(<ProblemDetailsErrorSurface error={problemShape()} variant="modal" />);
      expect(screen.getByTestId('problem-error-surface-close')).toHaveTextContent('Close');
      expect(screen.getByTestId('stub-recovery')).toHaveTextContent('Reload the case');
    });

    it('clicking Close fires onDismiss', async () => {
      const onDismiss = vi.fn();
      render(
        <ProblemDetailsErrorSurface error={problemShape()} variant="modal" onDismiss={onDismiss} />,
      );
      await userEvent.click(screen.getByTestId('problem-error-surface-close'));
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('recovery=null → Close only, no recovery action', () => {
      render(
        <ProblemDetailsErrorSurface error={problemShape({ recovery: null })} variant="modal" />,
      );
      expect(screen.getByTestId('problem-error-surface-close')).toBeInTheDocument();
      expect(screen.queryByTestId('stub-recovery')).not.toBeInTheDocument();
    });

    it('exposes the raw-JSON disclosure', async () => {
      render(<ProblemDetailsErrorSurface error={problemShape()} variant="modal" />);
      await userEvent.click(screen.getByTestId('problem-error-surface-raw-toggle'));
      expect(screen.getByTestId('problem-error-surface-raw')).toBeInTheDocument();
    });
  });

  // ---- toast --------------------------------------------------------------

  describe('variant="toast"', () => {
    it('registers a toast.error with the title', () => {
      render(<ProblemDetailsErrorSurface error={problemShape()} variant="toast" />);
      expect(toastErrorMock).toHaveBeenCalledTimes(1);
      const [message] = toastErrorMock.mock.calls[0]!;
      expect(message).toBe('Power flow did not converge');
    });

    it('passes the recovery as the toast action (per AGENTS.md policy)', () => {
      render(<ProblemDetailsErrorSurface error={problemShape()} variant="toast" />);
      const [, opts] = toastErrorMock.mock.calls[0]!;
      expect(opts?.description).toBe('The Newton iteration diverged after 30 steps.');
      expect(opts?.action).toBeDefined();
      expect(opts?.action?.label).toBe('Reload the case');
      expect(typeof opts?.action?.onClick).toBe('function');
    });

    it('recovery=null → toast.error with NO action field', () => {
      render(
        <ProblemDetailsErrorSurface error={problemShape({ recovery: null })} variant="toast" />,
      );
      const [, opts] = toastErrorMock.mock.calls[0]!;
      expect(opts?.action).toBeUndefined();
    });

    it('renders nothing in the React tree', () => {
      const { container } = render(
        <ProblemDetailsErrorSurface error={problemShape()} variant="toast" />,
      );
      expect(container).toBeEmptyDOMElement();
    });

    it('a retry toast action fires onRetry then onDismiss', () => {
      const onRetry = vi.fn();
      const onDismiss = vi.fn();
      render(
        <ProblemDetailsErrorSurface
          error={problemShape({ recovery: { kind: 'retry', label: 'Try again' } })}
          variant="toast"
          onRetry={onRetry}
          onDismiss={onDismiss}
        />,
      );
      const [, opts] = toastErrorMock.mock.calls[0]!;
      opts?.action?.onClick();
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  });
});
