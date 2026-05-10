/**
 * BoltedFaultWarning — show/hide on the 0.01 threshold; advisory copy
 * mentions both "xf >= 0.01" and "adaptive TDS" so the user has two
 * remediation paths to read.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  BoltedFaultWarning,
  BOLTED_FAULT_XF_THRESHOLD,
} from '@/components/disturbance/BoltedFaultWarning';

describe('<BoltedFaultWarning />', () => {
  it('renders the advisory when xf is below the threshold (0.001)', () => {
    render(<BoltedFaultWarning xf={0.001} />);
    const warning = screen.getByTestId('bolted-fault-warning');
    expect(warning).toBeInTheDocument();
    expect(warning).toHaveAttribute('role', 'alert');
    // Copy contract: must mention BOTH remediation paths so the user knows
    // how to unblock themselves.
    expect(warning.textContent).toMatch(/xf\s*≥\s*0\.01|xf\s*>=\s*0\.01/);
    expect(warning.textContent).toMatch(/adaptive TDS/i);
  });

  it('renders the advisory at the boundary value 0 (xf=0 is still bolted)', () => {
    render(<BoltedFaultWarning xf={0} />);
    expect(screen.queryByTestId('bolted-fault-warning')).toBeInTheDocument();
  });

  it('renders the advisory at the smallest divergence-prone value 0.0001', () => {
    render(<BoltedFaultWarning xf={0.0001} />);
    expect(screen.queryByTestId('bolted-fault-warning')).toBeInTheDocument();
  });

  it('hides the advisory at the threshold boundary (xf == 0.01)', () => {
    render(<BoltedFaultWarning xf={BOLTED_FAULT_XF_THRESHOLD} />);
    expect(screen.queryByTestId('bolted-fault-warning')).toBeNull();
  });

  it('hides the advisory at the empirical default xf=0.05 (happy-path UX)', () => {
    render(<BoltedFaultWarning xf={0.05} />);
    expect(screen.queryByTestId('bolted-fault-warning')).toBeNull();
  });

  it('hides the advisory at the inverter-safe xf=0.1', () => {
    render(<BoltedFaultWarning xf={0.1} />);
    expect(screen.queryByTestId('bolted-fault-warning')).toBeNull();
  });

  it('hides the advisory when xf is NaN (the field-level error already covers it)', () => {
    render(<BoltedFaultWarning xf={Number.NaN} />);
    expect(screen.queryByTestId('bolted-fault-warning')).toBeNull();
  });

  it('hides the advisory when xf is +Infinity (defensive — non-finite)', () => {
    render(<BoltedFaultWarning xf={Number.POSITIVE_INFINITY} />);
    expect(screen.queryByTestId('bolted-fault-warning')).toBeNull();
  });

  it('exports the threshold constant for cross-component reuse', () => {
    expect(BOLTED_FAULT_XF_THRESHOLD).toBe(0.01);
  });
});
