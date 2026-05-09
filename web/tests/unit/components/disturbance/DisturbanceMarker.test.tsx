/**
 * DisturbanceMarker — kind-specific glyph + click handler.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DisturbanceMarker } from '@/components/disturbance/DisturbanceMarker';
import { blankFaultSpec, blankToggleSpec, blankAlterSpec } from '@/store/disturbance';

describe('<DisturbanceMarker />', () => {
  it('exposes the kind and t via data attributes for styling/queries', () => {
    render(
      <DisturbanceMarker
        disturbance={{
          id: 'm1',
          spec: { ...blankFaultSpec(), bus_idx: '1', tf: 1.5, tc: 1.6 },
        }}
        x={42}
      />,
    );
    const marker = screen.getByTestId('disturbance-marker-m1');
    expect(marker).toHaveAttribute('data-kind', 'fault');
    expect(marker).toHaveAttribute('data-t', '1.5');
  });

  it('renders different glyphs for fault, toggle, and alter', () => {
    const { rerender } = render(
      <DisturbanceMarker
        disturbance={{
          id: 'm1',
          spec: { ...blankFaultSpec(), bus_idx: '1', tf: 1, tc: 1.1 },
        }}
        x={10}
      />,
    );
    const faultMarker = screen.getByTestId('disturbance-marker-m1');
    expect(faultMarker.querySelector('circle')).not.toBeNull();

    rerender(
      <DisturbanceMarker
        disturbance={{
          id: 'm1',
          spec: { ...blankToggleSpec(), dev_idx: '1', t: 1 },
        }}
        x={10}
      />,
    );
    const toggleMarker = screen.getByTestId('disturbance-marker-m1');
    // Toggle = 4-point diamond polygon.
    const togglePoly = toggleMarker.querySelector('polygon');
    expect(togglePoly).not.toBeNull();
    expect(togglePoly?.getAttribute('points')?.split(' ')).toHaveLength(4);

    rerender(
      <DisturbanceMarker
        disturbance={{
          id: 'm1',
          spec: { ...blankAlterSpec(), dev_idx: '1', src: 'p', t: 1 },
        }}
        x={10}
      />,
    );
    const alterMarker = screen.getByTestId('disturbance-marker-m1');
    // Alter = 3-point triangle polygon.
    const alterPoly = alterMarker.querySelector('polygon');
    expect(alterPoly).not.toBeNull();
    expect(alterPoly?.getAttribute('points')?.split(' ')).toHaveLength(3);
  });

  it('fires onClick with the disturbance id when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <DisturbanceMarker
        disturbance={{
          id: 'fire-me',
          spec: { ...blankFaultSpec(), bus_idx: '1', tf: 1, tc: 1.1 },
        }}
        x={50}
        onClick={onClick}
      />,
    );
    await user.click(screen.getByTestId('disturbance-marker-fire-me'));
    expect(onClick).toHaveBeenCalledWith('fire-me');
  });
});
