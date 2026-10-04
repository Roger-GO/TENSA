/**
 * VoltageMarker: the triangle that marks a bus voltage near or past a limit
 * without colour. It points up for the upper limit and down for the lower,
 * and is filled beyond the limit and empty near it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { VoltageMarker } from '@/components/sld/VoltageMarker';

afterEach(cleanup);

function polygon(container: HTMLElement): SVGPolygonElement {
  const el = container.querySelector('polygon');
  if (!el) throw new Error('no polygon drawn');
  return el;
}

describe('VoltageMarker', () => {
  it('draws nothing for a bus in the clear or with no reading', () => {
    for (const band of ['success', 'neutral'] as const) {
      const { container } = render(<VoltageMarker band={band} side={null} />);
      expect(container.firstChild).toBeNull();
      cleanup();
    }
  });

  it('draws nothing when there is no side to point at', () => {
    const { container } = render(<VoltageMarker band="danger" side={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('points up at the upper limit and down at the lower one', () => {
    const high = render(<VoltageMarker band="danger" side="high" />);
    const upPoints = polygon(high.container).getAttribute('points');
    high.unmount();
    const low = render(<VoltageMarker band="danger" side="low" />);
    const downPoints = polygon(low.container).getAttribute('points');
    expect(upPoints).toBe('5,1 9.2,9 0.8,9');
    expect(downPoints).toBe('5,9 9.2,1 0.8,1');
  });

  it('fills the triangle beyond a limit and leaves it empty near one', () => {
    const beyond = render(<VoltageMarker band="danger" side="high" />);
    expect(polygon(beyond.container).getAttribute('class')).toContain('fill-danger');
    beyond.unmount();
    const near = render(<VoltageMarker band="warning" side="high" />);
    expect(polygon(near.container).getAttribute('class')).toContain('fill-transparent');
    // Both keep the dark outline, the part that has to read on the canvas.
    expect(polygon(near.container).getAttribute('class')).toContain('stroke-foreground');
  });

  it('names itself for assistive technology and the hover tooltip', () => {
    const { getByRole, container } = render(
      <VoltageMarker band="warning" side="low" data-testid="m" />,
    );
    const marker = getByRole('img', { name: 'Voltage near its lower limit' });
    expect(marker).toHaveAttribute('data-testid', 'm');
    expect(container.querySelector('title')).toHaveTextContent('Voltage near its lower limit');
  });
});
