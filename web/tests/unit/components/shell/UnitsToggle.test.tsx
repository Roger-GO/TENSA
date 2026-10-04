/**
 * Tests for `<UnitsToggle />`: it shows the current display units, switches
 * between per unit and actual units, and always keeps one of them on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UnitsToggle } from '@/components/shell/UnitsToggle';
import { useUnitsStore } from '@/store/units';

beforeEach(() => {
  useUnitsStore.setState({ mode: 'pu' });
});

afterEach(() => {
  cleanup();
  useUnitsStore.setState({ mode: 'pu' });
});

describe('<UnitsToggle />', () => {
  it('shows per unit as pressed by default', () => {
    render(<UnitsToggle />);
    expect(screen.getByRole('group', { name: 'Display units' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Per unit' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Actual units' })).not.toBeChecked();
  });

  it('switches to actual units and back', async () => {
    const user = userEvent.setup();
    render(<UnitsToggle />);

    await user.click(screen.getByRole('radio', { name: 'Actual units' }));
    expect(useUnitsStore.getState().mode).toBe('actual');
    expect(screen.getByRole('radio', { name: 'Actual units' })).toBeChecked();

    await user.click(screen.getByRole('radio', { name: 'Per unit' }));
    expect(useUnitsStore.getState().mode).toBe('pu');
  });

  it('keeps the mode when the pressed item is clicked again', async () => {
    const user = userEvent.setup();
    useUnitsStore.setState({ mode: 'actual' });
    render(<UnitsToggle />);

    await user.click(screen.getByRole('radio', { name: 'Actual units' }));
    expect(useUnitsStore.getState().mode).toBe('actual');
    expect(screen.getByRole('radio', { name: 'Actual units' })).toBeChecked();
  });

  it('says what each choice does', () => {
    render(<UnitsToggle />);
    expect(screen.getByRole('radio', { name: 'Per unit' })).toHaveAttribute(
      'title',
      expect.stringContaining('pu'),
    );
    expect(screen.getByRole('radio', { name: 'Actual units' })).toHaveAttribute(
      'title',
      expect.stringMatching(/kV.*Hz/),
    );
  });
});
