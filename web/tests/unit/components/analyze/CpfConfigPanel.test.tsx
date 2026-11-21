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
 *   the ``onRun`` call;
 * - what the parent says about the last run sits by the Run button, and its
 *   "run with more steps" writes the Max steps field and runs the form.
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

  it('shows the four directions and the stop-at radios without opening anything', () => {
    renderPanel(vi.fn());
    for (const direction of ['load', 'load-only', 'gen', 'custom']) {
      expect(screen.getByTestId(`cpf-config-direction-${direction}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('cpf-config-direction-load')).toBeChecked();
    expect(screen.getByLabelText(/Loads only/)).toBe(
      screen.getByTestId('cpf-config-direction-load-only'),
    );
    expect(screen.getByTestId('cpf-config-stop-at-nose')).toBeChecked();
    expect(screen.getByTestId('cpf-config-lower-branch')).not.toBeChecked();
    expect(screen.getByTestId('cpf-config-stop-at-target')).not.toBeChecked();
    // The target-lambda field is there only while the target stop is chosen.
    expect(screen.queryByTestId('field-cpf-config-stop-at-lambda')).not.toBeInTheDocument();
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
    // The fields go by the names the rest of the form uses for them, and each
    // says what it does to a run and what blank stands for.
    expect(screen.getByLabelText('Step (optional)')).toHaveAccessibleDescription(
      /does not shorten a long run\. Blank is its default, 0\.1\./,
    );
    expect(screen.getByLabelText('Max steps (optional)')).toHaveAccessibleDescription(
      /raise this to go further\. Blank is ANDES's default, 500\./,
    );
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

  it('sends no solver setting the user left blank', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel(onRun);
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).toHaveBeenCalledTimes(1);
    const overrides = onRun.mock.calls[0]![0] as Record<string, unknown>;
    expect(overrides).toEqual({ direction: 'load' });
    for (const key of [
      'parameterization',
      'tol',
      'correctorMaxIter',
      'stepMin',
      'stepMax',
      'stopAtLambda',
    ]) {
      expect(overrides).not.toHaveProperty(key);
    }
  });

  it('passes the parameterization through, and the clear button takes it back', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel(onRun);

    await user.click(screen.getByTestId('cpf-config-advanced-toggle'));
    await user.click(screen.getByTestId('cpf-config-parameterization-natural'));
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).toHaveBeenLastCalledWith({ direction: 'load', parameterization: 'natural' });

    await user.click(screen.getByTestId('cpf-config-parameterization-clear'));
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).toHaveBeenLastCalledWith({ direction: 'load' });
  });

  it('passes the tolerance through, and refuses one looser than 1e-4', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel(onRun);

    await user.click(screen.getByTestId('cpf-config-advanced-toggle'));
    await user.type(screen.getByTestId('field-cpf-config-tol'), '0.0001');
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).toHaveBeenLastCalledWith({ direction: 'load', tol: 0.0001 });

    await user.clear(screen.getByTestId('field-cpf-config-tol'));
    await user.type(screen.getByTestId('field-cpf-config-tol'), '0.001');
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('cpf-config-error')).toHaveTextContent(
      'Tolerance must be at most 1e-4.',
    );
    // The offending field is behind the disclosure, which opens on it.
    expect(screen.getByTestId('cpf-config-advanced')).toBeInTheDocument();
  });

  it('holds the corrector iterations to an integer of at least 2', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel(onRun);

    await user.click(screen.getByTestId('cpf-config-advanced-toggle'));
    await user.type(screen.getByTestId('field-cpf-config-corrector-max-iter'), '1');
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).not.toHaveBeenCalled();
    expect(screen.getByTestId('cpf-config-error')).toHaveTextContent(
      'Corrector iterations must be an integer of at least 2.',
    );

    await user.clear(screen.getByTestId('field-cpf-config-corrector-max-iter'));
    await user.type(screen.getByTestId('field-cpf-config-corrector-max-iter'), '5');
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).toHaveBeenCalledWith({ direction: 'load', correctorMaxIter: 5 });
  });

  it('refuses a minimum step above the maximum, and passes the two through in order', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel(onRun);

    await user.click(screen.getByTestId('cpf-config-advanced-toggle'));
    await user.type(screen.getByTestId('field-cpf-config-step-min'), '0.1');
    await user.type(screen.getByTestId('field-cpf-config-step-max'), '0.01');
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).not.toHaveBeenCalled();
    expect(screen.getByTestId('cpf-config-error')).toHaveTextContent(
      'Minimum step must not be above maximum step.',
    );

    await user.clear(screen.getByTestId('field-cpf-config-step-min'));
    await user.clear(screen.getByTestId('field-cpf-config-step-max'));
    await user.type(screen.getByTestId('field-cpf-config-step-min'), '0.01');
    await user.type(screen.getByTestId('field-cpf-config-step-max'), '0.1');
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).toHaveBeenCalledWith({ direction: 'load', stepMin: 0.01, stepMax: 0.1 });
  });

  it('a target stop shows its lambda field and sends the number, never with stopAt', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel(onRun);

    await user.click(screen.getByTestId('cpf-config-stop-at-target'));
    expect(screen.getByTestId('field-cpf-config-stop-at-lambda')).toBeInTheDocument();
    await user.type(screen.getByTestId('field-cpf-config-stop-at-lambda'), '2.5');
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).toHaveBeenCalledWith({ direction: 'load', stopAtLambda: 2.5 });
  });

  it('a target stop without a positive lambda is refused', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel(onRun);

    await user.click(screen.getByTestId('cpf-config-stop-at-target'));
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).not.toHaveBeenCalled();
    expect(screen.getByTestId('cpf-config-error')).toHaveTextContent(
      'Target λ must be a positive number.',
    );

    await user.type(screen.getByTestId('field-cpf-config-stop-at-lambda'), '0');
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).not.toHaveBeenCalled();
    expect(screen.getByTestId('cpf-config-error')).toHaveTextContent(
      'Target λ must be a positive number.',
    );
  });

  it('refuses the natural parameterization with the full curve before sending', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel(onRun);

    await user.click(screen.getByTestId('cpf-config-advanced-toggle'));
    await user.click(screen.getByTestId('cpf-config-parameterization-natural'));
    await user.click(screen.getByTestId('cpf-config-lower-branch'));
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).not.toHaveBeenCalled();
    expect(screen.getByTestId('cpf-config-error')).toHaveTextContent('cannot trace the full curve');
  });

  it('refuses natural with the full curve in either order, and lets go when either changes', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel(onRun);

    // The full curve first, then the parameterization.
    await user.click(screen.getByTestId('cpf-config-lower-branch'));
    await user.click(screen.getByTestId('cpf-config-advanced-toggle'));
    await user.click(screen.getByTestId('cpf-config-parameterization-natural'));
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).not.toHaveBeenCalled();
    const natural = screen.getByTestId('cpf-config-parameterization-natural');
    const message = screen.getByTestId('error-cpf-config-parameterization');
    expect(message).toHaveTextContent(
      'The natural parameterization cannot trace the full curve: choose another parameterization, or stop at the nose or at a target λ.',
    );
    expect(natural).toHaveAttribute('aria-describedby', message.id);

    // Another parameterization clears it.
    await user.click(screen.getByTestId('cpf-config-parameterization-arclength'));
    expect(screen.queryByTestId('cpf-config-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('error-cpf-config-parameterization')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).toHaveBeenLastCalledWith({
      direction: 'load',
      stopAt: 'full',
      parameterization: 'arclength',
    });

    // Natural again is refused again; stopping at the nose clears it.
    await user.click(screen.getByTestId('cpf-config-parameterization-natural'));
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('cpf-config-error')).toBeInTheDocument();
    await user.click(screen.getByTestId('cpf-config-stop-at-nose'));
    expect(screen.queryByTestId('cpf-config-error')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).toHaveBeenLastCalledWith({ direction: 'load', parameterization: 'natural' });
  });

  it('the stop-at choice is one named radio group with a legend, and a target is sent as a number', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel(onRun);

    const group = screen.getByRole('group', { name: 'Where to stop' });
    const radios = [
      screen.getByTestId('cpf-config-stop-at-nose'),
      screen.getByTestId('cpf-config-lower-branch'),
      screen.getByTestId('cpf-config-stop-at-target'),
    ];
    for (const radio of radios) {
      expect(group).toContainElement(radio);
      expect(radio).toHaveAttribute('type', 'radio');
      expect(radio).toHaveAttribute('name', 'cpf-config-stop-at');
    }
    expect(screen.getByLabelText(/Full curve/)).toBe(radios[1]);

    await user.click(radios[2]!);
    await user.type(screen.getByLabelText('Target λ'), '1.75');
    await user.click(screen.getByTestId('analyze-run-cpf'));
    const overrides = onRun.mock.calls[0]![0] as CpfRunOverrides;
    expect(typeof overrides.stopAtLambda).toBe('number');
    expect(overrides.stopAtLambda).toBe(1.75);
    expect(overrides).not.toHaveProperty('stopAt');

    // Back to the full curve: the string as before, and no target.
    await user.click(radios[1]!);
    expect(radios[1]).toBeChecked();
    expect(radios[0]).not.toBeChecked();
    expect(radios[2]).not.toBeChecked();
    expect(screen.queryByTestId('field-cpf-config-stop-at-lambda')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).toHaveBeenLastCalledWith({ direction: 'load', stopAt: 'full' });
  });

  it('a refused target shows by its field and leaves Advanced shut', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel(onRun);

    await user.click(screen.getByTestId('cpf-config-stop-at-target'));
    await user.type(screen.getByTestId('field-cpf-config-stop-at-lambda'), '-2');
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).not.toHaveBeenCalled();
    const field = screen.getByTestId('field-cpf-config-stop-at-lambda');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field.getAttribute('aria-describedby')).toContain('cpf-config-stop-at-lambda-error');
    expect(screen.getByTestId('error-cpf-config-stop-at-lambda')).toHaveTextContent(
      'Target λ must be a positive number.',
    );
    expect(screen.queryByTestId('cpf-config-advanced')).not.toBeInTheDocument();
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

  it('shows what the parent says about the last run by the Run button', () => {
    renderPanel(vi.fn(), {
      runStatus: <span data-testid="status">18 steps</span>,
      renderRunFollowUp: () => <span data-testid="follow-up">used up its steps</span>,
    });
    const status = screen.getByTestId('status');
    // Beside the button, in its row.
    expect(status.parentElement).toContainElement(screen.getByTestId('analyze-run-cpf'));
    // The follow-up comes before the options.
    const followUp = screen.getByTestId('follow-up');
    expect(
      followUp.compareDocumentPosition(screen.getByTestId('cpf-config-direction')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('runs the form as it stands with more steps, and shows the number it wrote', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel(onRun, {
      renderRunFollowUp: ({ runWithMaxSteps }) => (
        <button type="button" onClick={() => runWithMaxSteps(2000)}>
          more steps
        </button>
      ),
    });
    await user.click(screen.getByTestId('cpf-config-direction-custom'));
    await user.type(screen.getByTestId('cpf-direction-load-PQ_1-p'), '10');
    await user.click(screen.getByTestId('cpf-config-lower-branch'));

    await user.click(screen.getByRole('button', { name: 'more steps' }));

    expect(onRun).toHaveBeenCalledExactlyOnceWith({
      direction: 'custom',
      loadIncrease: [{ idx: 'PQ_1', p: 10, q: 0 }],
      generatorIncrease: [],
      stopAt: 'full',
      maxIter: 2000,
    });
    // Advanced is open on the field, which keeps the number for the next run.
    expect(screen.getByTestId('field-cpf-config-max-iter')).toHaveValue('2000');
    await user.click(screen.getByTestId('analyze-run-cpf'));
    expect(onRun).toHaveBeenLastCalledWith(expect.objectContaining({ maxIter: 2000 }));
  });

  it('more steps do not get a form that is not valid past the check', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel(onRun, {
      renderRunFollowUp: ({ runWithMaxSteps }) => (
        <button type="button" onClick={() => runWithMaxSteps(2000)}>
          more steps
        </button>
      ),
    });
    // A custom direction with nothing typed moves nothing.
    await user.click(screen.getByTestId('cpf-config-direction-custom'));
    await user.click(screen.getByRole('button', { name: 'more steps' }));
    expect(onRun).not.toHaveBeenCalled();
    expect(screen.getByTestId('cpf-config-error')).toHaveTextContent(
      'A custom direction needs an increase on at least one load or generator.',
    );
  });
});
