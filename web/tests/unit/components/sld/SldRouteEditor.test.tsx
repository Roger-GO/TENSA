/**
 * The handles of a line that is moved by hand (`SldRouteEditor`), on their
 * own: what each gesture hands to the canvas as the new route, what is
 * drawn while a part is dragged to where it cannot stand, and what the bar
 * offers and says. The canvas that keeps the route is `SldCanvasRouteEdit`.
 *
 * The line is a branch that steps from a bar at the height 0 to one at the
 * height 200; the diagram is drawn at full size from the corner of the
 * window, so a pointer at `(x, y)` is at `(x, y)` on the diagram.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@xyflow/react', () => ({
  useStore: (selector: (s: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, 1] }),
  useReactFlow: () => ({ screenToFlowPosition: (p: { x: number; y: number }) => p }),
}));

import type { Point } from '@/components/sld/connections';
import { ROUTE_FOCUS_ATTR, type RouteEnds } from '@/components/sld/routeEdit';
import { ROUTE_EDIT_HINT, SldRouteEditor } from '@/components/sld/SldRouteEditor';

const ENDS: RouteEnds = {
  source: { kind: 'bar', y: 0, lo: 3, hi: 97 },
  target: { kind: 'bar', y: 200, lo: 153, hi: 247 },
};

const STEPPED: Point[] = [
  [50, 0],
  [50, 100],
  [200, 100],
  [200, 200],
];

/** Where a route is refused, for the tests that need a place that is. */
let shut: (points: readonly Point[]) => string | null = () => null;
const onCommit = vi.fn<(points: Point[], what: string, coalesce: string | null) => string | null>();
const onReset = vi.fn();
const onDone = vi.fn();

function draw(props: { points?: Point[]; manual?: boolean; grid?: number | null } = {}) {
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  const view = render(
    <SldRouteEditor
      edgeId="line-L1"
      name="line L1"
      points={props.points ?? STEPPED}
      manual={props.manual ?? false}
      ends={ENDS}
      makeCheck={() => (points) => shut(points)}
      grid={props.grid ?? null}
      onCommit={onCommit}
      onReset={onReset}
      onDone={onDone}
      barSlot={slot}
    />,
  );
  return { ...view, slot };
}

const at = (x: number, y: number, more: Record<string, unknown> = {}) => ({
  button: 0,
  pointerId: 1,
  clientX: x,
  clientY: y,
  ...more,
});

/** A drag of the handle `testId` from `from` by `by`. */
function drag(
  testId: string,
  from: [number, number],
  by: [number, number],
  more: Record<string, unknown> = {},
): void {
  const handle = screen.getByTestId(testId);
  fireEvent.pointerDown(handle, at(from[0], from[1], more));
  fireEvent.pointerMove(handle, at(from[0] + by[0], from[1] + by[1], more));
  fireEvent.pointerUp(handle, at(from[0] + by[0], from[1] + by[1], more));
}

const committed = (): Point[] => onCommit.mock.calls.at(-1)![0];
const note = () => screen.getByTestId('sld-route-note');

const hadPointerEvent = 'PointerEvent' in window;

beforeEach(() => {
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
  shut = () => null;
  onCommit.mockReset();
  onCommit.mockReturnValue(null);
  onReset.mockReset();
  onDone.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the handles', () => {
  it('are a run for each stretch, a square for each bend, and a plus beside each run', () => {
    draw();
    expect(screen.getAllByTestId(/^sld-route-run-/)).toHaveLength(3);
    expect(screen.getAllByTestId(/^sld-route-bend-/)).toHaveLength(2);
    expect(screen.getAllByTestId(/^sld-route-add-\d+$/)).toHaveLength(3);
    // Each can be reached by the keyboard, and says what it is and does.
    const level = screen.getByTestId('sld-route-run-1');
    expect(level).toHaveAttribute('tabindex', '0');
    expect(level).toHaveAttribute('data-kind', 'level');
    expect(level).toHaveAccessibleName(
      'Run 2 of 3 of line L1, level: drag it to slide it, or the Up and Down arrow keys slide it. Enter adds a bend in its middle.',
    );
    expect(screen.getByTestId('sld-route-bend-1')).toHaveAccessibleName(
      'Bend 1 of 2 of line L1: drag it to move it (hold Alt or Shift to move it alone), or the arrow keys. Delete removes it.',
    );
    // The cursor of a run says which way it slides.
    expect(level.style.cursor).toBe('ns-resize');
    expect(screen.getByTestId('sld-route-run-0').style.cursor).toBe('ew-resize');
  });

  it('leave a run too short for it without a plus, and stay out of a picture of the diagram', () => {
    draw({
      points: [
        [50, 0],
        [50, 100],
        [70, 100],
        [70, 200],
      ],
    });
    expect(screen.queryByTestId('sld-route-add-1')).toBeNull();
    expect(screen.getByTestId('sld-route-add-0')).toBeInTheDocument();
    expect(screen.getByTestId('sld-route-editor')).toHaveAttribute('data-export-ignore');
  });

  it('mark the longest run, which takes the focus when the line is picked from its menu', () => {
    draw();
    const marked = document.querySelectorAll(`[${ROUTE_FOCUS_ATTR}]`);
    expect(marked).toHaveLength(1);
    // The level run of 150 is the longest of the three.
    expect(marked[0]).toBe(screen.getByTestId('sld-route-run-1'));
  });
});

describe('dragging', () => {
  it('slides a run across itself, by whole units', () => {
    draw();
    drag('sld-route-run-1', [120, 100], [7.4, -30.2]);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(committed()).toEqual([
      [50, 0],
      [50, 70],
      [200, 70],
      [200, 200],
    ]);
    expect(onCommit.mock.calls[0]!.slice(1)).toEqual(['slide a run of', null]);
  });

  it('lands a run on the grid while Snap to grid is on', () => {
    draw({ grid: 16 });
    drag('sld-route-run-1', [120, 100], [0, 21]);
    // From 100: 121 is nearest to 128.
    expect(committed()[1]).toEqual([50, 128]);
  });

  it('moves a bend with its runs kept square, and alone with Alt or Shift held', () => {
    draw();
    drag('sld-route-bend-1', [50, 100], [-20, 30]);
    expect(committed()).toEqual([
      [30, 0],
      [30, 130],
      [200, 130],
      [200, 200],
    ]);
    expect(onCommit.mock.calls[0]![1]).toBe('move a bend of');
    // Shift does what Alt does: a drag with Alt held moves the window on some desktops.
    for (const held of [{ altKey: true }, { shiftKey: true }]) {
      drag('sld-route-bend-1', [50, 100], [-20, 30], held);
      expect(committed()).toEqual([
        [50, 0],
        [30, 130],
        [200, 100],
        [200, 200],
      ]);
    }
  });

  it('pulls a new bend out of a run by its plus, and puts one in on a click of it', () => {
    draw();
    // The plus of the level run stands over its middle, at (125, 87).
    drag('sld-route-add-1', [125, 87], [0, -47]);
    expect(committed()).toEqual([
      [50, 0],
      [50, 100],
      [125, 40],
      [200, 100],
      [200, 200],
    ]);
    onCommit.mockClear();
    const plus = screen.getByTestId('sld-route-add-1');
    fireEvent.pointerDown(plus, at(125, 87));
    fireEvent.pointerUp(plus, at(125, 87));
    // A bend in line with its run: nothing of the line has changed.
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getAllByTestId(/^sld-route-bend-/)).toHaveLength(3);
    expect(note()).toHaveTextContent('Bend added.');
  });

  it('draws the line at the nearest clear place, and the place it was refused dashed', () => {
    // Nothing may run level between the heights 110 and 150.
    shut = (points) =>
      points.some((p, i) => i > 0 && p[1] === points[i - 1]![1] && p[1] > 110 && p[1] < 150)
        ? 'it would lie on line L9'
        : null;
    draw();
    const handle = screen.getByTestId('sld-route-run-1');
    fireEvent.pointerDown(handle, at(120, 100));
    fireEvent.pointerMove(handle, at(120, 140));

    const shown = JSON.parse(screen.getByTestId('sld-route-editor').getAttribute('data-route')!);
    expect(shown[1]).toEqual([50, 150]);
    expect(screen.getByTestId('sld-route-refused')).toHaveAttribute(
      'd',
      'M50,0 L50,140 L200,140 L200,200',
    );
    expect(note()).toHaveAttribute('data-tone', 'refused');
    expect(note()).toHaveTextContent(
      'Not there: it would lie on line L9. Shown at the nearest clear place.',
    );
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.pointerUp(handle, at(120, 140));
    expect(committed()[1]).toEqual([50, 150]);
    expect(screen.queryByTestId('sld-route-refused')).toBeNull();
    expect(note()).toHaveTextContent(
      'Nearest clear place: where you let go, it would lie on line L9.',
    );
  });

  it('leaves the line where it was with no clear place near, and says why', () => {
    shut = (points) => (points[1]![1] === 100 ? null : 'it would run through the bar of bus B3');
    draw();
    const handle = screen.getByTestId('sld-route-run-1');
    fireEvent.pointerDown(handle, at(120, 100));
    fireEvent.pointerMove(handle, at(120, 160));
    expect(note()).toHaveTextContent(
      'Not there: it would run through the bar of bus B3. No clear place is near.',
    );
    fireEvent.pointerUp(handle, at(120, 160));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('says that the end of a line stays on its bar when it is dragged past the tip', () => {
    draw();
    const handle = screen.getByTestId('sld-route-run-0');
    fireEvent.pointerDown(handle, at(50, 50));
    fireEvent.pointerMove(handle, at(160, 50));
    expect(note()).toHaveTextContent('The end of a line stays on the bar of its bus');
    fireEvent.pointerUp(handle, at(160, 50));
    expect(committed()[0]).toEqual([97, 0]);
  });

  it('shows what the canvas refuses a route for, and goes back to the route it had', () => {
    onCommit.mockReturnValue('with the line there, something would be drawn over something else');
    draw();
    drag('sld-route-run-1', [120, 100], [0, -30]);
    expect(note()).toHaveAttribute('data-tone', 'refused');
    expect(note()).toHaveTextContent(
      'Not moved: with the line there, something would be drawn over something else.',
    );
    expect(JSON.parse(screen.getByTestId('sld-route-editor').getAttribute('data-route')!)).toEqual(
      STEPPED,
    );
  });

  it('gives the line up unchanged when the pointer is taken away mid-drag', () => {
    draw();
    const handle = screen.getByTestId('sld-route-run-1');
    fireEvent.pointerDown(handle, at(120, 100));
    fireEvent.pointerMove(handle, at(120, 60));
    fireEvent.lostPointerCapture(handle, at(120, 60));
    fireEvent.pointerUp(handle, at(120, 60));
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('the keys', () => {
  it('move a bend, put a bend into a run, take one out, and let go of the line', () => {
    draw();
    fireEvent.keyDown(screen.getByTestId('sld-route-bend-2'), { key: 'ArrowUp' });
    expect(committed()).toEqual([
      [50, 0],
      [50, 95],
      [200, 95],
      [200, 200],
    ]);
    // A move by the keys is one of several: the canvas is told which to take together.
    expect(onCommit.mock.calls[0]![2]).toBe('route:line-L1:bend');

    onCommit.mockClear();
    fireEvent.keyDown(screen.getByTestId('sld-route-bend-1'), { key: 'Delete' });
    expect(committed()).toEqual([
      [50, 0],
      [200, 100],
      [200, 200],
    ]);
    expect(onCommit.mock.calls[0]![1]).toBe('remove a bend of');

    onCommit.mockClear();
    fireEvent.keyDown(screen.getByTestId('sld-route-run-1'), { key: 'Enter' });
    expect(screen.getAllByTestId(/^sld-route-bend-/)).toHaveLength(3);
    expect(onCommit).not.toHaveBeenCalled();
    // Backspace takes it out again, as Delete does.
    fireEvent.keyDown(screen.getByTestId('sld-route-bend-2'), { key: 'Backspace' });
    expect(screen.getAllByTestId(/^sld-route-bend-/)).toHaveLength(2);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByTestId('sld-route-run-0'), { key: 'Escape' });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('do not move a part to where the line would be on something', () => {
    shut = () => 'it would run through the symbol of G1';
    draw();
    fireEvent.keyDown(screen.getByTestId('sld-route-run-1'), { key: 'ArrowDown' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(note()).toHaveTextContent('Not moved: it would run through the symbol of G1.');
  });
});

describe('a bend that was just put into a run', () => {
  it('moves alone with the arrow keys, which is how the line is made to turn there', () => {
    draw();
    fireEvent.click(screen.getByTestId('sld-route-add-bend'));
    // In the middle of the longest run, and with the focus.
    expect(note()).toHaveTextContent(
      'Bend added. Drag it, or press the arrow keys, to make the line turn there',
    );
    const bend = screen.getByTestId('sld-route-bend-2');
    expect(bend).toHaveFocus();
    fireEvent.keyDown(bend, { key: 'ArrowDown' });
    // The bend alone: the two bends beside it stay, and its runs are at an angle.
    expect(committed()).toEqual([
      [50, 0],
      [50, 100],
      [125, 105],
      [200, 100],
      [200, 200],
    ]);
    expect(onCommit.mock.calls[0]![1]).toBe('move a bend of');
  });

  it('goes along its run with the keys for that way, and the line stays as it is', () => {
    draw();
    fireEvent.click(screen.getByTestId('sld-route-add-bend'));
    const before = screen.getByTestId('sld-route-bend-2');
    expect(before).toHaveAttribute('x', String(125 - 4.5));
    fireEvent.keyDown(before, { key: 'ArrowRight' });
    expect(onCommit).not.toHaveBeenCalled();
    const after = screen.getByTestId('sld-route-bend-2');
    expect(after).toHaveAttribute('x', String(130 - 4.5));
    expect(after).toHaveFocus();
    // From there it is pulled out like any other.
    fireEvent.keyDown(after, { key: 'ArrowUp', shiftKey: true });
    expect(committed()[2]).toEqual([130, 80]);
  });

  it('moves alone when it is dragged, with no key held', () => {
    draw();
    fireEvent.click(screen.getByTestId('sld-route-add-bend'));
    drag('sld-route-bend-2', [125, 100], [0, 30]);
    expect(committed()).toEqual([
      [50, 0],
      [50, 100],
      [125, 130],
      [200, 100],
      [200, 200],
    ]);
    // A bend of the route itself still takes its runs along.
    onCommit.mockClear();
    drag('sld-route-bend-1', [50, 100], [0, 30]);
    expect(committed()).toEqual([
      [50, 0],
      [50, 130],
      [200, 130],
      [200, 200],
    ]);
  });

  it('keeps the focus of the keys when the route it made comes back from the canvas', () => {
    const { rerender, slot } = draw();
    fireEvent.click(screen.getByTestId('sld-route-add-bend'));
    fireEvent.keyDown(screen.getByTestId('sld-route-bend-2'), { key: 'ArrowDown' });
    const kept = committed();
    // The canvas hands the route back a render later: the bend is a bend of it now.
    rerender(
      <SldRouteEditor
        edgeId="line-L1"
        name="line L1"
        points={kept}
        manual
        ends={ENDS}
        makeCheck={() => (points) => shut(points)}
        grid={null}
        onCommit={onCommit}
        onReset={onReset}
        onDone={onDone}
        barSlot={slot}
      />,
    );
    const bend = screen.getByTestId('sld-route-bend-2');
    expect(bend).toHaveFocus();
    fireEvent.keyDown(bend, { key: 'ArrowDown' });
    expect(committed()[2]).toEqual([125, 110]);
  });
});

describe('a step too short to be read as one', () => {
  /** The connector of a device over its bar: out of its south face, square onto the bar. */
  const DROP: Point[] = [
    [40, 0],
    [40, 80],
  ];
  const DEVICE: RouteEnds = {
    source: { kind: 'fixed' },
    target: { kind: 'bar', y: 80, lo: 3, hi: 97 },
  };
  function drawConnector() {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    render(
      <SldRouteEditor
        edgeId="stub-load-PQ_1"
        name="the connector of PQ_1"
        points={DROP}
        manual={false}
        ends={DEVICE}
        makeCheck={() => (points) => shut(points)}
        grid={null}
        onCommit={onCommit}
        onReset={onReset}
        onDone={onDone}
        barSlot={slot}
      />,
    );
  }

  it('is not made by a drag that goes a little way: the line stays, and the bar says how far to go', () => {
    drawConnector();
    const run = screen.getByTestId('sld-route-run-0');
    fireEvent.pointerDown(run, at(40, 40));
    fireEvent.pointerMove(run, at(45, 40));
    // Held where it was, with no place refused in red: there is nothing in the way.
    expect(JSON.parse(screen.getByTestId('sld-route-editor').getAttribute('data-route')!)).toEqual(
      DROP,
    );
    expect(screen.queryByTestId('sld-route-refused')).toBeNull();
    expect(note()).toHaveTextContent('A step is 12 px at the least: keep dragging to make one.');
    expect(note()).toHaveAttribute('data-tone', 'plain');
    fireEvent.pointerUp(run, at(45, 40));
    expect(onCommit).not.toHaveBeenCalled();
    // Dragged far enough, it goes with the pointer.
    drag('sld-route-run-0', [40, 40], [20, 0]);
    expect(committed()).toEqual([
      [40, 0],
      [40, 12],
      [60, 12],
      [60, 80],
    ]);
  });

  it('is made as long as a step is by one press of a key', () => {
    drawConnector();
    fireEvent.keyDown(screen.getByTestId('sld-route-run-0'), { key: 'ArrowRight' });
    expect(committed()).toEqual([
      [40, 0],
      [40, 12],
      [52, 12],
      [52, 80],
    ]);
  });

  it('is refused where the tip of the bar leaves room for no more, and the bar says so', () => {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    render(
      <SldRouteEditor
        edgeId="stub-load-PQ_1"
        name="the connector of PQ_1"
        points={DROP}
        manual={false}
        ends={{ ...DEVICE, target: { kind: 'bar', y: 80, lo: 3, hi: 47 } }}
        makeCheck={() => (points) => shut(points)}
        grid={null}
        onCommit={onCommit}
        onReset={onReset}
        onDone={onDone}
        barSlot={slot}
      />,
    );
    fireEvent.keyDown(screen.getByTestId('sld-route-run-0'), { key: 'ArrowRight', shiftKey: true });
    expect(onCommit).not.toHaveBeenCalled();
    expect(note()).toHaveTextContent(
      'Not moved: its end is at the tip of the bar of its bus, which leaves room only for a step of under 12 px.',
    );
    // A drag that way finds no place either, and says the same.
    drag('sld-route-run-0', [40, 40], [28, 0]);
    expect(onCommit).not.toHaveBeenCalled();
    expect(note()).toHaveTextContent(
      'Not there: its end is at the tip of the bar of its bus, which leaves room only for a step of under 12 px. No clear place is near.',
    );
    // And a short one does not say to keep dragging: that would not help.
    drag('sld-route-run-0', [40, 40], [5, 0]);
    expect(onCommit).not.toHaveBeenCalled();
    expect(note()).toHaveTextContent(
      'Not there: its end is at the tip of the bar of its bus, which leaves room only for a step of under 12 px.',
    );
    expect(note()).not.toHaveTextContent('keep dragging');
  });
});

describe('double-clicks', () => {
  it('put a bend into a run where it was clicked, and take a bend out', () => {
    draw();
    fireEvent.doubleClick(screen.getByTestId('sld-route-run-1'), { clientX: 140.4, clientY: 103 });
    expect(screen.getAllByTestId(/^sld-route-bend-/)).toHaveLength(3);
    // The half after the new bend slides on its own now, which makes a step.
    drag('sld-route-run-2', [170, 100], [0, 40]);
    expect(committed()).toEqual([
      [50, 0],
      [50, 100],
      [140, 100],
      [140, 140],
      [200, 140],
      [200, 200],
    ]);
    onCommit.mockClear();
    fireEvent.doubleClick(screen.getByTestId('sld-route-bend-2'));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![1]).toBe('remove a bend of');
  });
});

describe('the bar', () => {
  it('names the line, says how it is routed, and how the handles are used', () => {
    const { slot } = draw();
    const bar = screen.getByTestId('sld-route-bar');
    expect(slot).toContainElement(bar);
    expect(bar).toHaveAccessibleName('Route of line L1');
    expect(screen.getByTestId('sld-route-name')).toHaveTextContent('Line L1');
    expect(screen.getByTestId('sld-route-status')).toHaveTextContent('Routed automatically');
    expect(note()).toHaveTextContent(ROUTE_EDIT_HINT);
    expect(note()).toHaveAttribute('title', expect.stringContaining('Double-click a run'));
  });

  it('offers Reset route for a route drawn by hand, and Remove bend while a bend is picked', () => {
    draw({ manual: true });
    expect(screen.getByTestId('sld-route-status')).toHaveTextContent('Routed by hand');
    fireEvent.click(screen.getByTestId('sld-route-reset'));
    expect(onReset).toHaveBeenCalledTimes(1);

    expect(screen.queryByTestId('sld-route-remove-bend')).toBeNull();
    fireEvent.focus(screen.getByTestId('sld-route-bend-1'));
    fireEvent.click(screen.getByTestId('sld-route-remove-bend'));
    expect(onCommit.mock.calls[0]![1]).toBe('remove a bend of');

    fireEvent.click(screen.getByTestId('sld-route-done'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('adds a bend to the run that is picked, or to the longest one', () => {
    draw();
    fireEvent.click(screen.getByTestId('sld-route-add-bend'));
    // The longest run is the upright one down to the second bar... and the level one: the first of them.
    expect(screen.getAllByTestId(/^sld-route-bend-/)).toHaveLength(3);
    expect(screen.getByTestId('sld-route-remove-bend')).toBeInTheDocument();
  });

  it('is not drawn until the row above the diagram has a place for it', () => {
    render(
      <SldRouteEditor
        edgeId="line-L1"
        name="line L1"
        points={STEPPED}
        manual={false}
        ends={ENDS}
        makeCheck={() => () => null}
        grid={null}
        onCommit={onCommit}
        onReset={onReset}
        onDone={onDone}
        barSlot={null}
      />,
    );
    expect(screen.queryByTestId('sld-route-bar')).toBeNull();
    expect(screen.getByTestId('sld-route-editor')).toBeInTheDocument();
  });
});
