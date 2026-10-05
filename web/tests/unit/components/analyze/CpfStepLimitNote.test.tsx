/**
 * Tests for ``<CpfStepLimitNote />``: what the form says about a nose-curve
 * run that used up its steps, and the button that runs it again with more.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CpfStepLimitNote } from '@/components/analyze/CpfStepLimitNote';
import type { CpfResult } from '@/api/types';

// 500 steps up a custom direction of small increases, and no nose yet.
const CUT_SHORT: CpfResult = {
  lambdas: [0, 100, 247.2766],
  voltages_per_bus: { '1': [1.06, 1.04, 1.0] },
  bus_idxes: ['1'],
  nose_idx: -1,
  max_lam: 247.2766,
  truncated: true,
  done_msg: 'Reached max steps (500)',
  mode: 'pv',
  direction: 'custom',
  stop_at: 'nose',
  complete: false,
};

// A full curve whose lower branch ran out of steps on the way back.
const LOWER_BRANCH_CUT: CpfResult = {
  lambdas: [0, 2, 3.25, 2.5, 1.2],
  voltages_per_bus: { '1': [1.06, 1.0, 0.9, 0.7, 0.5] },
  bus_idxes: ['1'],
  nose_idx: 2,
  max_lam: 3.25,
  truncated: false,
  done_msg: 'Reached max steps (40)',
  mode: 'pv',
  direction: 'load',
  stop_at: 'full',
  complete: false,
};

describe('<CpfStepLimitNote />', () => {
  it('says how far a run without a nose got, and why a custom direction takes long', () => {
    render(<CpfStepLimitNote result={CUT_SHORT} onRunAgain={vi.fn()} />);
    const note = screen.getByTestId('cpf-step-limit-note');
    expect(note).toHaveTextContent(
      'The run used all of its 500 steps and stopped at λ = 247.2766, before it reached the nose.',
    );
    expect(note).toHaveTextContent('λ counts multiples of the increases you typed');
    expect(note).toHaveTextContent('ten times the increases is the same curve at a tenth of the λ');
    expect(screen.getByRole('button', { name: 'Run again with up to 2000 steps' })).toBeEnabled();
  });

  it('says that the nose stands when it is the lower branch that stopped', () => {
    render(<CpfStepLimitNote result={LOWER_BRANCH_CUT} onRunAgain={vi.fn()} />);
    const note = screen.getByTestId('cpf-step-limit-note');
    expect(note).toHaveTextContent(
      'The run used all of its 40 steps: it found the nose (λ = 3.2500) and stopped on the lower branch at λ = 1.2000, before it was back at the base load.',
    );
    // The scale of lambda is the base case's, so nothing is said about it.
    expect(note).not.toHaveTextContent('you typed');
    expect(note).toHaveTextContent('More steps take it further.');
  });

  it('runs again with four times the steps', async () => {
    const onRunAgain = vi.fn();
    render(<CpfStepLimitNote result={CUT_SHORT} onRunAgain={onRunAgain} />);
    await userEvent.click(screen.getByTestId('cpf-step-limit-run-again'));
    expect(onRunAgain).toHaveBeenCalledExactlyOnceWith(2000);
  });

  it('cannot run again while no run can start', () => {
    render(<CpfStepLimitNote result={CUT_SHORT} onRunAgain={vi.fn()} disabled />);
    expect(screen.getByTestId('cpf-step-limit-run-again')).toBeDisabled();
  });

  it('says nothing about a run that ended another way, or about none', () => {
    const { rerender } = render(<CpfStepLimitNote result={null} onRunAgain={vi.fn()} />);
    expect(screen.queryByTestId('cpf-step-limit-note')).not.toBeInTheDocument();
    rerender(
      <CpfStepLimitNote
        result={{ ...CUT_SHORT, done_msg: 'Corrector failed at lambda=0.3' }}
        onRunAgain={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('cpf-step-limit-note')).not.toBeInTheDocument();
    rerender(
      <CpfStepLimitNote
        result={{
          ...LOWER_BRANCH_CUT,
          complete: true,
          done_msg: 'Full curve traced (returned to lambda=0)',
        }}
        onRunAgain={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('cpf-step-limit-note')).not.toBeInTheDocument();
  });
});
