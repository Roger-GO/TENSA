/**
 * <RunLegendChip /> tests.
 *
 * Drives the real runs store; asserts on the rendered DOM + the
 * overlay-set toggle behaviour. Unit 20 extends this with rename +
 * swatch-picker scenarios.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { RunLegendChip } from '@/components/plots/RunLegendChip';
import { useRunsStore } from '@/store/runs';

function seedRun(runId: string) {
  useRunsStore.getState().startRun({ runId, tf: 5, columnNames: [] });
}

describe('RunLegendChip', () => {
  beforeEach(() => {
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      overlayRunIds: new Set(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the run id prefix + tf label by default', () => {
    seedRun('abcdef1234');
    render(<RunLegendChip runId="abcdef1234" />);
    expect(screen.getByTestId('run-legend-chip-abcdef1234')).toHaveTextContent('abcdef12 · tf=5s');
  });

  it('respects an explicit label override', () => {
    seedRun('r1');
    render(<RunLegendChip runId="r1" label="Custom" />);
    expect(screen.getByTestId('run-legend-chip-r1')).toHaveTextContent('Custom');
  });

  it('reflects the pinned state via aria-pressed and data attribute', () => {
    seedRun('r1');
    useRunsStore.getState().addOverlayRun('r1');
    render(<RunLegendChip runId="r1" />);
    const chip = screen.getByTestId('run-legend-chip-r1');
    expect(chip.getAttribute('data-pinned')).toBe('true');
    // The toggle target is the inner name button — that's where
    // aria-pressed lives now (the chip wrapper is a non-interactive
    // span hosting the swatch + name + popover side-by-side).
    expect(screen.getByTestId('run-legend-name-r1').getAttribute('aria-pressed')).toBe('true');
  });

  it('clicking the name button adds an unpinned run to the overlay set', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    render(<RunLegendChip runId="r1" />);
    expect(useRunsStore.getState().overlayRunIds.has('r1')).toBe(false);
    await user.click(screen.getByTestId('run-legend-name-r1'));
    expect(useRunsStore.getState().overlayRunIds.has('r1')).toBe(true);
  });

  it('clicking the name button removes a pinned run from the overlay set', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    useRunsStore.getState().addOverlayRun('r1');
    render(<RunLegendChip runId="r1" />);
    await user.click(screen.getByTestId('run-legend-name-r1'));
    expect(useRunsStore.getState().overlayRunIds.has('r1')).toBe(false);
  });

  it('forwards click to onToggle override + does NOT touch the store', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    const onToggle = vi.fn();
    render(<RunLegendChip runId="r1" onToggle={onToggle} />);
    await user.click(screen.getByTestId('run-legend-name-r1'));
    expect(onToggle).toHaveBeenCalledWith('r1', true);
    // Store untouched: caller-controlled mode.
    expect(useRunsStore.getState().overlayRunIds.has('r1')).toBe(false);
  });

  it('renders a colour swatch styled from the runId hash', () => {
    seedRun('r1');
    render(<RunLegendChip runId="r1" />);
    const swatch = screen.getByTestId('run-legend-swatch-r1');
    // The hash → HSL mapping isn't stable across implementations; just
    // assert the inline-style background is set to *some* hsl()
    // (or a dash-pattern repeating-linear-gradient).
    const style = swatch.getAttribute('style') ?? '';
    expect(style).toMatch(/(hsl\(|repeating-linear-gradient)/);
  });

  it('pinned prop overrides store state', () => {
    seedRun('r1');
    // Store says NOT pinned.
    render(<RunLegendChip runId="r1" pinned />);
    // But explicit prop says pinned.
    expect(screen.getByTestId('run-legend-name-r1').getAttribute('aria-pressed')).toBe('true');
  });
});

/**
 * Unit 20: per-run rename via inline input.
 */
describe('RunLegendChip — inline rename (Unit 20)', () => {
  beforeEach(() => {
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      overlayRunIds: new Set(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('double-click swaps the name to an editable input + autofocuses', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    render(<RunLegendChip runId="r1" />);
    await user.dblClick(screen.getByTestId('run-legend-name-r1'));
    const input = screen.getByTestId('run-legend-name-input-r1');
    expect(input).toBeInTheDocument();
    // Autofocus check: the input is the active element.
    expect(document.activeElement).toBe(input);
  });

  it('Enter commits the new name to the runs store', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    render(<RunLegendChip runId="r1" />);
    await user.dblClick(screen.getByTestId('run-legend-name-r1'));
    const input = screen.getByTestId('run-legend-name-input-r1');
    await user.clear(input);
    await user.type(input, 'Fault @ tc=0.1{Enter}');
    expect(useRunsStore.getState().runs.r1!.displayName).toBe('Fault @ tc=0.1');
    // Input is gone; chip displays the new name.
    expect(screen.queryByTestId('run-legend-name-input-r1')).toBeNull();
    expect(screen.getByTestId('run-legend-chip-r1')).toHaveTextContent('Fault @ tc=0.1');
  });

  it('Escape cancels the rename and discards the typed value', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    render(<RunLegendChip runId="r1" />);
    await user.dblClick(screen.getByTestId('run-legend-name-r1'));
    const input = screen.getByTestId('run-legend-name-input-r1');
    await user.type(input, 'discarded{Escape}');
    expect(useRunsStore.getState().runs.r1!.displayName).toBeUndefined();
    expect(screen.queryByTestId('run-legend-name-input-r1')).toBeNull();
  });

  it('blurring the input commits the typed value', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    render(
      <>
        <RunLegendChip runId="r1" />
        <button type="button" data-testid="bystander">
          elsewhere
        </button>
      </>,
    );
    await user.dblClick(screen.getByTestId('run-legend-name-r1'));
    const input = screen.getByTestId('run-legend-name-input-r1');
    await user.clear(input);
    await user.type(input, 'committed-on-blur');
    // Click outside the input → blur fires → commit.
    await user.click(screen.getByTestId('bystander'));
    expect(useRunsStore.getState().runs.r1!.displayName).toBe('committed-on-blur');
  });

  it('empty value clears the displayName back to the default label', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    // Seed a previous custom name so there's something to clear.
    useRunsStore.getState().setRunDisplayName('r1', 'Old name');
    render(<RunLegendChip runId="r1" />);
    expect(screen.getByTestId('run-legend-chip-r1')).toHaveTextContent('Old name');
    await user.dblClick(screen.getByTestId('run-legend-name-r1'));
    const input = screen.getByTestId('run-legend-name-input-r1');
    await user.clear(input);
    await user.type(input, '{Enter}');
    expect(useRunsStore.getState().runs.r1!.displayName).toBeUndefined();
    // Chip falls back to the auto-generated default.
    expect(screen.getByTestId('run-legend-chip-r1')).toHaveTextContent('r1 · tf=5s');
  });
});

/**
 * Unit 20: swatch picker popover.
 */
describe('RunLegendChip — swatch picker (Unit 20)', () => {
  beforeEach(() => {
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      overlayRunIds: new Set(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('clicking the swatch opens the picker popover', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    render(<RunLegendChip runId="r1" />);
    expect(screen.queryByTestId('run-legend-swatch-picker-r1')).toBeNull();
    await user.click(screen.getByTestId('run-legend-swatch-r1'));
    expect(await screen.findByTestId('run-legend-swatch-picker-r1')).toBeInTheDocument();
  });

  it('selecting a preset swatch writes colorOverride + closes the popover', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    render(<RunLegendChip runId="r1" />);
    await user.click(screen.getByTestId('run-legend-swatch-r1'));
    const picker = await screen.findByTestId('run-legend-swatch-picker-r1');
    // Pick the first preset (the picker exposes one button per palette
    // slot; we just click the first one and assert the override is set).
    const options = within(picker).getAllByRole('button', {
      name: /Set run colour to/,
    });
    expect(options.length).toBeGreaterThan(0);
    await user.click(options[0]!);
    expect(useRunsStore.getState().runs.r1!.colorOverride).toBeDefined();
    expect(screen.queryByTestId('run-legend-swatch-picker-r1')).toBeNull();
  });

  it('"Reset to default" clears the override + closes the popover', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    useRunsStore.getState().setRunColorOverride('r1', '#ff0000');
    render(<RunLegendChip runId="r1" />);
    await user.click(screen.getByTestId('run-legend-swatch-r1'));
    await screen.findByTestId('run-legend-swatch-picker-r1');
    await user.click(screen.getByTestId('run-legend-swatch-reset-r1'));
    expect(useRunsStore.getState().runs.r1!.colorOverride).toBeUndefined();
    expect(screen.queryByTestId('run-legend-swatch-picker-r1')).toBeNull();
  });

  it('valid hex via the custom input commits the colour', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    render(<RunLegendChip runId="r1" />);
    await user.click(screen.getByTestId('run-legend-swatch-r1'));
    await screen.findByTestId('run-legend-swatch-picker-r1');
    const input = screen.getByTestId('run-legend-swatch-custom-input-r1');
    await user.type(input, '#3366ff');
    await user.click(screen.getByTestId('run-legend-swatch-custom-apply-r1'));
    expect(useRunsStore.getState().runs.r1!.colorOverride).toBe('#3366ff');
  });

  it('invalid hex shows an inline role="alert" error (NOT a toast)', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    render(<RunLegendChip runId="r1" />);
    await user.click(screen.getByTestId('run-legend-swatch-r1'));
    await screen.findByTestId('run-legend-swatch-picker-r1');
    const input = screen.getByTestId('run-legend-swatch-custom-input-r1');
    await user.type(input, 'notahex');
    await user.click(screen.getByTestId('run-legend-swatch-custom-apply-r1'));
    const error = screen.getByTestId('run-legend-swatch-custom-error-r1');
    expect(error).toBeInTheDocument();
    expect(error.getAttribute('role')).toBe('alert');
    // Override was NOT written.
    expect(useRunsStore.getState().runs.r1!.colorOverride).toBeUndefined();
    // Picker stays open so the user can correct the value.
    expect(screen.getByTestId('run-legend-swatch-picker-r1')).toBeInTheDocument();
  });

  it('Enter in the custom input applies the colour', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    render(<RunLegendChip runId="r1" />);
    await user.click(screen.getByTestId('run-legend-swatch-r1'));
    await screen.findByTestId('run-legend-swatch-picker-r1');
    const input = screen.getByTestId('run-legend-swatch-custom-input-r1');
    await user.type(input, '#abc{Enter}');
    expect(useRunsStore.getState().runs.r1!.colorOverride).toBe('#abc');
  });

  it('the chip swatch picks up the override colour', () => {
    seedRun('r1');
    useRunsStore.getState().setRunColorOverride('r1', '#ff00aa');
    render(<RunLegendChip runId="r1" />);
    const swatch = screen.getByTestId('run-legend-swatch-r1');
    const style = swatch.getAttribute('style') ?? '';
    // Either flat fill or repeating-linear-gradient with the colour.
    expect(style.toLowerCase()).toContain('#ff00aa');
  });
});
