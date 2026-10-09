/**
 * The line above the diagram: what can be done on it, or what stands in the
 * way (the lock, a diagram too small to read), and the button that zooms a
 * diagram that is too small to full size.
 *
 * `useStore` needs a React Flow provider, so the module is stubbed the way the
 * node tests do; it runs its selector against a zoom the test sets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
  /** Open the whole of what the line says, and answer the list it shows. */
  async function more(): Promise<HTMLElement> {
    await userEvent.setup().click(screen.getByRole('button', { name: /^Show/ }));
    return await screen.findByTestId('sld-canvas-hint-full');
  }

  it('says in one sentence how the diagram is worked on, with the rest one press away', () => {
    render(<SldCanvasHint locked={false} selectedName={null} onZoomIn={vi.fn()} />);
    // Short enough to be read whole: the first-load hint was a wall of text,
    // cut off after two lines.
    expect(screen.getByTestId('sld-canvas-hint')).toHaveTextContent(
      /^Drag a bus or device to move it\. Right-click a bus, a line or the background for more actions\.$/,
    );
    expect(screen.queryByTestId('sld-canvas-too-small')).not.toBeInTheDocument();
    // The one button is the way to the rest of it.
    expect(
      screen.getByRole('button', { name: 'Show everything that can be done on the diagram' }),
    ).toHaveTextContent('More');
  });

  it('lists everything the diagram answers to behind More, a line for each', async () => {
    render(<SldCanvasHint locked={false} selectedName={null} onZoomIn={vi.fn()} />);
    const list = await more();
    const lines = within(list)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(lines).toContain(
      'Drag a bus or device to move it, or click it and press the arrow keys.',
    );
    // That a line can be moved by hand, which nothing on the diagram shows,
    // and how to pick one without aiming at a line a pixel or two wide.
    expect(lines.join(' ')).toContain(
      'Click a line or a device connector to move its route by hand: drag a run sideways, or pick it and press Shift+arrow. A line can also be picked by its row in the Lines table.',
    );
    // How a component is connected to a bus and how a line is drawn.
    expect(lines.join(' ')).toContain(
      'Drop a device from the Components tab on the bar or the name of a bus to connect it there. Draw line (top left) joins two buses.',
    );
    // Undo is named the way every notice names it.
    expect(lines).toContain('Undo (Ctrl+Z or Edit > Undo) takes a move back.');
  });

  it('says how the selected device is moved to another bus, while it can be', () => {
    const { rerender } = render(
      <SldCanvasHint locked={false} selectedName="PQ_3" onZoomIn={vi.fn()} movable="load PQ_3" />,
    );
    const hint = screen.getByTestId('sld-canvas-hint');
    expect(hint).toHaveAttribute('data-hint', 'movable');
    expect(hint).toHaveTextContent(
      'Load PQ_3 is selected. To move it to another bus, drag the ring where its connector meets the bar onto that bus, or click the ring and then the bus.',
    );
    // The way by the keys, which was in the name of the ring alone.
    expect(hint).toHaveTextContent(
      'By the keyboard: Tab to the ring, press Enter, Tab to the bus and press Enter.',
    );
    // Undo in the words the notice of the move uses.
    expect(hint).toHaveTextContent('Undo (Ctrl+Z or Edit > Undo) takes the move back.');
    // The whole of it where two lines cut it.
    expect(hint.title).toMatch(/press the arrow keys\.$/);
    // While it cannot be moved, the line says why: the ring on its bar is greyed out.
    rerender(
      <SldCanvasHint
        locked={false}
        selectedName="PQ_3"
        onZoomIn={vi.fn()}
        movable="load PQ_3"
        movableBlocked="A run has fixed the system."
      />,
    );
    const blocked = screen.getByTestId('sld-canvas-hint');
    expect(blocked).toHaveAttribute('data-hint', 'immovable');
    expect(blocked).toHaveTextContent(
      'Load PQ_3 is selected. It cannot be moved to another bus now, which is why the ring on its bar is greyed out. A run has fixed the system.',
    );
    // The lock comes first, as before anything else.
    rerender(<SldCanvasHint locked selectedName="PQ_3" onZoomIn={vi.fn()} movable="load PQ_3" />);
    expect(screen.queryByTestId('sld-canvas-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('sld-canvas-locked')).toBeInTheDocument();
  });

  it('says how a picked draft that is on no bus yet is connected to one', () => {
    render(
      <SldCanvasHint
        locked={false}
        selectedName={null}
        onZoomIn={vi.fn()}
        connectable="draft PQ load PQ_12"
      />,
    );
    const hint = screen.getByTestId('sld-canvas-hint');
    expect(hint).toHaveAttribute('data-hint', 'connectable');
    // That it is on no bus is said first: it stands near one and looks connected.
    expect(hint).toHaveTextContent(
      'Draft PQ load PQ_12 is selected and is on no bus yet. To connect it, drag it onto the bar of a bus (the bar is marked while the draft lies on it), or pick the bus in its form in the Inspector.',
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
    expect(button).toHaveAttribute('title', 'Show the middle of the diagram at full size (100%)');
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
