/**
 * Tests for `<TdsInitResultDialog />`, the results surface of the "Check
 * initialisation" action beside the TDS run control. The dialog is rendered
 * directly with props: the verdict line, the two tables, the truncation note
 * and the session-state statement, or the error line for a failed check.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TdsInitResultDialog } from '@/components/tds/TdsInitResultDialog';
import type { TdsInitResultDialogProps } from '@/components/tds/TdsInitResultDialog';
import { ProblemDetailsError } from '@/api/client';
import type { TdsInitResult } from '@/api/types';
import { runLockNotice } from '@/lib/runLock';

function makeResult(overrides: Partial<TdsInitResult> = {}): TdsInitResult {
  return {
    initialized: true,
    test_ok: true,
    test_init: true,
    clamped: [],
    residuals: [],
    max_residual: 0,
    nan_residuals: 0,
    n_states: 12,
    n_algeb: 34,
    diagnostics_truncated: false,
    ...overrides,
  };
}

function renderDialog(
  result: TdsInitResult | null,
  error: Error | null = null,
  props: Partial<TdsInitResultDialogProps> = {},
) {
  return render(
    <TdsInitResultDialog
      open={true}
      onOpenChange={() => undefined}
      result={result}
      error={error}
      discardsEdits={false}
      onResetRun={() => undefined}
      resetting={false}
      disturbancesListed={false}
      {...props}
    />,
  );
}

const CARRIES_ON =
  'Run TDS carries on from this initialisation: its record starts at the first step, not at 0 s.';

describe('<TdsInitResultDialog />', () => {
  it('test_ok true with empty lists: verdict, counts, no tables, session note', () => {
    renderDialog(makeResult());
    expect(screen.getByTestId('tds-init-verdict')).toHaveTextContent(
      /^Every dynamic model starts at a steady state\.$/,
    );
    expect(screen.getByTestId('tds-init-counts')).toHaveTextContent(
      '12 state variables, 34 algebraic variables.',
    );
    expect(screen.queryByTestId('tds-init-clamped')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tds-init-residuals')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tds-init-truncated')).not.toBeInTheDocument();
    const note = screen.getByTestId('tds-init-session-note');
    expect(note).toHaveTextContent(runLockNotice(false));
    expect(note).toHaveTextContent(CARRIES_ON);
    expect(note).not.toHaveTextContent('not converged');
  });

  it('test_ok false with clamped and residuals: verdict counts the rows and both tables render', () => {
    renderDialog(
      makeResult({
        test_ok: false,
        max_residual: 0.00123456,
        clamped: [
          {
            model: 'GENROU',
            idx: '1',
            var: 'vf',
            limit_name: 'vfmax',
            limit_val: 5.5,
            unconstr: 6.123456,
          },
        ],
        residuals: [
          { name: 'omega GENROU 1', mismatch: 0.0012, equation: 'd(omega) = 0' },
          { name: 'e GENROU 2', mismatch: 3.4e-5, equation: 'd(e) = 0' },
        ],
      }),
    );
    expect(screen.getByTestId('tds-init-verdict')).toHaveTextContent(
      /^2 equations do not balance at the start; the largest residual is 0\.00123\.$/,
    );
    expect(screen.getByTestId('tds-init-verdict')).not.toHaveTextContent('steady state');

    const clamped = screen.getByRole('table', { name: 'Variables clamped at a limit' });
    const headers = within(clamped)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual(['Model', 'Idx', 'Variable', 'Limit', 'Limit value', 'Wanted value']);
    const cells = within(screen.getByTestId('tds-init-clamped-row-0')).getAllByRole('cell');
    expect(cells.map((c) => c.textContent)).toEqual([
      'GENROU',
      '1',
      'vf',
      'vfmax',
      '5.5',
      // Four significant digits, as formatSignificant gives them.
      '6.123',
    ]);

    const residuals = screen.getByRole('table', { name: 'Equations that do not balance' });
    expect(
      within(residuals)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Name', 'Mismatch', 'Equation']);
    expect(
      within(screen.getByTestId('tds-init-residual-row-1'))
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['e GENROU 2', '3.400e-5', 'd(e) = 0']);
    // The run that follows a failed check is reported as not converged.
    expect(screen.getByTestId('tds-init-session-note')).toHaveTextContent(
      `${CARRIES_ON} Since the check failed, that run is reported as not converged.`,
    );
  });

  it('a clamp on a case that passes still shows its table', () => {
    renderDialog(
      makeResult({
        clamped: [
          { model: 'IEEEX1', idx: '2', var: 'vr', limit_name: 'vrmax', limit_val: 1, unconstr: 2 },
        ],
      }),
    );
    expect(screen.getByTestId('tds-init-clamped')).toBeInTheDocument();
    expect(screen.getByTestId('tds-init-clamped-row-0')).toHaveTextContent('vrmax');
  });

  it('a tiny residual is written as a power of ten to 3 significant digits', () => {
    renderDialog(
      makeResult({
        test_ok: false,
        max_residual: 1.23456e-7,
        residuals: [{ name: 'x', mismatch: 1.23456e-7, equation: '' }],
      }),
    );
    expect(screen.getByTestId('tds-init-verdict')).toHaveTextContent(
      'the largest residual is 1.23e-7.',
    );
  });

  it('test_ok false with NaN residuals: the verdict says so on a second line', () => {
    renderDialog(
      makeResult({
        test_ok: false,
        nan_residuals: 2,
        residuals: [{ name: 'x', mismatch: null, equation: 'd(x) = 0' }],
      }),
    );
    const lines = screen.getByTestId('tds-init-verdict').querySelectorAll('p');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toHaveTextContent(
      /^2 residuals are not numbers, which usually means a parameter of zero where a model divides by it\.$/,
    );
  });

  it('no NaN residuals: no second line', () => {
    renderDialog(
      makeResult({
        test_ok: false,
        residuals: [{ name: 'x', mismatch: 0.5, equation: 'd(x) = 0' }],
      }),
    );
    expect(screen.getByTestId('tds-init-verdict').querySelectorAll('p')).toHaveLength(1);
    expect(screen.getByTestId('tds-init-verdict')).not.toHaveTextContent('not numbers');
  });

  it('test_ok null: the switched-off line, never a pass, and the tables still render', () => {
    renderDialog(
      makeResult({
        test_ok: null,
        test_init: false,
        residuals: [{ name: 'x', mismatch: 0.5, equation: 'd(x) = 0' }],
      }),
    );
    expect(screen.getByTestId('tds-init-verdict')).toHaveTextContent(
      /^The check was switched off; the lists below were computed without it\.$/,
    );
    expect(screen.getByTestId('tds-init-residuals')).toBeInTheDocument();
  });

  it('a null mismatch is shown as "not a number", never as 0 or blank', () => {
    renderDialog(
      makeResult({
        test_ok: false,
        residuals: [{ name: 'x', mismatch: null, equation: 'd(x) = 0' }],
      }),
    );
    const cells = within(screen.getByTestId('tds-init-residual-row-0')).getAllByRole('cell');
    expect(cells[1]).toHaveTextContent(/^not a number$/);
  });

  it('a long equation wraps inside its cell rather than widening the dialog', () => {
    const equation = 'x'.repeat(400);
    renderDialog(makeResult({ test_ok: false, residuals: [{ name: 'x', mismatch: 1, equation }] }));
    const cells = within(screen.getByTestId('tds-init-residual-row-0')).getAllByRole('cell');
    expect(cells[2]).toHaveClass('break-all');
    expect(cells[2]?.closest('.overflow-auto')).not.toBeNull();
  });

  it('diagnostics_truncated true renders the truncation line; false does not', () => {
    const { unmount } = renderDialog(makeResult({ diagnostics_truncated: true }));
    expect(screen.getByTestId('tds-init-truncated')).toHaveTextContent(
      'The lists were cut at 500 rows; the full tables are in the session messages.',
    );
    unmount();
    renderDialog(makeResult({ diagnostics_truncated: false }));
    expect(screen.queryByTestId('tds-init-truncated')).not.toBeInTheDocument();
  });

  it('a truncated failure says "or more" in the verdict', () => {
    renderDialog(
      makeResult({
        test_ok: false,
        diagnostics_truncated: true,
        residuals: [{ name: 'x', mismatch: 0.5, equation: 'd(x) = 0' }],
      }),
    );
    expect(screen.getByTestId('tds-init-verdict')).toHaveTextContent(
      '1 or more equations do not balance at the start',
    );
  });

  it('a 422 error shows the detail and no verdict, tables or session note', () => {
    const error = new ProblemDetailsError({
      type: 'about:blank',
      title: 'Unprocessable Entity',
      status: 422,
      detail: 'the loaded case has no dynamic models',
      instance: null,
    });
    renderDialog(null, error);
    expect(screen.getByTestId('tds-init-error')).toHaveTextContent(
      'The initialisation could not be checked: the loaded case has no dynamic models',
    );
    expect(screen.queryByTestId('tds-init-verdict')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tds-init-clamped')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tds-init-residuals')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tds-init-session-note')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tds-init-reset-run')).not.toBeInTheDocument();
  });

  it('a failure without a server detail shows its message in place of the verdict', () => {
    renderDialog(null, new Error('socket hang up'));
    expect(screen.getByTestId('tds-init-error')).toHaveTextContent(
      'The initialisation could not be checked: socket hang up',
    );
    expect(screen.queryByTestId('tds-init-verdict')).not.toBeInTheDocument();
  });

  it('the session note says what Reset run loses while it would lose edits', () => {
    renderDialog(makeResult(), null, { discardsEdits: true });
    expect(screen.getByTestId('tds-init-session-note')).toHaveTextContent(runLockNotice(true));
  });

  it('with disturbances listed, the next run reads the case again and initialises afresh', () => {
    renderDialog(makeResult({ test_ok: false }), null, { disturbancesListed: true });
    const note = screen.getByTestId('tds-init-session-note');
    expect(note).toHaveTextContent(
      'Run TDS reads the case again to add the listed disturbances, so it initialises afresh rather than from this check.',
    );
    expect(note).not.toHaveTextContent(CARRIES_ON);
  });

  it('Reset run beside the note closes the dialog and resets', async () => {
    const onResetRun = vi.fn();
    const onOpenChange = vi.fn();
    renderDialog(makeResult(), null, { onResetRun, onOpenChange });
    await userEvent.click(screen.getByTestId('tds-init-reset-run'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onResetRun).toHaveBeenCalledTimes(1);
  });

  it('Close and Escape close the dialog; the focus starts inside it', async () => {
    const onOpenChange = vi.fn();
    renderDialog(makeResult(), null, { onOpenChange });
    expect(screen.getByTestId('tds-init-dialog')).toContainElement(
      document.activeElement as HTMLElement,
    );
    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    onOpenChange.mockClear();
    await userEvent.click(screen.getByTestId('tds-init-close'));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});
