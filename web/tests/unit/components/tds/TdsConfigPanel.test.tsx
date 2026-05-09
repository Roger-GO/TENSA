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
import { DEFAULT_TDS_CONFIG, useUiStore } from '@/store/ui';

function resetUi() {
  useUiStore.setState({
    hideLabels: false,
    activeRightDockTopPanel: 'inspector',
    tdsConfig: { ...DEFAULT_TDS_CONFIG },
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
});
