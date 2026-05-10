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
      target.appendChild(this.root);
    }
    setData(data: unknown) {
      setDataSpy(data);
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
