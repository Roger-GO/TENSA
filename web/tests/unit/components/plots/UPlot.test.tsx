/**
 * <UPlot /> wrapper lifecycle tests.
 *
 * Test approach: uPlot internally constructs a ``<canvas>`` and reads
 * ``getContext('2d')``. jsdom returns ``null`` for canvas contexts,
 * which uPlot tolerates by skipping draw calls; the DOM structure is
 * still built, so we can assert on container children, instance
 * lifecycle, and ``setData`` invocation by mocking the uplot module
 * with a lightweight stand-in. The mock matches the surface our
 * wrapper actually invokes (constructor, ``setData``, ``setSize``,
 * ``destroy``). This avoids both the canvas-getContext failure path
 * and the variability of uPlot's internal canvas-pixel measurements.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// vi.mock factories are hoisted above any import; closure-captured
// variables must be created via vi.hoisted to be initialised before
// the factory body runs.
const { setDataSpy, setSizeSpy, destroySpy, constructSpy, FakeUPlot } = vi.hoisted(() => {
  const setDataSpy = vi.fn();
  const setSizeSpy = vi.fn();
  const destroySpy = vi.fn();
  const constructSpy = vi.fn();
  class FakeUPlot {
    root: HTMLElement;
    constructor(opts: unknown, data: unknown, target: HTMLElement) {
      constructSpy(opts, data, target);
      this.root = document.createElement('div');
      this.root.setAttribute('data-uplot-root', 'true');
      // uPlot draws its legend under the plot, inside its own element.
      const legend = document.createElement('div');
      legend.className = 'u-legend';
      this.root.appendChild(legend);
      target.appendChild(this.root);
    }
    setData(data: unknown, resetScales?: boolean) {
      setDataSpy(data, resetScales);
    }
    setSize(size: { width: number; height: number }) {
      setSizeSpy(size);
    }
    destroy() {
      destroySpy();
      this.root.remove();
    }
  }
  return { setDataSpy, setSizeSpy, destroySpy, constructSpy, FakeUPlot };
});

vi.mock('uplot', () => ({
  default: FakeUPlot,
}));

// Avoid pulling the real uPlot CSS through jsdom's CSS parser.
vi.mock('uplot/dist/uPlot.min.css', () => ({}));

import { UPlot } from '@/components/plots/UPlot';

describe('UPlot wrapper', () => {
  beforeEach(() => {
    setDataSpy.mockClear();
    setSizeSpy.mockClear();
    destroySpy.mockClear();
    constructSpy.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('constructs a uPlot instance on mount and destroys it on unmount', () => {
    const data: [Float64Array, Float64Array] = [
      new Float64Array([0, 1, 2]),
      new Float64Array([0.1, 0.2, 0.3]),
    ];
    const options = {
      width: 600,
      height: 200,
      series: [{ label: 't' }, { label: 'y' }],
    };
    const { unmount } = render(<UPlot options={options} data={data} />);
    expect(constructSpy).toHaveBeenCalledTimes(1);
    expect(destroySpy).not.toHaveBeenCalled();
    unmount();
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('calls setData on data prop changes without re-constructing', () => {
    const data1: [Float64Array, Float64Array] = [
      new Float64Array([0, 1]),
      new Float64Array([0.1, 0.2]),
    ];
    const data2: [Float64Array, Float64Array] = [
      new Float64Array([0, 1, 2]),
      new Float64Array([0.1, 0.2, 0.3]),
    ];
    const options = {
      width: 600,
      height: 200,
      series: [{ label: 't' }, { label: 'y' }],
    };
    const { rerender } = render(<UPlot options={options} data={data1} />);
    expect(constructSpy).toHaveBeenCalledTimes(1);
    rerender(<UPlot options={options} data={data2} />);
    // setData fires on the data-update effect for the new data.
    // Note: it may also fire on initial mount with the original data
    // depending on the React reconciler's effect timing — we only
    // care that the latest call was the new data.
    expect(setDataSpy).toHaveBeenCalled();
    const lastCall = setDataSpy.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe(data2);
    // No reconstruction.
    expect(constructSpy).toHaveBeenCalledTimes(1);
  });

  it('pushes new data with scale reset so the axes and the canvas follow it', () => {
    // uPlot's setData(data, false) skips both the scale update and the
    // redraw: a chart fed that way keeps showing what it was built with.
    // Streaming data therefore has to go in with the scales reset, which
    // is also what lets the x axis grow with the time column.
    const options = {
      width: 600,
      height: 200,
      series: [{ label: 't' }, { label: 'y' }],
    };
    const frame = (n: number): [Float64Array, Float64Array] => [
      new Float64Array(Array.from({ length: n }, (_, i) => i)),
      new Float64Array(Array.from({ length: n }, (_, i) => i / 10)),
    ];
    const { rerender } = render(<UPlot options={options} data={frame(2)} />);
    setDataSpy.mockClear();
    for (let n = 3; n <= 6; n += 1) {
      rerender(<UPlot options={options} data={frame(n)} />);
    }
    expect(setDataSpy).toHaveBeenCalledTimes(4);
    for (const call of setDataSpy.mock.calls) {
      // ``undefined`` is uPlot's own default (reset); only ``false`` is wrong.
      expect(call[1]).not.toBe(false);
    }
    expect(constructSpy).toHaveBeenCalledTimes(1);
    expect(destroySpy).not.toHaveBeenCalled();
  });

  it('reconstructs when the options reference changes', () => {
    const data: [Float64Array, Float64Array] = [
      new Float64Array([0, 1]),
      new Float64Array([0.1, 0.2]),
    ];
    const opts1 = {
      width: 600,
      height: 200,
      series: [{ label: 't' }, { label: 'y' }],
    };
    const opts2 = {
      width: 600,
      height: 200,
      series: [{ label: 't' }, { label: 'y2' }],
    };
    const { rerender } = render(<UPlot options={opts1} data={data} />);
    expect(constructSpy).toHaveBeenCalledTimes(1);
    rerender(<UPlot options={opts2} data={data} />);
    // Old destroyed, new constructed.
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(constructSpy).toHaveBeenCalledTimes(2);
  });

  it('renders the empty fallback when supplied AND data has zero rows', () => {
    const options = { width: 600, height: 200, series: [{ label: 't' }] };
    const data: [Float64Array] = [new Float64Array([])];
    const { getByTestId, queryByTestId } = render(
      <UPlot options={options} data={data} emptyFallback={<span>nothing here</span>} />,
    );
    expect(getByTestId('uplot-empty')).toHaveTextContent('nothing here');
    expect(queryByTestId('uplot-container')).toBeNull();
    // No uPlot instance gets constructed when the fallback renders.
    expect(constructSpy).not.toHaveBeenCalled();
  });

  it('exposes the uPlot instance via uplotRef', () => {
    const options = {
      width: 600,
      height: 200,
      series: [{ label: 't' }, { label: 'y' }],
    };
    const data: [Float64Array, Float64Array] = [
      new Float64Array([0, 1]),
      new Float64Array([0.1, 0.2]),
    ];
    // Cast: the wrapper is typed against the real uPlot; the FakeUPlot
    // mock satisfies the lifecycle-only surface our test exercises.
    type AnyRef = React.MutableRefObject<unknown>;
    const ref: AnyRef = { current: null };
    const { unmount } = render(
      <UPlot
        options={options}
        data={data}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        uplotRef={ref as any}
      />,
    );
    expect(ref.current).not.toBeNull();
    unmount();
    expect(ref.current).toBeNull();
  });
});

describe('UPlot wrapper sizing with a legend', () => {
  const options = { width: 600, height: 200, series: [{ label: 't' }, { label: 'y' }] };
  const data: [Float64Array, Float64Array] = [
    new Float64Array([0, 1]),
    new Float64Array([0.1, 0.2]),
  ];

  /** The legend's height as the (layout-less) jsdom is told it is. */
  let legendHeight = 0;
  let observers: ((entries: { contentRect: { width: number; height: number } }[]) => void)[] = [];

  beforeEach(() => {
    setSizeSpy.mockClear();
    constructSpy.mockClear();
    legendHeight = 0;
    observers = [];
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('u-legend') ? legendHeight : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ width: 600, height: 200 }) as DOMRect,
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: (typeof observers)[number]) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('leaves the size alone when there is no legend to make room for', () => {
    render(<UPlot options={options} data={data} />);
    expect(setSizeSpy).not.toHaveBeenCalled();
  });

  it('makes the plot shorter by the height of the legend, so the legend stays inside the box', () => {
    legendHeight = 40;
    render(<UPlot options={options} data={data} />);
    // uPlot's height is the plot's: the legend adds to it, and the box clips.
    expect(setSizeSpy).toHaveBeenCalledWith({ width: 600, height: 160 });
  });

  it('measures the legend again once the frame has settled, since uPlot lays it out late', async () => {
    render(<UPlot options={options} data={data} />);
    legendHeight = 60;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(setSizeSpy).toHaveBeenLastCalledWith({ width: 600, height: 140 });
  });

  it('fits the plot and its legend to the box again when the box is resized', () => {
    legendHeight = 40;
    render(<UPlot options={options} data={data} />);
    setSizeSpy.mockClear();

    // The legend wraps at the new width, so the whole box is offered first and the legend is
    // measured after that.
    legendHeight = 80;
    observers.forEach((cb) => cb([{ contentRect: { width: 400, height: 300 } }]));

    expect(setSizeSpy.mock.calls.map((c) => c[0])).toEqual([
      { width: 400, height: 300 },
      { width: 400, height: 220 },
    ]);
  });

  it('keeps the plot a usable height when the legend is taller than the box', () => {
    legendHeight = 500;
    render(<UPlot options={options} data={data} />);
    expect(setSizeSpy).toHaveBeenCalledWith({ width: 600, height: 60 });
  });

  it('clips what it holds, so the box never grows with the chart and sets the observer off again', () => {
    const { getByTestId } = render(<UPlot options={options} data={data} />);
    expect(getByTestId('uplot-container').className).toContain('overflow-hidden');
  });
});
