/**
 * What connecting by a drag draws over the diagram (`SldWiring`), on its
 * own: the bus a drop would land on, the ring at the bar end of a
 * connector, the buses that are picked while a line is drawn or a device is
 * moved, and what each press, drag and key hands to the canvas. The canvas
 * that acts on it is `SldCanvasWiring`.
 *
 * Three bars stand one under the other, 100 apart; the diagram is drawn at
 * full size from the corner of the window, so a pointer at `(x, y)` is at
 * `(x, y)` on the diagram.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@xyflow/react', () => ({
  useStore: (selector: (s: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, 1] }),
  useReactFlow: () => ({ screenToFlowPosition: (p: { x: number; y: number }) => p }),
}));

import { SldWiring, type WiringGrip } from '@/components/sld/SldWiring';
import type { BusBar, WiringMode } from '@/components/sld/wiring';

const BARS: BusBar[] = [
  { id: '1', name: 'BUS1', box: { left: 0, right: 92, top: 0, bottom: 6 } },
  { id: '2', name: 'BUS2', box: { left: 0, right: 92, top: 100, bottom: 106 } },
  { id: '3', name: '3', box: { left: 0, right: 92, top: 200, bottom: 206 } },
];

const GRIP: WiringGrip = {
  nodeId: 'load-PQ_1',
  name: 'load PQ_1',
  at: [46, 3],
  bus: '1',
  blocked: null,
};

const onGrab = vi.fn();
const onBlocked = vi.fn();
const onFrom = vi.fn();
const onDraw = vi.fn();
const onMove = vi.fn();
const onCancel = vi.fn();

function draw(props: {
  mode?: WiringMode | null;
  target?: string | null;
  grip?: WiringGrip | null;
}) {
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  const element = (next: typeof props) => (
    <SldWiring
      mode={next.mode ?? null}
      bars={BARS}
      target={next.target ?? null}
      grip={next.grip ?? null}
      anchor={[46, -30]}
      onGrab={onGrab}
      onBlocked={onBlocked}
      onFrom={onFrom}
      onDraw={onDraw}
      onMove={onMove}
      onCancel={onCancel}
      barSlot={slot}
    />
  );
  const view = render(element(props));
  return { slot, again: (next: typeof props) => view.rerender(element(next)) };
}

const at = (x: number, y: number) => ({ button: 0, pointerId: 1, clientX: x, clientY: y });
const bus = (id: string) => screen.getByTestId(`sld-wire-bus-${id}`);

/** Press the handle `testId` at `from`, drag to `to` and let go. */
function drag(testId: string, from: [number, number], to: [number, number]): void {
  const handle = screen.getByTestId(testId);
  fireEvent.pointerDown(handle, at(from[0], from[1]));
  fireEvent.pointerMove(handle, at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2));
  fireEvent.pointerMove(handle, at(to[0], to[1]));
  fireEvent.pointerUp(handle, at(to[0], to[1]));
}

/** Press the handle `testId` and let go where it was pressed. */
function press(testId: string, where: [number, number]): void {
  const handle = screen.getByTestId(testId);
  fireEvent.pointerDown(handle, at(where[0], where[1]));
  fireEvent.pointerUp(handle, at(where[0], where[1]));
}

const hadPointerEvent = 'PointerEvent' in window;

beforeEach(() => {
  // jsdom has no `PointerEvent`: a press would arrive without its button or its place.
  if (!hadPointerEvent) {
    class PointerEventStandIn extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    vi.stubGlobal('PointerEvent', PointerEventStandIn);
  }
  for (const spy of [onGrab, onBlocked, onFrom, onDraw, onMove, onCancel]) spy.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('with nothing being connected', () => {
  it('draws no bus to pick, no line and no bar', () => {
    const { slot } = draw({});
    expect(screen.queryByTestId('sld-wire-bus-1')).toBeNull();
    expect(screen.queryByTestId('sld-wire-band')).toBeNull();
    expect(screen.queryByTestId('sld-wire-target')).toBeNull();
    expect(screen.queryByTestId('sld-wire-grip')).toBeNull();
    expect(slot).toBeEmptyDOMElement();
    // Left out of a PNG of the view.
    expect(screen.getByTestId('sld-wiring')).toHaveAttribute('data-export-ignore');
  });

  it('marks the bus that something dragged over the diagram would be connected to', () => {
    const { again } = draw({ target: '2' });
    const marked = screen.getByTestId('sld-wire-target');
    expect(marked).toHaveAttribute('data-bus', '2');
    // Around the bar of that bus.
    expect(Number(marked.getAttribute('y'))).toBeLessThan(100);
    expect(
      Number(marked.getAttribute('y')) + Number(marked.getAttribute('height')),
    ).toBeGreaterThan(106);
    again({ target: null });
    expect(screen.queryByTestId('sld-wire-target')).toBeNull();
  });
});

describe('the ring at the bar end of a connector', () => {
  it('is a button on the tap that says what a drag of it does', () => {
    draw({ grip: GRIP });
    const ring = screen.getByTestId('sld-wire-grip');
    expect(ring).toHaveAttribute('role', 'button');
    expect(ring).toHaveAttribute('tabindex', '0');
    expect(ring).toHaveAttribute('data-bus', '1');
    expect(ring).toHaveAccessibleName(
      'Move load PQ_1 to another bus: drag this end of its connector onto the bus, or press Enter and then pick the bus',
    );
    const [outer] = ring.querySelectorAll('circle');
    expect(outer).toHaveAttribute('cx', '46');
    expect(outer).toHaveAttribute('cy', '3');
  });

  it('moves its device to the bus it is dragged onto', () => {
    draw({ grip: GRIP });
    drag('sld-wire-grip', [46, 3], [50, 108]);
    expect(onGrab).toHaveBeenCalledWith('load-PQ_1');
    expect(onMove).toHaveBeenCalledExactlyOnceWith('load-PQ_1', '2');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('takes a drop beside a bar, within reach of it, for that bus', () => {
    draw({ grip: GRIP });
    drag('sld-wire-grip', [46, 3], [100, 212]);
    expect(onMove).toHaveBeenCalledExactlyOnceWith('load-PQ_1', '3');
  });

  it('leaves the device where it is when the ring is let go on no bus, or on its own', () => {
    draw({ grip: GRIP });
    drag('sld-wire-grip', [46, 3], [300, 50]);
    expect(onMove).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    drag('sld-wire-grip', [46, 3], [80, 4]);
    expect(onMove).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('asks for the bus to be picked when it is pressed and let go, or on Enter', () => {
    draw({ grip: GRIP });
    press('sld-wire-grip', [46, 3]);
    expect(onGrab).toHaveBeenCalledExactlyOnceWith('load-PQ_1');
    expect(onMove).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId('sld-wire-grip'), { key: 'Enter' });
    expect(onGrab).toHaveBeenCalledTimes(2);
  });

  it('says why it does nothing while its device cannot be moved', () => {
    const reason = 'A run has locked the system.';
    draw({ grip: { ...GRIP, blocked: reason } });
    const ring = screen.getByTestId('sld-wire-grip');
    expect(ring).toHaveAttribute('aria-disabled', 'true');
    expect(ring).toHaveAccessibleName(`Move load PQ_1 to another bus: not now. ${reason}`);
    drag('sld-wire-grip', [46, 3], [50, 108]);
    fireEvent.keyDown(ring, { key: 'Enter' });
    expect(onBlocked).toHaveBeenCalledTimes(2);
    expect(onBlocked).toHaveBeenCalledWith(reason);
    expect(onGrab).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
  });
});

describe('a line that is drawn', () => {
  const START: WiringMode = { kind: 'draw', model: 'Line', from: null };

  it('offers every bus as a named button, and says what to do in the row above the diagram', () => {
    const { slot } = draw({ mode: START });
    expect(bus('1')).toHaveAccessibleName('Start the line at bus 1 (BUS1)');
    expect(bus('3')).toHaveAccessibleName('Start the line at bus 3');
    for (const id of ['1', '2', '3']) {
      expect(bus(id)).toHaveAttribute('role', 'button');
      expect(bus(id)).toHaveAttribute('tabindex', '0');
    }
    const bar = slot.querySelector('[data-testid="sld-wire-bar"]')!;
    expect(bar).toHaveAttribute('role', 'toolbar');
    expect(bar).toHaveAccessibleName('Draw a line');
    expect(screen.getByTestId('sld-wire-note')).toHaveTextContent(
      'Click the bus it starts from and then the bus it goes to, or drag from one to the other. Esc cancels.',
    );
    fireEvent.click(screen.getByTestId('sld-wire-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('is drawn by a drag from one bus to another', () => {
    const { again } = draw({ mode: START });
    const handle = bus('1');
    fireEvent.pointerDown(handle, at(40, 3));
    expect(onFrom).toHaveBeenCalledExactlyOnceWith('1');
    // The canvas keeps where it starts.
    again({ mode: { ...START, from: '1' } });
    fireEvent.pointerMove(handle, at(45, 60));
    fireEvent.pointerMove(handle, at(50, 104));
    // The line follows the pointer from the bar it starts on, and the bus under it is marked.
    expect(screen.getByTestId('sld-wire-band')).toHaveAttribute('d', 'M50,3 L50,103');
    expect(screen.getByTestId('sld-wire-target')).toHaveAttribute('data-bus', '2');
    fireEvent.pointerUp(handle, at(50, 104));
    expect(onDraw).toHaveBeenCalledExactlyOnceWith('1', '2');
  });

  it('is drawn by a click on one bus and then on another', () => {
    const { again } = draw({ mode: START });
    press('sld-wire-bus-2', [40, 103]);
    expect(onFrom).toHaveBeenCalledExactlyOnceWith('2');
    expect(onDraw).not.toHaveBeenCalled();
    again({ mode: { ...START, from: '2' } });
    expect(bus('2')).toHaveAccessibleName('The line starts at bus 2 (BUS2)');
    expect(bus('3')).toHaveAccessibleName('End the line at bus 3');
    expect(screen.getByTestId('sld-wire-note')).toHaveTextContent(
      'From bus 2 (BUS2): now click the bus it goes to. Esc cancels.',
    );
    press('sld-wire-bus-3', [40, 203]);
    expect(onDraw).toHaveBeenCalledExactlyOnceWith('2', '3');
  });

  it('is drawn with the keys: Enter on the bus it starts from, and on the bus it goes to', () => {
    const { again } = draw({ mode: { kind: 'draw', model: 'Transformer2W', from: null } });
    expect(bus('1')).toHaveAccessibleName('Start the transformer at bus 1 (BUS1)');
    fireEvent.keyDown(bus('1'), { key: 'Enter' });
    expect(onFrom).toHaveBeenCalledExactlyOnceWith('1');
    again({ mode: { kind: 'draw', model: 'Transformer2W', from: '1' } });
    fireEvent.keyDown(bus('3'), { key: ' ' });
    expect(onDraw).toHaveBeenCalledExactlyOnceWith('1', '3');
  });

  it('does not end on the bus it starts from, and says so', () => {
    draw({ mode: { ...START, from: '2' } });
    press('sld-wire-bus-2', [40, 103]);
    expect(onDraw).not.toHaveBeenCalled();
    const note = screen.getByTestId('sld-wire-note');
    expect(note).toHaveAttribute('data-tone', 'refused');
    expect(note).toHaveTextContent(
      'A line runs between two buses: click another bus than bus 2 (BUS2).',
    );
  });

  it('keeps where it starts when a drag is let go on no bus, and says what to do', () => {
    const { again } = draw({ mode: START });
    const handle = bus('1');
    fireEvent.pointerDown(handle, at(40, 3));
    again({ mode: { ...START, from: '1' } });
    fireEvent.pointerMove(handle, at(300, 50));
    fireEvent.pointerUp(handle, at(300, 50));
    expect(onDraw).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByTestId('sld-wire-note')).toHaveTextContent(
      /It still starts at bus 1 \(BUS1\): click the bus it goes to\./,
    );
  });

  it('follows the pointer over the page between the two clicks', () => {
    draw({ mode: { ...START, from: '1' } });
    expect(screen.queryByTestId('sld-wire-band')).toBeNull();
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 200, clientY: 150 }));
    });
    expect(screen.getByTestId('sld-wire-band')).toHaveAttribute('d', 'M92,3 L200,150');
    expect(screen.queryByTestId('sld-wire-target')).toBeNull();
  });

  it('draws no ring while a line is drawn: the buses are for the line', () => {
    draw({ mode: START, grip: null });
    expect(screen.queryByTestId('sld-wire-grip')).toBeNull();
  });
});

describe('a device that is moved to another bus', () => {
  const MOVE: WiringMode = { kind: 'move', nodeId: 'load-PQ_1', name: 'load PQ_1', bus: '1' };

  it('names every bus by what a press on it does', () => {
    const { slot } = draw({ mode: MOVE, grip: GRIP });
    expect(bus('1')).toHaveAccessibleName('Load PQ_1 is on bus 1 (BUS1)');
    expect(bus('2')).toHaveAccessibleName('Move load PQ_1 to bus 2 (BUS2)');
    expect(slot.querySelector('[data-testid="sld-wire-bar"]')).toHaveAccessibleName(
      'Move load PQ_1 to another bus',
    );
    expect(screen.getByTestId('sld-wire-note')).toHaveTextContent(
      /^It is on bus 1 \(BUS1\)\. Click the bus to move it to/,
    );
  });

  it('goes to the bus that is clicked, and not to the one it is on', () => {
    draw({ mode: MOVE, grip: GRIP });
    press('sld-wire-bus-1', [40, 3]);
    expect(onMove).not.toHaveBeenCalled();
    expect(screen.getByTestId('sld-wire-note')).toHaveTextContent(
      'Load PQ_1 is on bus 1 (BUS1) already: click another bus.',
    );
    press('sld-wire-bus-3', [40, 203]);
    expect(onMove).toHaveBeenCalledExactlyOnceWith('load-PQ_1', '3');
  });

  it('draws the line from where its connector leaves it to the pointer', () => {
    draw({ mode: MOVE, grip: GRIP });
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, clientY: 104 }));
    });
    // Onto the bar of the bus under the pointer.
    expect(screen.getByTestId('sld-wire-band')).toHaveAttribute('d', 'M46,-30 L40,103');
    expect(screen.getByTestId('sld-wire-target')).toHaveAttribute('data-bus', '2');
  });

  it('asks a draft that is on no bus which bus to connect it to', () => {
    draw({ mode: { kind: 'move', nodeId: 'draft-1', name: 'draft PQ load 3', bus: null } });
    expect(bus('2')).toHaveAccessibleName('Connect draft PQ load 3 to bus 2 (BUS2)');
    fireEvent.keyDown(bus('2'), { key: 'Enter' });
    expect(onMove).toHaveBeenCalledExactlyOnceWith('draft-1', '2');
  });
});
