/**
 * Tests for ``<TdsConfigPanel />`` (v0.2 Unit 8).
 *
 * The panel is a thin form wrapping ``useUiStore.tdsConfig`` — each test
 * seeds the store, renders, drives the inputs, and asserts on either
 * the rendered DOM (errors, checkbox state) or the resulting store
 * value. Validation rules are duplicated against ``validateTdsConfig``
 * deliberately so a regression in either layer surfaces here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TdsConfigPanel } from '@/components/tds/TdsConfigPanel';
import {
  DEFAULT_TDS_CONFIG,
  DEFAULT_TDS_CONFIG_OVERRIDES,
  DEFAULT_TDS_INTEGRATOR,
  DEFAULT_TDS_TOLERANCE_OVERRIDES,
  TDS_VAR_GROUPS,
  useUiStore,
} from '@/store/ui';

function resetUi() {
  useUiStore.setState({
    hideLabels: false,
    tdsConfig: { ...DEFAULT_TDS_CONFIG },
    tdsIntegrator: DEFAULT_TDS_INTEGRATOR,
    tdsToleranceOverrides: { ...DEFAULT_TDS_TOLERANCE_OVERRIDES },
    tdsConfigOverrides: { ...DEFAULT_TDS_CONFIG_OVERRIDES },
  });
}

describe('<TdsConfigPanel />', () => {
  beforeEach(() => {
    resetUi();
  });

  afterEach(() => {
    resetUi();
  });

  it('renders defaults from useUiStore: tf=10, h blank, vars=[bus_v, gen_state], max_rate_hz=30', () => {
    render(<TdsConfigPanel />);
    expect(screen.getByTestId('field-tds-config-tf')).toHaveValue('10');
    expect(screen.getByTestId('field-tds-config-h')).toHaveValue('');
    expect(screen.getByTestId('field-tds-config-max-rate')).toHaveValue('30');
    const vars = screen.getByTestId('tds-config-vars');
    // Voltage + frequency (gen_state) stream by default so both are
    // plottable without re-running.
    expect(within(vars).getByTestId('tds-config-var-bus_v')).toBeChecked();
    expect(within(vars).getByTestId('tds-config-var-gen_state')).toBeChecked();
    // The remaining groups are opt-in.
    expect(within(vars).getByTestId('tds-config-var-gen_power')).not.toBeChecked();
    expect(within(vars).getByTestId('tds-config-var-line_flow')).not.toBeChecked();
    expect(within(vars).getByTestId('tds-config-var-load_pq')).not.toBeChecked();
  });

  it('renders a checkbox for every TDS_VAR_GROUPS entry', () => {
    render(<TdsConfigPanel />);
    const vars = screen.getByTestId('tds-config-vars');
    for (const group of TDS_VAR_GROUPS) {
      expect(within(vars).getByTestId(`tds-config-var-${group}`)).toBeInTheDocument();
    }
  });

  it('notes that the variable set is fixed at run-start', () => {
    render(<TdsConfigPanel />);
    expect(screen.getByTestId('tds-config-vars-fixed-hint')).toHaveTextContent(/before/i);
  });

  it('editing tf writes through to the store', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    const tfInput = screen.getByTestId('field-tds-config-tf');
    await user.clear(tfInput);
    await user.type(tfInput, '20');
    expect(useUiStore.getState().tdsConfig.tf).toBe(20);
  });

  it('blank h is treated as null (substrate-adaptive)', async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      tdsConfig: { ...DEFAULT_TDS_CONFIG, h: 0.001 },
    });
    render(<TdsConfigPanel />);
    const hInput = screen.getByTestId('field-tds-config-h');
    await user.clear(hInput);
    expect(useUiStore.getState().tdsConfig.h).toBeNull();
  });

  it('typing in h sets the numeric value in the store', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    const hInput = screen.getByTestId('field-tds-config-h');
    await user.type(hInput, '0.01');
    expect(useUiStore.getState().tdsConfig.h).toBe(0.01);
  });

  it('toggling a variable group adds and removes it from the store', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    // gen_power is opt-in (not in the default vars), so a click adds it.
    const genPowerBox = screen.getByTestId('tds-config-var-gen_power');
    await user.click(genPowerBox);
    expect(useUiStore.getState().tdsConfig.vars).toEqual(['bus_v', 'gen_state', 'gen_power']);
    await user.click(genPowerBox);
    expect(useUiStore.getState().tdsConfig.vars).toEqual(['bus_v', 'gen_state']);
  });

  it('toggling load_pq on adds the load consumption group', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    await user.click(screen.getByTestId('tds-config-var-load_pq'));
    expect(useUiStore.getState().tdsConfig.vars).toContain('load_pq');
  });

  it('shows a validation error when tf <= 0', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    const tfInput = screen.getByTestId('field-tds-config-tf');
    await user.clear(tfInput);
    await user.type(tfInput, '0');
    expect(screen.getByTestId('error-tds-config-tf')).toHaveTextContent(/> 0/);
    expect(tfInput).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows a validation error when no variables are selected', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    // Both bus_v and gen_state are on by default — deselect both to reach
    // the empty-vars validation state.
    await user.click(screen.getByTestId('tds-config-var-bus_v'));
    await user.click(screen.getByTestId('tds-config-var-gen_state'));
    expect(useUiStore.getState().tdsConfig.vars).toEqual([]);
    expect(screen.getByTestId('error-tds-config-vars')).toHaveTextContent(/at least one/i);
  });

  it('Reset button restores the defaults after editing', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    const tfInput = screen.getByTestId('field-tds-config-tf');
    await user.clear(tfInput);
    await user.type(tfInput, '42');
    await user.click(screen.getByTestId('tds-config-var-gen_power'));
    expect(useUiStore.getState().tdsConfig.tf).toBe(42);
    expect(useUiStore.getState().tdsConfig.vars).toEqual(['bus_v', 'gen_state', 'gen_power']);
    await user.click(screen.getByTestId('tds-config-reset'));
    expect(useUiStore.getState().tdsConfig).toEqual(DEFAULT_TDS_CONFIG);
    // Raw text inputs re-sync to the defaults.
    expect(screen.getByTestId('field-tds-config-tf')).toHaveValue('10');
  });

  it('offers the ANDES variables beside the groups, and Reset forgets the ones picked', async () => {
    const user = userEvent.setup();
    useUiStore.getState().setTdsConfig({ daeVars: ['omega GENROU 1'] });
    render(<TdsConfigPanel />);

    const picker = screen.getByTestId('tds-config-dae-vars');
    expect(picker).toBeInTheDocument();
    expect(within(picker).getByTestId('tds-config-dae-chip-omega GENROU 1')).toBeInTheDocument();
    // Without a case loaded there is nothing to list from, and it says so.
    expect(within(picker).getByTestId('tds-config-dae-status')).toHaveTextContent('Load a case');

    await user.click(screen.getByTestId('tds-config-reset'));

    expect(useUiStore.getState().tdsConfig.daeVars).toEqual([]);
    expect(screen.queryByTestId('tds-config-dae-chip-omega GENROU 1')).toBeNull();
  });

  it('offers frequency control beside the variables, and Reset forgets the controllers set', async () => {
    const user = userEvent.setup();
    useUiStore.getState().setTdsConfig({
      controllers: [
        {
          spec: {
            type: 'droop',
            model: 'ESD1',
            idx: 1,
            frequency: 'coi',
            period: 0.1,
            t_start: 0,
            ramp: null,
            gain: 50,
            deadband: 0.02,
            p_max: null,
          },
          record: ['Pext ESD1 1'],
        },
      ],
    });
    render(<TdsConfigPanel />);

    const editor = screen.getByTestId('tds-config-controllers');
    expect(within(editor).getByTestId('tds-controller-0')).toHaveTextContent('Droop on ESD1 1');
    // Without a case loaded there is no device to command, and it says so.
    expect(within(editor).getByTestId('tds-controllers-status')).toHaveTextContent('Load a case');

    await user.click(screen.getByTestId('tds-config-reset'));

    expect(useUiStore.getState().tdsConfig.controllers).toEqual([]);
    expect(screen.queryByTestId('tds-controller-0')).toBeNull();
  });

  it('shows a validation error when max_rate_hz is non-positive', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    const maxRate = screen.getByTestId('field-tds-config-max-rate');
    await user.clear(maxRate);
    await user.type(maxRate, '0');
    expect(screen.getByTestId('error-tds-config-max-rate')).toBeInTheDocument();
  });

  // ---- Unit 16: integrator preset selector ----

  it('default integrator is Trapezoidal and the Manual reveal is hidden', () => {
    render(<TdsConfigPanel />);
    expect(screen.getByTestId('tds-config-integrator-trapezoidal')).toBeChecked();
    expect(screen.getByTestId('tds-config-integrator-backeuler')).not.toBeChecked();
    expect(screen.getByTestId('tds-config-integrator-trap_adapt-auto')).not.toBeChecked();
    expect(screen.getByTestId('tds-config-integrator-trap_adapt-manual')).not.toBeChecked();
    expect(screen.getByTestId('tds-config-integrator-qndf-auto')).not.toBeChecked();
    expect(screen.getByTestId('tds-config-integrator-qndf-manual')).not.toBeChecked();
    expect(screen.queryByTestId('tds-config-tolerance-overrides')).not.toBeInTheDocument();
  });

  it('renders six integrator radios, each with its one-line hint', () => {
    render(<TdsConfigPanel />);
    const group = screen.getByTestId('tds-config-integrator');
    for (const value of [
      'trapezoidal',
      'backeuler',
      'trap_adapt-auto',
      'trap_adapt-manual',
      'qndf-auto',
      'qndf-manual',
    ]) {
      expect(within(group).getByTestId(`tds-config-integrator-${value}`)).toBeInTheDocument();
    }
    expect(
      screen.getByText(
        'First-order, more damped than trapezoidal. Uses h above; ignores rtol / atol.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Variable-step trapezoidal with sensible tolerances/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Variable-step trapezoidal with hand-tuned tolerances/),
    ).toBeInTheDocument();
  });

  it('heads the fixed-step and the variable-step choices, all in one radio group', () => {
    render(<TdsConfigPanel />);
    const group = screen.getByTestId('tds-config-integrator');
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.id.replace('tds-config-integrator-', ''))).toEqual([
      'trapezoidal',
      'backeuler',
      'trap_adapt-auto',
      'trap_adapt-manual',
      'qndf-auto',
      'qndf-manual',
    ]);
    expect(new Set(radios.map((r) => r.getAttribute('name')))).toEqual(
      new Set(['tds-config-integrator']),
    );
    const fixed = within(group).getByTestId('tds-config-integrator-group-fixed');
    const variable = within(group).getByTestId('tds-config-integrator-group-variable');
    // The heading of each group comes right before its first choice.
    const follows = (a: Element, b: Element) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(fixed, radios[0]!)).toBe(true);
    expect(follows(radios[1]!, variable)).toBe(true);
    expect(follows(variable, radios[2]!)).toBe(true);
  });

  it('a min_step above max_step is refused inline in Manual', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    await user.click(screen.getByTestId('tds-config-integrator-trap_adapt-manual'));
    const minStep = screen.getByTestId('field-tds-config-min-step');
    await user.clear(minStep);
    await user.type(minStep, '0.1');
    expect(screen.getByTestId('error-tds-config-min-step')).toHaveTextContent(
      'Must be <= max_step',
    );
    const maxStep = screen.getByTestId('field-tds-config-max-step');
    await user.clear(maxStep);
    await user.type(maxStep, '0.2');
    expect(screen.queryByTestId('error-tds-config-min-step')).toBeNull();
  });

  it('selecting Backward Euler writes through and keeps the reveal hidden', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    await user.click(screen.getByTestId('tds-config-integrator-backeuler'));
    expect(useUiStore.getState().tdsIntegrator).toBe('backeuler');
    expect(screen.getByTestId('tds-config-integrator-backeuler')).toBeChecked();
    expect(screen.queryByTestId('tds-config-tolerance-overrides')).not.toBeInTheDocument();
    expect(screen.getByTestId('field-tds-config-h')).toBeInTheDocument();
  });

  it('h is visible for the fixed-step integrators and hidden for every variable-step choice', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    expect(screen.getByTestId('field-tds-config-h')).toBeInTheDocument();
    await user.click(screen.getByTestId('tds-config-integrator-trap_adapt-auto'));
    expect(screen.queryByTestId('field-tds-config-h')).toBeNull();
    await user.click(screen.getByTestId('tds-config-integrator-qndf-manual'));
    expect(screen.queryByTestId('field-tds-config-h')).toBeNull();
    await user.click(screen.getByTestId('tds-config-integrator-backeuler'));
    expect(screen.getByTestId('field-tds-config-h')).toBeInTheDocument();
  });

  it('selecting trap_adapt Manual reveals rtol / atol / max_step / min_step', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    await user.click(screen.getByTestId('tds-config-integrator-trap_adapt-manual'));
    expect(useUiStore.getState().tdsIntegrator).toBe('trap_adapt-manual');
    expect(screen.getByTestId('tds-config-tolerance-overrides')).toBeInTheDocument();
    expect(screen.getByTestId('field-tds-config-rtol')).toHaveValue('0.001');
    expect(screen.getByTestId('field-tds-config-atol')).toHaveValue('0.000001');
    expect(screen.getByTestId('field-tds-config-max-step')).toHaveValue('0.05');
    expect(screen.getByTestId('field-tds-config-min-step')).toHaveValue('0');
  });

  it('selecting trap_adapt Auto keeps the reveal hidden', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    await user.click(screen.getByTestId('tds-config-integrator-trap_adapt-auto'));
    expect(useUiStore.getState().tdsIntegrator).toBe('trap_adapt-auto');
    expect(screen.queryByTestId('tds-config-tolerance-overrides')).toBeNull();
  });

  it('editing min_step in Manual mode writes through to the store', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    await user.click(screen.getByTestId('tds-config-integrator-qndf-manual'));
    const minStep = screen.getByTestId('field-tds-config-min-step');
    await user.clear(minStep);
    await user.type(minStep, '0.0001');
    expect(useUiStore.getState().tdsToleranceOverrides.minStep).toBe(0.0001);
  });

  it('min_step accepts 0', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    await user.click(screen.getByTestId('tds-config-integrator-qndf-manual'));
    const minStep = screen.getByTestId('field-tds-config-min-step');
    await user.clear(minStep);
    await user.type(minStep, '0');
    expect(screen.queryByTestId('error-tds-config-min-step')).toBeNull();
    expect(useUiStore.getState().tdsToleranceOverrides.minStep).toBe(0);
  });

  it('negative min_step is refused inline', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    await user.click(screen.getByTestId('tds-config-integrator-qndf-manual'));
    const minStep = screen.getByTestId('field-tds-config-min-step');
    await user.clear(minStep);
    await user.type(minStep, '-1');
    expect(screen.getByTestId('error-tds-config-min-step')).toHaveTextContent('Must be >= 0');
    expect(minStep).toHaveAttribute('aria-invalid', 'true');
  });

  it('non-numeric min_step is refused inline', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    await user.click(screen.getByTestId('tds-config-integrator-qndf-manual'));
    const minStep = screen.getByTestId('field-tds-config-min-step');
    await user.clear(minStep);
    expect(screen.getByTestId('error-tds-config-min-step')).toHaveTextContent(
      'Enter a finite number',
    );
  });

  it('min_step error is hidden in Auto mode and the draft value is kept', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    await user.click(screen.getByTestId('tds-config-integrator-qndf-manual'));
    const minStep = screen.getByTestId('field-tds-config-min-step');
    await user.clear(minStep);
    await user.type(minStep, '-1');
    expect(screen.getByTestId('error-tds-config-min-step')).toBeInTheDocument();
    await user.click(screen.getByTestId('tds-config-integrator-qndf-auto'));
    expect(screen.queryByTestId('tds-config-tolerance-overrides')).toBeNull();
    expect(screen.queryByTestId('error-tds-config-min-step')).toBeNull();
    expect(useUiStore.getState().tdsToleranceOverrides.minStep).toBe(-1);
  });

  it('switching fixed-step to variable-step and back preserves the h draft', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    const hInput = screen.getByTestId('field-tds-config-h');
    await user.type(hInput, '0.01');
    expect(useUiStore.getState().tdsConfig.h).toBe(0.01);
    await user.click(screen.getByTestId('tds-config-integrator-trap_adapt-auto'));
    expect(screen.queryByTestId('field-tds-config-h')).toBeNull();
    await user.click(screen.getByTestId('tds-config-integrator-trapezoidal'));
    expect(useUiStore.getState().tdsConfig.h).toBe(0.01);
    expect(screen.getByTestId('field-tds-config-h')).toHaveValue('0.01');
  });

  it('Reset restores trapezoidal, shows h, and resets min_step', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    await user.click(screen.getByTestId('tds-config-integrator-qndf-manual'));
    const minStep = screen.getByTestId('field-tds-config-min-step');
    await user.clear(minStep);
    await user.type(minStep, '0.5');
    expect(useUiStore.getState().tdsToleranceOverrides.minStep).toBe(0.5);
    await user.click(screen.getByTestId('tds-config-reset'));
    expect(useUiStore.getState().tdsIntegrator).toBe('trapezoidal');
    expect(useUiStore.getState().tdsToleranceOverrides).toEqual(DEFAULT_TDS_TOLERANCE_OVERRIDES);
    expect(screen.getByTestId('field-tds-config-h')).toBeInTheDocument();
    await user.click(screen.getByTestId('tds-config-integrator-qndf-manual'));
    expect(screen.getByTestId('field-tds-config-min-step')).toHaveValue('0');
  });

  it('a persisted legacy tolerance payload gains minStep on rehydrate', async () => {
    sessionStorage.setItem(
      'andes-ui-tds-integrator',
      JSON.stringify({
        state: {
          tdsIntegrator: 'qndf-auto',
          tdsToleranceOverrides: { rtol: 0.001, atol: 0.000001, maxStep: 0.05 },
        },
        version: 0,
      }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().tdsToleranceOverrides.minStep).toBe(0);
    expect(useUiStore.getState().tdsToleranceOverrides.rtol).toBe(0.001);
    expect(useUiStore.getState().tdsToleranceOverrides.atol).toBe(0.000001);
    expect(useUiStore.getState().tdsToleranceOverrides.maxStep).toBe(0.05);
    sessionStorage.removeItem('andes-ui-tds-integrator');
  });

  it('selecting QNDF Auto writes through to the store but keeps the reveal hidden', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    await user.click(screen.getByTestId('tds-config-integrator-qndf-auto'));
    expect(useUiStore.getState().tdsIntegrator).toBe('qndf-auto');
    expect(screen.getByTestId('tds-config-integrator-qndf-auto')).toBeChecked();
    // Auto preset hides the per-field inputs — the user opted into the
    // sensible defaults rather than hand-tuning.
    expect(screen.queryByTestId('tds-config-tolerance-overrides')).not.toBeInTheDocument();
  });

  it('selecting QNDF Manual reveals rtol / atol / max_step inputs', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    await user.click(screen.getByTestId('tds-config-integrator-qndf-manual'));
    expect(useUiStore.getState().tdsIntegrator).toBe('qndf-manual');
    expect(screen.getByTestId('tds-config-tolerance-overrides')).toBeInTheDocument();
    expect(screen.getByTestId('field-tds-config-rtol')).toHaveValue('0.001');
    expect(screen.getByTestId('field-tds-config-atol')).toHaveValue('0.000001');
    expect(screen.getByTestId('field-tds-config-max-step')).toHaveValue('0.05');
    expect(screen.getByTestId('field-tds-config-min-step')).toHaveValue('0');
  });

  it('editing rtol in Manual mode writes through to the store', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    await user.click(screen.getByTestId('tds-config-integrator-qndf-manual'));
    const rtol = screen.getByTestId('field-tds-config-rtol');
    await user.clear(rtol);
    await user.type(rtol, '0.0001');
    expect(useUiStore.getState().tdsToleranceOverrides.rtol).toBe(0.0001);
  });

  it('shows a validation error when rtol is non-positive in Manual mode', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    await user.click(screen.getByTestId('tds-config-integrator-qndf-manual'));
    const rtol = screen.getByTestId('field-tds-config-rtol');
    await user.clear(rtol);
    await user.type(rtol, '0');
    expect(screen.getByTestId('error-tds-config-rtol')).toBeInTheDocument();
  });

  it('switching modes mid-edit preserves the user form state', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    // Edit rtol in Manual mode.
    await user.click(screen.getByTestId('tds-config-integrator-qndf-manual'));
    const rtol = screen.getByTestId('field-tds-config-rtol');
    await user.clear(rtol);
    await user.type(rtol, '0.0005');
    expect(useUiStore.getState().tdsToleranceOverrides.rtol).toBe(0.0005);
    // Switch to Auto then back to Manual — the stored value must survive.
    await user.click(screen.getByTestId('tds-config-integrator-qndf-auto'));
    expect(useUiStore.getState().tdsToleranceOverrides.rtol).toBe(0.0005);
    await user.click(screen.getByTestId('tds-config-integrator-qndf-manual'));
    expect(useUiStore.getState().tdsToleranceOverrides.rtol).toBe(0.0005);
  });

  it('Reset button restores trapezoidal default + clears overrides', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    await user.click(screen.getByTestId('tds-config-integrator-qndf-manual'));
    const rtol = screen.getByTestId('field-tds-config-rtol');
    await user.clear(rtol);
    await user.type(rtol, '0.0005');
    await user.click(screen.getByTestId('tds-config-reset'));
    expect(useUiStore.getState().tdsIntegrator).toBe('trapezoidal');
    expect(useUiStore.getState().tdsToleranceOverrides).toEqual(DEFAULT_TDS_TOLERANCE_OVERRIDES);
  });

  // ---- Unit 14: tds_config_overrides key-value editor ----

  it('the overrides editor is empty by default and forwards no overrides', () => {
    render(<TdsConfigPanel />);
    expect(screen.getByTestId('tds-config-overrides-editor')).toBeInTheDocument();
    expect(screen.getByTestId('tds-config-overrides-empty')).toBeInTheDocument();
    expect(useUiStore.getState().tdsConfigOverrides).toEqual({});
  });

  it('adding a row with a custom key + numeric value commits it to the store dict', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    await user.click(screen.getByTestId('tds-config-override-add'));
    await user.type(screen.getByTestId('tds-config-override-key-0'), 'tol');
    await user.type(screen.getByTestId('tds-config-override-value-0'), '0.0001');
    expect(useUiStore.getState().tdsConfigOverrides).toEqual({ tol: 0.0001 });
  });

  it('removing the only row clears the override back to an empty dict', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    await user.click(screen.getByTestId('tds-config-override-add'));
    await user.type(screen.getByTestId('tds-config-override-key-0'), 'max_iter');
    await user.type(screen.getByTestId('tds-config-override-value-0'), '30');
    expect(useUiStore.getState().tdsConfigOverrides).toEqual({ max_iter: 30 });
    await user.click(screen.getByTestId('tds-config-override-remove-0'));
    expect(useUiStore.getState().tdsConfigOverrides).toEqual({});
    expect(screen.getByTestId('tds-config-overrides-empty')).toBeInTheDocument();
  });

  it('a non-numeric override value surfaces an inline error and is not committed', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    await user.click(screen.getByTestId('tds-config-override-add'));
    await user.type(screen.getByTestId('tds-config-override-key-0'), 'tol');
    await user.type(screen.getByTestId('tds-config-override-value-0'), 'abc');
    expect(screen.getByTestId('error-tds-config-override-0')).toBeInTheDocument();
    expect(useUiStore.getState().tdsConfigOverrides).toEqual({});
  });

  it('Reset clears any committed overrides', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    await user.click(screen.getByTestId('tds-config-override-add'));
    await user.type(screen.getByTestId('tds-config-override-key-0'), 'tol');
    await user.type(screen.getByTestId('tds-config-override-value-0'), '0.0001');
    expect(useUiStore.getState().tdsConfigOverrides).toEqual({ tol: 0.0001 });
    await user.click(screen.getByTestId('tds-config-reset'));
    expect(useUiStore.getState().tdsConfigOverrides).toEqual({});
    expect(screen.getByTestId('tds-config-overrides-empty')).toBeInTheDocument();
  });
});
