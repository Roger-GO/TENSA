/**
 * Tests for `<RecoveryBadge />`.
 *
 * Covers the v0.1.y Unit 5 spec rows:
 *
 * - Hidden when neither ``recoveryInProgress`` nor ``recoveryFailed`` is set.
 * - Visible warning pill when ``recoveryInProgress`` is true.
 * - Visible destructive pill when ``recoveryFailed`` is true (takes
 *   precedence over the in-progress flag — the failed state is terminal).
 * - Auto-hides when ``recoveryInProgress`` flips back to false.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { RecoveryBadge } from '@/components/shell/RecoveryBadge';
import { useSessionStore } from '@/store/session';

describe('<RecoveryBadge />', () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessionId: null,
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
  });

  afterEach(() => {
    useSessionStore.setState({
      sessionId: null,
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
  });

  it('renders nothing when no recovery is in progress and no failure', () => {
    const { container } = render(<RecoveryBadge />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the Reconnecting pill when recoveryInProgress is true', () => {
    useSessionStore.setState({ recoveryInProgress: true });
    render(<RecoveryBadge />);
    const badge = screen.getByTestId('recovery-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent(/Reconnecting/i);
    expect(screen.getByTestId('recovery-badge-spinner')).toBeInTheDocument();
    // Warning styling.
    expect(badge.className).toMatch(/bg-warning/);
    expect(badge.className).toMatch(/text-warning/);
  });

  it('renders the failed pill when recoveryFailed is true (takes precedence)', () => {
    useSessionStore.setState({ recoveryInProgress: true, recoveryFailed: true });
    render(<RecoveryBadge />);
    const badge = screen.getByTestId('recovery-badge-failed');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent(/Reconnection failed/i);
    expect(badge).toHaveTextContent(/reload the tab/i);
    expect(badge.className).toMatch(/bg-destructive/);
    expect(badge.className).toMatch(/text-destructive/);
    // The Reconnecting pill is NOT rendered.
    expect(screen.queryByTestId('recovery-badge')).not.toBeInTheDocument();
  });

  it('hides when recoveryInProgress flips back to false', () => {
    useSessionStore.setState({ recoveryInProgress: true });
    const { container } = render(<RecoveryBadge />);
    expect(screen.getByTestId('recovery-badge')).toBeInTheDocument();

    act(() => {
      useSessionStore.setState({ recoveryInProgress: false });
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('uses role=status with aria-live so AT users hear the transition', () => {
    useSessionStore.setState({ recoveryInProgress: true });
    render(<RecoveryBadge />);
    const badge = screen.getByRole('status');
    expect(badge).toHaveAttribute('aria-live', 'polite');
  });

  it('uses aria-live=assertive on the failed branch', () => {
    useSessionStore.setState({ recoveryFailed: true });
    render(<RecoveryBadge />);
    const badge = screen.getByRole('status');
    expect(badge).toHaveAttribute('aria-live', 'assertive');
  });
});
