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
    // The connector of a device as well, which has no row in a table, and
    // how to pick a line without aiming at one a pixel or two wide.
    expect(screen.getByTestId('sld-canvas-hint')).toHaveTextContent(
      'Click a line or a device connector to move its route by hand; a line can also be picked by its row in the Lines table.',
    );
  });

  it('says how a component is connected to a bus and how a line is drawn', () => {
    render(<SldCanvasHint locked={false} selectedName={null} onZoomIn={vi.fn()} />);
    expect(screen.getByTestId('sld-canvas-hint')).toHaveTextContent(
      'Drop a component from the Components tab on a bus to connect it there; Draw line (top left) joins two buses.',
    );
  });

  it('says how the selected device is moved to another bus, while it can be', () => {
    const { rerender } = render(
      <SldCanvasHint locked={false} selectedName="PQ_3" onZoomIn={vi.fn()} movable="load PQ_3" />,
    );
    const hint = screen.getByTestId('sld-canvas-hint');
    expect(hint).toHaveAttribute('data-hint', 'movable');
    expect(hint).toHaveTextContent(
      'Load PQ_3 is selected. To move it to another bus, drag the ring where its connector meets the bar onto that bus, or click the ring and then the bus. Drag the symbol itself to move it on the diagram, or press the arrow keys.',
    );
    // The whole of it where two lines cut it.
    expect(hint.title).toMatch(/press the arrow keys\.$/);
    // While it cannot be moved, the line says why: the ring on its bar is greyed out.
    rerender(
      <SldCanvasHint
        locked={false}
        selectedName="PQ_3"
        onZoomIn={vi.fn()}
        movable="load PQ_3"
        movableBlocked="A run has locked the system."
      />,
    );
    const blocked = screen.getByTestId('sld-canvas-hint');
    expect(blocked).toHaveAttribute('data-hint', 'immovable');
    expect(blocked).toHaveTextContent(
      'Load PQ_3 is selected. It cannot be moved to another bus now, which is why the ring on its bar is greyed out. A run has locked the system.',
    );
    // The lock comes first, as before anything else.
    rerender(<SldCanvasHint locked selectedName="PQ_3" onZoomIn={vi.fn()} movable="load PQ_3" />);
    expect(screen.queryByTestId('sld-canvas-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('sld-canvas-locked')).toBeInTheDocument();
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

  it('keeps the bar of a picked line on a diagram too small to read, with the zoom button beside it', () => {
    view.zoom = 0.3;
    render(
      <SldCanvasHint
        locked={false}
        selectedName={null}
        onZoomIn={vi.fn()}
        routeBarSlot={vi.fn()}
      />,
    );
    // The bar is where a move of the line is answered: the notice gives way.
    expect(screen.getByTestId('sld-canvas-route-slot')).toBeInTheDocument();
    expect(screen.queryByTestId('sld-canvas-too-small')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoom to 100%' })).toBeInTheDocument();
  });

  it('says that the diagram is too small to read, at what zoom, and how to get closer', () => {
    view.zoom = 0.192876;
    render(<SldCanvasHint locked={false} selectedName={null} onZoomIn={vi.fn()} />);
    const notice = screen.getByTestId('sld-canvas-too-small');
    expect(notice).toHaveTextContent(
      'The diagram is zoomed out to 19%, too small to read. Press Zoom to 100%, zoom in by steps with the + button at the bottom left or the mouse wheel, or pick a bus, a device or a line in a table below to zoom to it.',
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
