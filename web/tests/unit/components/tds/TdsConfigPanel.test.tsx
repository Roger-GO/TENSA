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
    expect(screen.getByTestId('tds-config-integrator-qndf-auto')).not.toBeChecked();
    expect(screen.getByTestId('tds-config-integrator-qndf-manual')).not.toBeChecked();
    expect(screen.queryByTestId('tds-config-tolerance-overrides')).not.toBeInTheDocument();
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
