/**
 * Tests for ``<CpfConfigPanel />`` (v3.1 Unit 13).
 *
 * The panel exposes the CPF Advanced disclosure (direction load|gen +
 * step + max_iter) and gates the Run handler behind validation. We
 * test:
 *
 * - the Advanced disclosure is collapsed by default and expands on click;
 * - setting direction=gen + step + max_iter and clicking Run passes the
 *   values through to ``onRun``;
 * - an invalid (negative) step renders the inline error banner and blocks
 *   the ``onRun`` call.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CpfConfigPanel,
  validateCpfOverrides,
  type CpfRunOverrides,
} from '@/components/analyze/CpfConfigPanel';

function renderPanel(onRun: (o: CpfRunOverrides) => void) {
  return render(
    <CpfConfigPanel onRun={onRun} runLabel="Run CPF" runButtonTestId="analyze-run-cpf" />,
  );
}

describe('validateCpfOverrides', () => {
  it('accepts blank fields (substrate defaults)', () => {
    expect(validateCpfOverrides('', '')).toEqual({});
  });

  it('accepts a positive step + positive integer max_iter', () => {
    expect(validateCpfOverrides('0.05', '50')).toEqual({});
  });

  it('rejects a negative step', () => {
    expect(validateCpfOverrides('-0.1', '')).toHaveProperty('step');
  });

  it('rejects a non-integer / non-positive max_iter', () => {
    expect(validateCpfOverrides('', '0')).toHaveProperty('maxIter');
    expect(validateCpfOverrides('', '2.5')).toHaveProperty('maxIter');
  });
});

describe('<CpfConfigPanel />', () => {
  it('renders the Run button and a collapsed Advanced disclosure by default', () => {
    renderPanel(vi.fn());
    expect(screen.getByTestId('analyze-run-cpf')).toBeInTheDocument();
    expect(screen.getByTestId('cpf-config-advanced-toggle')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // Body is not in the DOM while collapsed.
    expect(screen.queryByTestId('cpf-config-advanced')).not.toBeInTheDocument();
  });

  it('expands the Advanced disclosure on click, revealing direction + step + max_iter', async () => {
    const user = userEvent.setup();
    renderPanel(vi.fn());
    await user.click(screen.getByTestId('cpf-config-advanced-toggle'));
    expect(screen.getByTestId('cpf-config-advanced-toggle')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByTestId('cpf-config-advanced')).toBeInTheDocument();
    expect(screen.getByTestId('cpf-config-direction-load')).toBeInTheDocument();
    expect(screen.getByTestId('cpf-config-direction-gen')).toBeInTheDocument();
    expect(screen.getByTestId('field-cpf-config-step')).toBeInTheDocument();
    expect(screen.getByTestId('field-cpf-config-max-iter')).toBeInTheDocument();
  });

  it('defaults direction to load and runs with just the direction when fields are blank', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel(onRun);
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledWith({ direction: 'load' });
  });

  it('passes direction=gen + step + max_iter through to onRun', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel(onRun);

    await user.click(screen.getByTestId('cpf-config-advanced-toggle'));
    await user.click(screen.getByTestId('cpf-config-direction-gen'));
    await user.type(screen.getByTestId('field-cpf-config-step'), '0.05');
    await user.type(screen.getByTestId('field-cpf-config-max-iter'), '50');

    await user.click(screen.getByTestId('analyze-run-cpf'));

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledWith({ direction: 'gen', step: 0.05, maxIter: 50 });
  });

  it('invalid (negative) step renders the inline error banner and blocks onRun', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel(onRun);

    await user.click(screen.getByTestId('cpf-config-advanced-toggle'));
    await user.type(screen.getByTestId('field-cpf-config-step'), '-0.1');

    await user.click(screen.getByTestId('analyze-run-cpf'));

    // The validation banner (ProblemDetailsErrorSurface) surfaces.
    expect(screen.getByTestId('cpf-config-error')).toBeInTheDocument();
    expect(screen.getByTestId('error-cpf-config-step')).toBeInTheDocument();
    // onRun was NOT called — the invalid request never reaches the parent.
    expect(onRun).not.toHaveBeenCalled();
  });
});
