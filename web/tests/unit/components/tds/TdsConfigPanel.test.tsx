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
  DEFAULT_TDS_INTEGRATOR,
  DEFAULT_TDS_TOLERANCE_OVERRIDES,
  useUiStore,
} from '@/store/ui';

function resetUi() {
  useUiStore.setState({
    hideLabels: false,
    activeRightDockTopPanel: 'inspector',
    tdsConfig: { ...DEFAULT_TDS_CONFIG },
    tdsIntegrator: DEFAULT_TDS_INTEGRATOR,
    tdsToleranceOverrides: { ...DEFAULT_TDS_TOLERANCE_OVERRIDES },
  });
}

describe('<TdsConfigPanel />', () => {
  beforeEach(() => {
    resetUi();
  });

  afterEach(() => {
    resetUi();
  });

  it('renders defaults from useUiStore: tf=10, h blank, vars=[bus_v], max_rate_hz=30', () => {
    render(<TdsConfigPanel />);
    expect(screen.getByTestId('field-tds-config-tf')).toHaveValue('10');
    expect(screen.getByTestId('field-tds-config-h')).toHaveValue('');
    expect(screen.getByTestId('field-tds-config-max-rate')).toHaveValue('30');
    const vars = screen.getByTestId('tds-config-vars');
    expect(within(vars).getByTestId('tds-config-var-bus_v')).toBeChecked();
    expect(within(vars).getByTestId('tds-config-var-gen_state')).not.toBeChecked();
    expect(within(vars).getByTestId('tds-config-var-line_flow')).not.toBeChecked();
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
    const genStateBox = screen.getByTestId('tds-config-var-gen_state');
    await user.click(genStateBox);
    expect(useUiStore.getState().tdsConfig.vars).toEqual(['bus_v', 'gen_state']);
    await user.click(genStateBox);
    expect(useUiStore.getState().tdsConfig.vars).toEqual(['bus_v']);
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
    await user.click(screen.getByTestId('tds-config-var-bus_v'));
    expect(useUiStore.getState().tdsConfig.vars).toEqual([]);
    expect(screen.getByTestId('error-tds-config-vars')).toHaveTextContent(/at least one/i);
  });

  it('Reset button restores the defaults after editing', async () => {
    const user = userEvent.setup();
    render(<TdsConfigPanel />);
    const tfInput = screen.getByTestId('field-tds-config-tf');
    await user.clear(tfInput);
    await user.type(tfInput, '42');
    await user.click(screen.getByTestId('tds-config-var-gen_state'));
    expect(useUiStore.getState().tdsConfig.tf).toBe(42);
    expect(useUiStore.getState().tdsConfig.vars).toEqual(['bus_v', 'gen_state']);
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
});
