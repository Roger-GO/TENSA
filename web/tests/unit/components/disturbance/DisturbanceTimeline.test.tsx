/**
 * DisturbanceTimeline — marker positions, time-axis label, click-to-edit.
 *
 * jsdom doesn't measure layout, so the timeline falls back to a 600px
 * test-mode width (see DisturbanceTimeline.tsx). All position assertions
 * compute against that width.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DisturbanceTimeline } from '@/components/disturbance/DisturbanceTimeline';
import { blankFaultSpec, blankToggleSpec, blankAlterSpec } from '@/store/disturbance';
import type { DisturbanceLocal } from '@/store/disturbance';

const TEST_WIDTH = 600;
const GLYPH_HALF = 6;

function localFault(id: string, tf: number): DisturbanceLocal {
  return {
    id,
    spec: { ...blankFaultSpec(), bus_idx: '1', tf, tc: tf + 0.1 },
  };
}
function localToggle(id: string, t: number): DisturbanceLocal {
  return {
    id,
    spec: { ...blankToggleSpec(), dev_idx: '1', t },
  };
}
function localAlter(id: string, t: number): DisturbanceLocal {
  return {
    id,
    spec: { ...blankAlterSpec(), dev_idx: '1', src: 'p0', t },
  };
}

describe('<DisturbanceTimeline />', () => {
  it('renders 0 → tMax labels (default 10s)', () => {
    render(<DisturbanceTimeline disturbances={[]} />);
    expect(screen.getByText('0s')).toBeInTheDocument();
    expect(screen.getByTestId('disturbance-timeline-tmax').textContent).toContain('10');
  });

  it('places markers at the correct x for t=1, 2.5, 5 over a 10s axis', () => {
    const ds = [localFault('a', 1), localToggle('b', 2.5), localAlter('c', 5)];
    render(<DisturbanceTimeline disturbances={ds} tMax={10} />);
    const a = screen.getByTestId('disturbance-marker-a');
    const b = screen.getByTestId('disturbance-marker-b');
    const c = screen.getByTestId('disturbance-marker-c');

    // x = (t / tMax) * width  - GLYPH_HALF (left coord). Use parseFloat so
    // sub-pixel precision doesn't matter.
    expect(parseFloat((a as HTMLElement).style.left)).toBeCloseTo(
      (1 / 10) * TEST_WIDTH - GLYPH_HALF,
      1,
    );
    expect(parseFloat((b as HTMLElement).style.left)).toBeCloseTo(
      (2.5 / 10) * TEST_WIDTH - GLYPH_HALF,
      1,
    );
    expect(parseFloat((c as HTMLElement).style.left)).toBeCloseTo(
      (5 / 10) * TEST_WIDTH - GLYPH_HALF,
      1,
    );
  });

  it('stacks markers at the same time with a vertical offset', () => {
    const ds = [localFault('a', 1.0), localToggle('b', 1.0)];
    render(<DisturbanceTimeline disturbances={ds} tMax={10} />);
    const a = screen.getByTestId('disturbance-marker-a');
    const b = screen.getByTestId('disturbance-marker-b');
    // Same x, different y: a (first inserted) at bottom 0, b stacked above.
    expect(parseFloat((a as HTMLElement).style.left)).toBeCloseTo(
      (1 / 10) * TEST_WIDTH - GLYPH_HALF,
      1,
    );
    expect(parseFloat((b as HTMLElement).style.left)).toBeCloseTo(
      (1 / 10) * TEST_WIDTH - GLYPH_HALF,
      1,
    );
    expect(parseFloat((a as HTMLElement).style.bottom)).toBe(0);
    expect(parseFloat((b as HTMLElement).style.bottom)).toBeGreaterThan(0);
  });

  it('extends the axis when a disturbance lives past tMax', () => {
    const ds = [localFault('past', 15)];
    render(<DisturbanceTimeline disturbances={ds} tMax={10} />);
    const axis = screen.getByTestId('disturbance-timeline');
    const eff = parseFloat(axis.getAttribute('data-effective-tmax') ?? '0');
    expect(eff).toBeGreaterThanOrEqual(15);
  });

  it('fires onMarkerClick with the marker id when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const ds = [localFault('xyz', 1.0)];
    render(
      <DisturbanceTimeline disturbances={ds} tMax={10} onMarkerClick={onClick} />,
    );
    await user.click(screen.getByTestId('disturbance-marker-xyz'));
    expect(onClick).toHaveBeenCalledWith('xyz');
  });
});
