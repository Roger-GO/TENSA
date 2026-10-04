/**
 * <PlotQuantityToggles />: the buttons above the plot that put bus voltage,
 * bus angle, generator speed and generator angle on it or take them off.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlotQuantityToggles } from '@/components/plots/PlotQuantityToggles';
import { usePlotStore } from '@/store/plot';
import { useRunsStore } from '@/store/runs';

function reset(): void {
  useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set<string>() });
  usePlotStore.setState({
    selectedByRun: {},
    filterByRun: {},
    expandedByRun: {},
    scrubByRun: {},
    playingByRun: {},
  });
}

function seedRun(columnNames: string[]): void {
  useRunsStore.getState().startRun({ runId: 'r1', tf: 10, columnNames });
}

const selected = () => [...(usePlotStore.getState().selectedByRun['r1'] ?? [])].sort();

beforeEach(reset);
afterEach(() => {
  cleanup();
  reset();
});

describe('<PlotQuantityToggles />', () => {
  it('renders nothing without a run', () => {
    const { container } = render(<PlotQuantityToggles />);
    expect(container).toBeEmptyDOMElement();
  });

  it('has a button for each of the four quantities the run recorded, in a named group', () => {
    seedRun(['Bus_1_v', 'Bus_1_a', 'Gen_1_omega', 'Gen_1_delta']);
    render(<PlotQuantityToggles />);
    const group = screen.getByRole('group', { name: 'Quantities to plot' });
    expect(Array.from(group.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      'Bus voltage',
      'Bus angle',
      'Generator speed',
      'Generator angle',
    ]);
  });

  it('leaves out a quantity the run did not record', () => {
    // A run that streamed bus voltages only (the TDS variable groups were narrowed).
    seedRun(['Bus_1_v']);
    render(<PlotQuantityToggles />);
    expect(screen.getByRole('button', { name: 'Bus voltage' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generator speed' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Generator angle' })).toBeNull();
  });

  it('shows which quantities are on the plot', () => {
    seedRun(['Bus_1_v', 'Bus_1_a', 'Gen_1_omega', 'Gen_1_delta']);
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Gen_1_delta']));
    render(<PlotQuantityToggles />);
    const pressed = (name: string) =>
      screen.getByRole('button', { name }).getAttribute('aria-pressed');
    expect(pressed('Bus voltage')).toBe('true');
    expect(pressed('Bus angle')).toBe('false');
    expect(pressed('Generator speed')).toBe('false');
    expect(pressed('Generator angle')).toBe('true');
  });

  it('puts the bus angle on the plot for the buses whose voltage is there, and takes it off again', async () => {
    const user = userEvent.setup();
    seedRun(['Bus_1_v', 'Bus_1_a', 'Bus_2_v', 'Bus_2_a']);
    usePlotStore.getState().setSelection('r1', new Set(['Bus_2_v']));
    render(<PlotQuantityToggles />);

    await user.click(screen.getByRole('button', { name: 'Bus angle' }));
    expect(selected()).toEqual(['Bus_2_a', 'Bus_2_v']);
    expect(screen.getByRole('button', { name: 'Bus angle' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Bus angle' }));
    expect(selected()).toEqual(['Bus_2_v']);
  });

  it('draws the generators with a click on a plot that had none, with no tree to open', async () => {
    const user = userEvent.setup();
    seedRun(['Bus_1_v', 'Gen_1_omega', 'Gen_1_delta', 'Gen_2_omega', 'Gen_2_delta']);
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));
    render(<PlotQuantityToggles />);

    await user.click(screen.getByRole('button', { name: 'Generator speed' }));
    await user.click(screen.getByRole('button', { name: 'Generator angle' }));

    // The angle follows the speed onto the same machines.
    expect(selected()).toEqual([
      'Bus_1_v',
      'Gen_1_delta',
      'Gen_1_omega',
      'Gen_2_delta',
      'Gen_2_omega',
    ]);
  });

  it('follows a selection made somewhere else, such as the variable tree', () => {
    seedRun(['Bus_1_v', 'Bus_1_a']);
    render(<PlotQuantityToggles />);
    expect(screen.getByRole('button', { name: 'Bus angle' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    act(() => usePlotStore.getState().toggleSeries('r1', 'Bus_1_a'));
    expect(screen.getByRole('button', { name: 'Bus angle' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('says when it starts with only some of the elements of a large case', () => {
    const buses = Array.from({ length: 20 }, (_, i) => `Bus_${i + 1}_v`);
    seedRun(buses);
    render(<PlotQuantityToggles />);
    expect(screen.getByRole('button', { name: 'Bus voltage' }).getAttribute('title')).toMatch(
      /first 12 of 20 buses/,
    );
  });
});
