/**
 * Tests for `<NumericalErrorDetails />`.
 *
 * Pure presentational. The parent (`NumericalErrorBanner`) hands a
 * `RunRecord`; we assert on the rendered fields and the copy-report
 * button.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NumericalErrorDetails } from '@/components/tds/NumericalErrorDetails';
import type { RunRecord } from '@/store/runs';

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-test',
    startedAt: 1000,
    tf: 5,
    tCurrent: 2.345,
    seqCount: 47,
    t: new Float64Array(0),
    columns: {},
    columnNames: [],
    state: 'error',
    connection: 'connected',
    abortedLocally: false,
    errorReason: 'newton diverged at step 47',
    ...overrides,
  };
}

describe('<NumericalErrorDetails />', () => {
  it('renders all diagnostic fields', () => {
    render(<NumericalErrorDetails run={makeRun()} />);
    const root = screen.getByTestId('numerical-error-details');
    expect(root).toHaveTextContent(/2\.3450 s/);
    expect(root).toHaveTextContent(/5\.0000 s/);
    expect(root).toHaveTextContent(/47/);
    expect(root).toHaveTextContent(/newton diverged at step 47/);
    expect(root).toHaveTextContent(/run-test/);
  });

  it('falls back to em-dash when errorReason is null', () => {
    render(<NumericalErrorDetails run={makeRun({ errorReason: null })} />);
    const root = screen.getByTestId('numerical-error-details');
    expect(root).toHaveTextContent('—');
  });

  it('shows a Dismiss button only when onDismiss is provided', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<NumericalErrorDetails run={makeRun()} onDismiss={onDismiss} />);
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
    rerender(<NumericalErrorDetails run={makeRun()} />);
    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
  });

  it('calls onDismiss when the Dismiss button is clicked', async () => {
    const onDismiss = vi.fn();
    render(<NumericalErrorDetails run={makeRun()} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('copies a JSON report when the Copy button is clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<NumericalErrorDetails run={makeRun()} />);
    await userEvent.click(screen.getByTestId('numerical-error-copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const payload = JSON.parse(writeText.mock.calls[0]![0]);
    expect(payload).toMatchObject({
      run_id: 'run-test',
      tf: 5,
      seq_count: 47,
      error_reason: 'newton diverged at step 47',
    });
    // The button briefly flips to "Copied".
    expect(screen.getByTestId('numerical-error-copy')).toHaveTextContent(/copied/i);
  });
});
