/**
 * Tests for ``<CpfConfigPanel />`` (v3.1 Unit 13).
 *
 * The panel shows what a run can be asked for (what grows, the lower
 * branch, and the Q-limit switch its parent passes in), keeps step +
 * max_iter behind the Advanced disclosure, and gates the Run handler
 * behind validation. We test:
 *
 * - the four directions are in the open and the Advanced disclosure is
 *   collapsed by default and expands on click;
 * - setting direction=gen + step + max_iter and clicking Run passes the
 *   values through to ``onRun``;
 * - a custom direction shows its two tables, is refused while nothing
 *   moves, and hands the parent the two lists;
 * - the lower-branch box asks for the full curve;
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

const LOADS = [
  { idx: 'PQ_1', name: 'Load A', bus: '4', p: 21.7, q: 12.7 },
  { idx: 'PQ_2', name: 'Load B', bus: '5', p: 50, q: 25 },
];
const GENERATORS = [{ idx: '2', name: 'G2', bus: '2', p: 40 }];

function renderPanel(
  onRun: (o: CpfRunOverrides) => void,
  props: Partial<React.ComponentProps<typeof CpfConfigPanel>> = {},
) {
  return render(
    <CpfConfigPanel
      onRun={onRun}
      runLabel="Run CPF"
      runButtonTestId="analyze-run-cpf"
      loads={LOADS}
      generators={GENERATORS}
      {...props}
    />,
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

  it('shows the four directions and the lower-branch box without opening anything', () => {
    renderPanel(vi.fn());
    for (const direction of ['load', 'load-only', 'gen', 'custom']) {
      expect(screen.getByTestId(`cpf-config-direction-${direction}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('cpf-config-direction-load')).toBeChecked();
    expect(screen.getByLabelText(/Loads only/)).toBe(
      screen.getByTestId('cpf-config-direction-load-only'),
    );
    expect(screen.getByTestId('cpf-config-lower-branch')).not.toBeChecked();
    // The tables of a custom direction are there only when it is chosen.
    expect(screen.queryByTestId('cpf-direction-editor')).not.toBeInTheDocument();
  });

  it('renders the Q-limit switch its parent passes in', () => {
    renderPanel(vi.fn(), { limitsSwitch: <span data-testid="the-switch">switch</span> });
    expect(screen.getByTestId('the-switch')).toBeInTheDocument();
  });

  it('expands the Advanced disclosure on click, revealing step + max_iter', async () => {
    const user = userEvent.setup();
    renderPanel(vi.fn());
    await user.click(screen.getByTestId('cpf-config-advanced-toggle'));
    expect(screen.getByTestId('cpf-config-advanced-toggle')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByTestId('cpf-config-advanced')).toBeInTheDocument();
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

  it('runs the loads-only direction and the full curve when asked', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel(onRun);

    await user.click(screen.getByTestId('cpf-config-direction-load-only'));
    await user.click(screen.getByTestId('cpf-config-lower-branch'));
    await user.click(screen.getByTestId('analyze-run-cpf'));

    expect(onRun).toHaveBeenCalledWith({ direction: 'load-only', stopAt: 'full' });
  });

  it('a custom direction shows the loads and generators and hands over what was typed', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel(onRun);

    await user.click(screen.getByTestId('cpf-config-direction-custom'));
    const editor = screen.getByTestId('cpf-direction-editor');
    expect(editor).toHaveTextContent('PQ_1');
    expect(editor).toHaveTextContent('Load B');
    expect(editor).toHaveTextContent('G2');

    await user.type(screen.getByTestId('cpf-direction-load-PQ_2-p'), '10');
    await user.type(screen.getByTestId('cpf-direction-load-PQ_2-q'), '3');
    await user.type(screen.getByTestId('cpf-direction-gen-2-p'), '10');
    await user.click(screen.getByTestId('analyze-run-cpf'));

    expect(onRun).toHaveBeenCalledWith({
      direction: 'custom',
      loadIncrease: [{ idx: 'PQ_2', p: 10, q: 3 }],
      generatorIncrease: [{ idx: '2', p: 10 }],
    });
  });

  it('a custom direction that moves nothing is refused with a reason, and so is a field that is no number', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel(onRun);

    await user.click(screen.getByTestId('cpf-config-direction-custom'));
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(screen.getByTestId('cpf-config-error')).toHaveTextContent(
      'A custom direction needs an increase on at least one load or generator.',
    );
    expect(onRun).not.toHaveBeenCalled();
    // The fault is in the tables, not behind the disclosure, which stays shut.
    expect(screen.queryByTestId('cpf-config-advanced')).not.toBeInTheDocument();

    await user.type(screen.getByTestId('cpf-direction-load-PQ_1-p'), 'ten');
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(screen.getByTestId('cpf-config-error')).toHaveTextContent(
      'The increase of load PQ_1 is not a number.',
    );
    expect(screen.getByTestId('cpf-direction-load-PQ_1-p')).toHaveAttribute('aria-invalid', 'true');
    expect(onRun).not.toHaveBeenCalled();
  });

  it('what was typed for a custom direction does not go out with another direction', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel(onRun);

    await user.click(screen.getByTestId('cpf-config-direction-custom'));
    await user.type(screen.getByTestId('cpf-direction-load-PQ_1-p'), '10');
    await user.click(screen.getByTestId('cpf-config-direction-load'));
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).toHaveBeenCalledWith({ direction: 'load' });

    // It is still there when the user comes back to it.
    await user.click(screen.getByTestId('cpf-config-direction-custom'));
    expect(screen.getByTestId('cpf-direction-load-PQ_1-p')).toHaveValue('10');
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
