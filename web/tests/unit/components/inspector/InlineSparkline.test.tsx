/**
 * Tests for ``<InlineSparkline />`` (v3 Unit 9).
 *
 * Covers the path-rendering math + the empty-input guards.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { InlineSparkline } from '@/components/inspector/InlineSparkline';

afterEach(() => {
  cleanup();
});

describe('<InlineSparkline />', () => {
  it('renders an SVG path when given >= 2 values', () => {
    render(<InlineSparkline values={[1, 1.02, 0.98, 1.05]} label="V" />);
    const path = screen.getByTestId('inline-sparkline-path');
    expect(path).toBeInTheDocument();
    const d = path.getAttribute('d');
    expect(d).toBeTruthy();
    // Starts with a Move command and contains Line commands for the
    // remaining samples.
    expect(d!.startsWith('M')).toBe(true);
    expect((d!.match(/L/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('renders no path for empty input', () => {
    render(<InlineSparkline values={[]} label="Empty" />);
    expect(screen.queryByTestId('inline-sparkline-path')).toBeNull();
    // The container SVG (img role) still renders.
    expect(screen.getByRole('img', { name: /empty sparkline/i })).toBeInTheDocument();
  });

  it('renders no path for a single value (degenerate)', () => {
    render(<InlineSparkline values={[1.024]} />);
    expect(screen.queryByTestId('inline-sparkline-path')).toBeNull();
  });

  it('shows the latest-value badge when label is set', () => {
    render(<InlineSparkline values={[1, 2, 3, 4.5]} label="P" />);
    const badge = screen.getByTestId('inline-sparkline-value');
    expect(badge.textContent).toContain('4.5');
  });

  it('honours the custom valueFormat', () => {
    render(
      <InlineSparkline
        values={[100, 200, 250]}
        label="P"
        valueFormat={(v) => `${v.toFixed(0)} MW`}
      />,
    );
    const badge = screen.getByTestId('inline-sparkline-value');
    expect(badge.textContent).toBe('250 MW');
  });

  it('handles a flat (zero-range) series without NaN coords', () => {
    render(<InlineSparkline values={[1, 1, 1, 1]} label="Flat" />);
    const path = screen.getByTestId('inline-sparkline-path');
    expect(path.getAttribute('d')).not.toContain('NaN');
  });
});
