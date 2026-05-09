/**
 * <RunLegendChip /> tests.
 *
 * Drives the real runs store; asserts on the rendered DOM + the
 * overlay-set toggle behaviour.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
    expect(screen.getByTestId('run-legend-chip-abcdef1234')).toHaveTextContent(
      'abcdef12 · tf=5s',
    );
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
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(chip.getAttribute('data-pinned')).toBe('true');
  });

  it('clicking adds an unpinned run to the overlay set', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    render(<RunLegendChip runId="r1" />);
    expect(useRunsStore.getState().overlayRunIds.has('r1')).toBe(false);
    await user.click(screen.getByTestId('run-legend-chip-r1'));
    expect(useRunsStore.getState().overlayRunIds.has('r1')).toBe(true);
  });

  it('clicking removes a pinned run from the overlay set', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    useRunsStore.getState().addOverlayRun('r1');
    render(<RunLegendChip runId="r1" />);
    await user.click(screen.getByTestId('run-legend-chip-r1'));
    expect(useRunsStore.getState().overlayRunIds.has('r1')).toBe(false);
  });

  it('forwards click to onToggle override + does NOT touch the store', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    const onToggle = vi.fn();
    render(<RunLegendChip runId="r1" onToggle={onToggle} />);
    await user.click(screen.getByTestId('run-legend-chip-r1'));
    expect(onToggle).toHaveBeenCalledWith('r1', true);
    // Store untouched: caller-controlled mode.
    expect(useRunsStore.getState().overlayRunIds.has('r1')).toBe(false);
  });

  it('renders a colour swatch styled from the runId hash', () => {
    seedRun('r1');
    render(<RunLegendChip runId="r1" />);
    const swatch = screen.getByTestId('run-legend-chip-swatch-r1');
    // The hash → HSL mapping isn't stable across implementations; just
    // assert the inline-style background is set to *some* hsl().
    const style = swatch.getAttribute('style') ?? '';
    expect(style).toMatch(/(hsl\(|repeating-linear-gradient)/);
  });

  it('pinned prop overrides store state', () => {
    seedRun('r1');
    // Store says NOT pinned.
    render(<RunLegendChip runId="r1" pinned />);
    const chip = screen.getByTestId('run-legend-chip-r1');
    // But explicit prop says pinned.
    expect(chip.getAttribute('aria-pressed')).toBe('true');
  });
});
