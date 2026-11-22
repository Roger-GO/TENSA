/**
 * <ExternalTraceChip />: the dashed swatch, the label, and the remove button
 * that takes the trace out of the store.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExternalTraceChip } from '@/components/plots/ExternalTraceChip';
import { useExternalOverlaysStore } from '@/store/externalOverlays';
import type { ExternalOverlayTrace } from '@/store/externalOverlays';

const TRACE: ExternalOverlayTrace = {
  id: 'tsat:column 1',
  source: 'tsat',
  name: 'column 1',
  label: 'tsat: column 1',
  t: Float64Array.of(0, 1),
  y: Float64Array.of(1, 2),
  axis: 'left',
};

describe('ExternalTraceChip', () => {
  beforeEach(() => {
    useExternalOverlaysStore.setState({ traces: [TRACE], dialogOpen: false });
  });

  afterEach(() => {
    cleanup();
    useExternalOverlaysStore.setState({ traces: [], dialogOpen: false });
  });

  it('shows the label and a dashed swatch in the trace colour', () => {
    render(<ExternalTraceChip trace={TRACE} color="oklch(0.55 0.20 28)" />);
    const chip = screen.getByTestId('external-trace-chip-tsat:column 1');
    expect(chip).toHaveTextContent('tsat: column 1');
    const swatch = chip.querySelector('span[aria-hidden="true"]')!;
    expect(swatch.getAttribute('style')).toContain('repeating-linear-gradient');
    expect(swatch.getAttribute('style')).toContain('oklch(0.55 0.2 28)');
  });

  it('removes its own trace from the store on its remove button, and no other', async () => {
    const user = userEvent.setup();
    const other: ExternalOverlayTrace = {
      ...TRACE,
      id: 'psse:column 2',
      source: 'psse',
      name: 'column 2',
      label: 'psse: column 2',
    };
    const after: ExternalOverlayTrace = { ...TRACE, id: 'tsat:column 3', label: 'tsat: column 3' };
    useExternalOverlaysStore.setState({ traces: [TRACE, other, after] });
    render(<ExternalTraceChip trace={other} color="red" />);

    await user.click(screen.getByTestId('external-trace-remove-psse:column 2'));

    expect(useExternalOverlaysStore.getState().traces.map((t) => t.id)).toEqual([
      'tsat:column 1',
      'tsat:column 3',
    ]);
  });

  it('names the remove button for the trace', () => {
    render(<ExternalTraceChip trace={TRACE} color="red" />);
    expect(screen.getByRole('button', { name: 'Remove tsat: column 1' })).toBe(
      screen.getByTestId('external-trace-remove-tsat:column 1'),
    );
  });
});
