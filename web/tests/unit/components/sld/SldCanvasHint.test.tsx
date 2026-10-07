/**
 * The line above the diagram: what can be done on it, or what stands in the
 * way (the lock, a diagram too small to read), and the button that zooms a
 * diagram that is too small to full size.
 *
 * `useStore` needs a React Flow provider, so the module is stubbed the way the
 * node tests do; it runs its selector against a zoom the test sets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const view = vi.hoisted(() => ({ zoom: 1 }));

vi.mock('@xyflow/react', () => ({
  useStore: (selector: (s: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, view.zoom] }),
}));

import { SldCanvasHint } from '@/components/sld/SldCanvasHint';

beforeEach(() => {
  view.zoom = 1;
});

afterEach(() => {
  cleanup();
});

describe('<SldCanvasHint />', () => {
  it('says how the diagram is worked on while it can be read', () => {
    render(<SldCanvasHint locked={false} selectedName={null} onZoomIn={vi.fn()} />);
    expect(screen.getByTestId('sld-canvas-hint')).toHaveTextContent(
      'Drag a bus or device to move it, or click it and press the arrow keys.',
    );
    expect(screen.queryByTestId('sld-canvas-too-small')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says that a line can be moved by hand, which nothing on the diagram shows', () => {
    render(<SldCanvasHint locked={false} selectedName={null} onZoomIn={vi.fn()} />);
    expect(screen.getByTestId('sld-canvas-hint')).toHaveTextContent(
      'Click a line to move its route by hand.',
    );
  });

  it('leaves its place to the bar of a line that is picked, and hands over where that is', () => {
    const slot = vi.fn();
    const { rerender } = render(
      <SldCanvasHint locked={false} selectedName={null} onZoomIn={vi.fn()} routeBarSlot={slot} />,
    );
    const place = screen.getByTestId('sld-canvas-route-slot');
    expect(slot).toHaveBeenCalledWith(place);
    expect(screen.queryByTestId('sld-canvas-hint')).not.toBeInTheDocument();
    // The lock notice comes before it: nothing can be moved then.
    rerender(<SldCanvasHint locked selectedName={null} onZoomIn={vi.fn()} routeBarSlot={slot} />);
    expect(screen.getByTestId('sld-canvas-locked')).toBeInTheDocument();
    expect(screen.queryByTestId('sld-canvas-route-slot')).not.toBeInTheDocument();
  });

  it('says that the diagram is too small to read, at what zoom, and how to get closer', () => {
    view.zoom = 0.192876;
    render(<SldCanvasHint locked={false} selectedName={null} onZoomIn={vi.fn()} />);
    const notice = screen.getByTestId('sld-canvas-too-small');
    expect(notice).toHaveTextContent(
      'The diagram is zoomed out to 19%, too small to read. Press Zoom to 100%, zoom in by steps with the + button at the bottom left or the mouse wheel, or pick a bus or a device in a table below to zoom to it.',
    );
    expect(notice).toHaveAttribute('data-zoom-percent', '19');
    // Where the line is cut, the tooltip has the whole of it.
    expect(notice.getAttribute('title')).toBe(notice.textContent);
    expect(screen.queryByTestId('sld-canvas-hint')).not.toBeInTheDocument();
  });

  it('offers a button that zooms in, named for where it goes', () => {
    view.zoom = 0.3;
    const onZoomIn = vi.fn();
    const { rerender } = render(
      <SldCanvasHint locked={false} selectedName={null} onZoomIn={onZoomIn} />,
    );
    const button = screen.getByRole('button', { name: 'Zoom to 100%' });
    expect(button).toHaveAttribute('title', 'Show the middle of this view at full size (100%)');
    fireEvent.click(button);
    expect(onZoomIn).toHaveBeenCalledTimes(1);

    // With a bus or a device selected the button goes to it, and the line says so.
    rerender(<SldCanvasHint locked={false} selectedName="PQ_1" onZoomIn={onZoomIn} />);
    const toSelected = screen.getByRole('button', { name: 'Zoom to PQ_1' });
    expect(toSelected).toHaveAttribute('title', 'Show PQ_1 at full size (100%)');
    expect(screen.getByTestId('sld-canvas-too-small')).toHaveTextContent('Press Zoom to PQ_1,');
    fireEvent.click(toSelected);
    expect(onZoomIn).toHaveBeenCalledTimes(2);
  });

  it('says that the diagram is locked, which comes before anything else', () => {
    render(<SldCanvasHint locked selectedName={null} onZoomIn={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('The diagram is locked.');
    expect(screen.queryByTestId('sld-canvas-hint')).not.toBeInTheDocument();
  });

  it('keeps the zoom button beside the lock notice: the lock does not stop the zoom', () => {
    view.zoom = 0.2;
    render(<SldCanvasHint locked selectedName={null} onZoomIn={vi.fn()} />);
    expect(screen.getByTestId('sld-canvas-locked')).toBeInTheDocument();
    expect(screen.queryByTestId('sld-canvas-too-small')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoom to 100%' })).toBeInTheDocument();
  });
});
