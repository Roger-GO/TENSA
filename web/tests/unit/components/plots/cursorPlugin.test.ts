/**
 * The A/B cursor plugin of a chart: which clicks place a cursor, and what is
 * drawn. Driven with a stand-in for the uPlot instance (an ``over`` element and a
 * recording canvas), since jsdom has no canvas.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type uPlot from 'uplot';
import { CLICK_SLOP_PX, deltaCursorPlugin } from '@/components/plots/cursorPlugin';
import type { CursorPluginSource } from '@/components/plots/cursorPlugin';
import type { DeltaCursors } from '@/store/plot';

/** A uPlot stand-in with the parts the plugin touches. ``posToVal`` maps 100 px to 1 s. */
function fakeChart(
  scale: { min: number; max: number } | null = { min: 0, max: 10 },
  pointerLeft = -10,
) {
  // uPlot's own layers: the root holds a wrapper, which holds the element over the plot.
  const root = document.createElement('div');
  const wrap = document.createElement('div');
  const over = document.createElement('div');
  root.appendChild(wrap);
  wrap.appendChild(over);
  over.getBoundingClientRect = () => ({ left: 20 }) as DOMRect;
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    setLineDash: vi.fn(),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    font: '',
    textBaseline: '',
  };
  const u = {
    root,
    over,
    ctx,
    width: 600,
    bbox: { left: 0, top: 10, width: 600, height: 200 },
    scales: { x: scale ?? {} },
    // uPlot keeps the crosshair's x at -10 while the pointer is not over the chart.
    cursor: { left: pointerLeft },
    posToVal: (px: number) => px / 100,
    valToPos: (t: number) => t * 100,
  } as unknown as uPlot;
  return { u, root, wrap, over, ctx };
}

function source(overrides: Partial<CursorPluginSource> = {}): CursorPluginSource {
  return {
    cursors: () => ({ a: null, b: null }),
    armed: () => true,
    place: vi.fn(),
    colors: () => ({ a: 'blue', b: 'red' }),
    ...overrides,
  };
}

/** The plugin's two hooks, called directly (uPlot types a hook as one function or a list of them). */
function hooksOf(src: CursorPluginSource): {
  ready: (u: uPlot) => void;
  draw: (u: uPlot) => void;
} {
  return deltaCursorPlugin(src).hooks as {
    ready: (u: uPlot) => void;
    draw: (u: uPlot) => void;
  };
}

/** A press and release on the chart, as a browser reports them: down, up, then the click. */
function press(over: HTMLElement, from: number, to: number, detail = 1): void {
  over.dispatchEvent(new MouseEvent('mousedown', { clientX: from, bubbles: true }));
  over.dispatchEvent(new MouseEvent('mouseup', { clientX: to, bubbles: true }));
  over.dispatchEvent(new MouseEvent('click', { clientX: to, detail, bubbles: true }));
}

describe('deltaCursorPlugin: placing a cursor', () => {
  let src: CursorPluginSource;
  let over: HTMLElement;

  beforeEach(() => {
    src = source();
    const chart = fakeChart();
    over = chart.over;
    hooksOf(src).ready(chart.u);
  });

  it('places a cursor at the time under the pointer when the mode is on and the pointer hardly moved', () => {
    // 220 px from the page's left is 200 px into the plot (it starts at 20): 2 s.
    press(over, 220, 220);
    expect(src.place).toHaveBeenCalledTimes(1);
    expect(src.place).toHaveBeenCalledWith(2);

    press(over, 420, 420 + CLICK_SLOP_PX);
    expect(src.place).toHaveBeenLastCalledWith(4 + CLICK_SLOP_PX / 100);
  });

  it('does not place one at the end of a drag: that is a zoom', () => {
    press(over, 100, 100 + CLICK_SLOP_PX + 1);
    press(over, 400, 100);
    expect(src.place).not.toHaveBeenCalled();
  });

  it('does not place one while the mode is off', () => {
    const chart = fakeChart();
    const off = source({ armed: () => false });
    hooksOf(off).ready(chart.u);

    press(chart.over, 220, 220);

    expect(off.place).not.toHaveBeenCalled();
  });

  it('reads the mode when the press happens, not when the chart was built', () => {
    let armed = false;
    const live = source({ armed: () => armed });
    const chart = fakeChart();
    hooksOf(live).ready(chart.u);

    press(chart.over, 220, 220);
    expect(live.place).not.toHaveBeenCalled();
    armed = true;
    press(chart.over, 220, 220);
    expect(live.place).toHaveBeenCalledTimes(1);
  });

  it('ignores a release that no press on the chart began (the drag started outside it)', () => {
    // The browser sends no click for a press and a release on different elements.
    over.dispatchEvent(new MouseEvent('mouseup', { clientX: 220, bubbles: true }));

    expect(src.place).not.toHaveBeenCalled();
  });

  it('places a cursor for a click that no press led to, as a script or assistive technology makes', () => {
    over.dispatchEvent(new MouseEvent('click', { clientX: 320, detail: 1, bubbles: true }));

    expect(src.place).toHaveBeenCalledWith(3);
  });

  it('puts a click that carries no position where the crosshair is', () => {
    const chart = fakeChart({ min: 0, max: 10 }, 250);
    hooksOf(src).ready(chart.u);

    chart.over.click();

    expect(src.place).toHaveBeenCalledWith(2.5);
  });

  it('puts a click that carries no position in the middle of the time shown when the pointer is elsewhere', () => {
    const chart = fakeChart({ min: 4, max: 10 });
    hooksOf(src).ready(chart.u);

    chart.over.click();

    expect(src.place).toHaveBeenCalledWith(7);
  });

  it('places nothing for a click that carries no position on a chart with no x scale yet', () => {
    const chart = fakeChart(null);
    hooksOf(src).ready(chart.u);

    chart.over.click();

    expect(src.place).not.toHaveBeenCalled();
  });

  it('places a click that uPlot would swallow as the end of a drag, and still not the end of a drag', () => {
    // uPlot stops a click on the chart in the capture phase on its wrapper when the
    // pointer is not where the last press left it, which a script's click never is.
    const chart = fakeChart();
    chart.wrap.addEventListener(
      'click',
      (e) => {
        if (e.target === chart.over) e.stopImmediatePropagation();
      },
      true,
    );
    hooksOf(src).ready(chart.u);

    chart.over.click();
    expect(src.place).toHaveBeenCalledTimes(1);

    press(chart.over, 100, 100 + CLICK_SLOP_PX + 1);
    expect(src.place).toHaveBeenCalledTimes(1);
  });

  it('places nothing for a click on the root that is not on the chart itself', () => {
    const chart = fakeChart();
    hooksOf(src).ready(chart.u);

    chart.root.click();
    chart.wrap.click();

    expect(src.place).not.toHaveBeenCalled();
  });

  it('does not count the second click of a double-click, which puts the zoom back', () => {
    press(over, 220, 220, 1);
    press(over, 220, 220, 2);

    expect(src.place).toHaveBeenCalledTimes(1);
  });

  it('does not place a time that is not a number', () => {
    const chart = fakeChart();
    chart.u.posToVal = () => Number.NaN;
    hooksOf(src).ready(chart.u);

    press(chart.over, 220, 220);

    expect(src.place).not.toHaveBeenCalled();
  });
});

describe('deltaCursorPlugin: drawing', () => {
  function draw(cursors: DeltaCursors, scale?: { min: number; max: number } | null) {
    const chart = fakeChart(scale);
    hooksOf(source({ cursors: () => cursors })).draw(chart.u);
    return chart.ctx;
  }

  it('draws nothing while no cursor is placed', () => {
    const ctx = draw({ a: null, b: null });

    expect(ctx.stroke).not.toHaveBeenCalled();
    expect(ctx.save).not.toHaveBeenCalled();
  });

  it('draws a labelled vertical line across the plot area for each cursor placed', () => {
    const ctx = draw({ a: 2, b: 5 });

    expect(ctx.stroke).toHaveBeenCalledTimes(2);
    expect(ctx.moveTo).toHaveBeenNthCalledWith(1, 200, 10);
    expect(ctx.lineTo).toHaveBeenNthCalledWith(1, 200, 210);
    expect(ctx.moveTo).toHaveBeenNthCalledWith(2, 500, 10);
    expect(ctx.fillText.mock.calls.map((c) => c[0])).toEqual(['A', 'B']);
  });

  it('colours A and B as the source says', () => {
    const colours: string[] = [];
    const chart = fakeChart();
    const probe = chart.ctx as { strokeStyle: string; stroke: () => void };
    probe.stroke = () => colours.push(probe.strokeStyle);
    hooksOf(source({ cursors: () => ({ a: 1, b: 2 }) })).draw(chart.u);

    expect(colours).toEqual(['blue', 'red']);
  });

  it('draws only the cursor that is placed', () => {
    const ctx = draw({ a: null, b: 3 });

    expect(ctx.stroke).toHaveBeenCalledTimes(1);
    expect(ctx.fillText.mock.calls.map((c) => c[0])).toEqual(['B']);
  });

  it('leaves out a cursor the chart is zoomed away from', () => {
    const ctx = draw({ a: 2, b: 8 }, { min: 5, max: 10 });

    expect(ctx.stroke).toHaveBeenCalledTimes(1);
    expect(ctx.fillText.mock.calls.map((c) => c[0])).toEqual(['B']);
  });

  it('draws nothing where there is no canvas to draw on', () => {
    const chart = fakeChart();
    (chart.u as unknown as { ctx: unknown }).ctx = null;

    expect(() => hooksOf(source({ cursors: () => ({ a: 1, b: 2 }) })).draw(chart.u)).not.toThrow();
  });

  it('draws nothing before the chart has an x scale', () => {
    const ctx = draw({ a: 2, b: 5 }, null);

    expect(ctx.stroke).not.toHaveBeenCalled();
  });
});
