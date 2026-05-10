/**
 * Tests for ``<EIGScatter />`` (Unit 6 + Unit 15 interactivity).
 *
 * Coverage (Unit 6 baseline):
 * - Empty-state branches: result=null + result with mode_count=0.
 * - Renders one circle per visible mode (filter applied).
 * - Click on a point updates the analyze store's selectedModeId.
 * - Filter widening surfaces previously-hidden modes.
 * - Selected point gets the data-selected="true" attribute.
 *
 * Coverage (Unit 15 — interactivity):
 * - Wheel zoom shrinks the visible data window.
 * - Reset button + ``requestEigViewReset`` restore the auto-fit view.
 * - Log-scale toggle flips ``data-x-scale`` + axis label.
 * - Hover surfaces the tooltip with formatted λ / ζ / f.
 * - Negative-damping (positive Re) modes trigger the warning chip.
 * - ``signedLog10`` helper round-trips correctly.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// jsdom 25 ships without ``window.PointerEvent``. testing-library's
// ``fireEvent.pointer*`` falls back to a generic Event in that case,
// which drops ``clientX``/``clientY`` from the init bag and leaves our
// coordinate-driven hover handler with NaN. Polyfill PointerEvent as
// a thin subclass of MouseEvent so the init dict survives. Mirrors
// the polyfill in ScrubControl.test.tsx.
beforeAll(() => {
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === 'undefined') {
    class PointerEventPolyfill extends MouseEvent {
      readonly pointerId: number;
      readonly pointerType: string;
      readonly isPrimary: boolean;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
        this.pointerType = init.pointerType ?? 'mouse';
        this.isPrimary = init.isPrimary ?? true;
      }
    }
    (globalThis as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent =
      PointerEventPolyfill;
    (window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent =
      PointerEventPolyfill;
  }
});
import { EIGScatter, computeViewport, signedLog10 } from '@/components/analyze/EIGScatter';
import { DEFAULT_EIG_FILTER, useAnalyzeStore } from '@/store/analyze';
import { __resetEigViewBus, requestEigLogToggle, requestEigViewReset } from '@/lib/eigViewBus';
import type { EigResult } from '@/api/types';

function resetAnalyzeStore() {
  useAnalyzeStore.setState({
    subMode: 'pflow',
    eigResult: null,
    selectedModeId: null,
    filter: { ...DEFAULT_EIG_FILTER },
    cpfResult: null,
  });
}

const RESULT: EigResult = {
  eigenvalues: [
    { real: -0.1, imag: 2.0 }, // visible (damping 0.05, |Re|=0.1)
    { real: -0.5, imag: 0.0 }, // hidden (damping 1.0)
    { real: -10.0, imag: 1.0 }, // hidden (|Re|=10)
    { real: -0.05, imag: -2.0 }, // visible
  ],
  damping_ratios: [0.05, 1.0, 0.995, 0.025],
  frequencies_hz: [0.318, 0, 0.159, 0.318],
  mode_count: 4,
  state_count: 4,
  state_names: ['delta_1', 'omega_1', 'delta_2', 'omega_2'],
  tds_initialized: true,
};

/**
 * jsdom returns a zero-rect for SVG elements unless we stub
 * ``getBoundingClientRect`` — pointer / wheel handlers bail early on
 * a zero-width rect, which would silently no-op every interaction
 * test. The stub mirrors the SVG's logical viewBox so SVG-px and
 * client-px stay 1:1.
 */
function stubSvgRect(svg: SVGSVGElement) {
  svg.getBoundingClientRect = () =>
    ({
      width: 320,
      height: 240,
      top: 0,
      left: 0,
      right: 320,
      bottom: 240,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe('<EIGScatter />', () => {
  beforeEach(() => {
    resetAnalyzeStore();
    __resetEigViewBus();
  });
  afterEach(() => {
    resetAnalyzeStore();
    __resetEigViewBus();
  });

  it('renders the empty-state when no result is set', () => {
    render(<EIGScatter />);
    expect(screen.getByTestId('eig-empty')).toBeInTheDocument();
  });

  it('renders the no-dynamic-states empty state when mode_count=0', () => {
    const empty: EigResult = {
      eigenvalues: [],
      damping_ratios: [],
      frequencies_hz: [],
      mode_count: 0,
      state_count: 0,
      state_names: [],
      tds_initialized: true,
    };
    render(<EIGScatter result={empty} />);
    const empt = screen.getByTestId('eig-empty');
    expect(empt).toBeInTheDocument();
    expect(empt.textContent).toMatch(/no dynamic states/i);
  });

  it('renders a circle for each visible mode under the default filter', () => {
    useAnalyzeStore.getState().setEigResult(RESULT);
    render(<EIGScatter />);
    expect(screen.getByTestId('eig-scatter')).toBeInTheDocument();
    // Default filter shows modes 0 and 3 only.
    expect(screen.getByTestId('eig-scatter-point-0')).toBeInTheDocument();
    expect(screen.getByTestId('eig-scatter-point-3')).toBeInTheDocument();
    expect(screen.queryByTestId('eig-scatter-point-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('eig-scatter-point-2')).not.toBeInTheDocument();
  });

  it('clicking a point sets the selected mode id', async () => {
    useAnalyzeStore.getState().setEigResult(RESULT);
    render(<EIGScatter />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('eig-scatter-point-3'));
    expect(useAnalyzeStore.getState().selectedModeId).toBe(3);
  });

  it('selected point carries data-selected="true"', () => {
    useAnalyzeStore.getState().setEigResult(RESULT);
    useAnalyzeStore.getState().setSelectedModeId(0);
    render(<EIGScatter />);
    expect(screen.getByTestId('eig-scatter-point-0')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('eig-scatter-point-3')).toHaveAttribute('data-selected', 'false');
  });

  it('widening the filter surfaces previously hidden modes', () => {
    useAnalyzeStore.getState().setEigResult(RESULT);
    useAnalyzeStore.getState().setFilter({ dampingMax: 1.5, realAbsMax: 100 });
    render(<EIGScatter />);
    for (const i of [0, 1, 2, 3]) {
      expect(screen.getByTestId(`eig-scatter-point-${i}`)).toBeInTheDocument();
    }
  });

  // ---------------------------------------------------------------------
  // Unit 15 — interactivity
  // ---------------------------------------------------------------------

  describe('zoom + pan', () => {
    it('wheel-up shrinks the visible data window (zoom in)', () => {
      useAnalyzeStore.getState().setEigResult(RESULT);
      const { container } = render(<EIGScatter />);
      const svg = container.querySelector('svg');
      expect(svg).not.toBeNull();
      stubSvgRect(svg as SVGSVGElement);

      // Capture an initial point's pixel position to compare after
      // zoom — under "zoom in" the points spread further apart in
      // pixel space, so |cx_after - center| > |cx_before - center|.
      const before = screen.getByTestId('eig-scatter-point-0');
      const cxBefore = Number(before.getAttribute('cx'));

      fireEvent.wheel(svg as SVGSVGElement, {
        deltaY: -100,
        clientX: 160,
        clientY: 120,
      });

      const after = screen.getByTestId('eig-scatter-point-0');
      const cxAfter = Number(after.getAttribute('cx'));
      // Zoom centred on the chart middle (160) → point 0 (at -0.1 Re,
      // i.e., slightly LEFT of center) moves further left.
      expect(Math.abs(cxAfter - 160)).toBeGreaterThan(Math.abs(cxBefore - 160));
    });

    it('Reset button restores the auto-fit view', () => {
      useAnalyzeStore.getState().setEigResult(RESULT);
      const { container } = render(<EIGScatter />);
      const svg = container.querySelector('svg');
      stubSvgRect(svg as SVGSVGElement);

      const before = screen.getByTestId('eig-scatter-point-0');
      const cxBefore = Number(before.getAttribute('cx'));

      fireEvent.wheel(svg as SVGSVGElement, {
        deltaY: -100,
        clientX: 160,
        clientY: 120,
      });
      // Sanity: zoom changed the position.
      const cxZoomed = Number(screen.getByTestId('eig-scatter-point-0').getAttribute('cx'));
      expect(cxZoomed).not.toBe(cxBefore);

      fireEvent.click(screen.getByTestId('eig-scatter-zoom-reset'));
      const cxReset = Number(screen.getByTestId('eig-scatter-point-0').getAttribute('cx'));
      // Reset should bring the position back to where it was initially.
      expect(cxReset).toBe(cxBefore);
    });

    it('extreme zoom still renders without crashing', () => {
      useAnalyzeStore.getState().setEigResult(RESULT);
      const { container } = render(<EIGScatter />);
      const svg = container.querySelector('svg');
      stubSvgRect(svg as SVGSVGElement);
      // Zoom in 30× — points in the visible set are tiny so most
      // will pan out of the plot area. The component should still
      // render the chrome + axes.
      for (let i = 0; i < 30; i++) {
        fireEvent.wheel(svg as SVGSVGElement, {
          deltaY: -100,
          clientX: 160,
          clientY: 120,
        });
      }
      expect(screen.getByTestId('eig-scatter')).toBeInTheDocument();
      // Reset still restores the original view.
      fireEvent.click(screen.getByTestId('eig-scatter-zoom-reset'));
      expect(screen.getByTestId('eig-scatter-point-0')).toBeInTheDocument();
    });

    it('double-click on the SVG resets the view', () => {
      useAnalyzeStore.getState().setEigResult(RESULT);
      const { container } = render(<EIGScatter />);
      const svg = container.querySelector('svg');
      stubSvgRect(svg as SVGSVGElement);
      const cxBefore = Number(screen.getByTestId('eig-scatter-point-0').getAttribute('cx'));
      fireEvent.wheel(svg as SVGSVGElement, {
        deltaY: -100,
        clientX: 160,
        clientY: 120,
      });
      fireEvent.doubleClick(svg as SVGSVGElement);
      const cxReset = Number(screen.getByTestId('eig-scatter-point-0').getAttribute('cx'));
      expect(cxReset).toBe(cxBefore);
    });
  });

  describe('palette commands', () => {
    it('requestEigViewReset triggers reset on the mounted component', () => {
      useAnalyzeStore.getState().setEigResult(RESULT);
      const { container } = render(<EIGScatter />);
      const svg = container.querySelector('svg');
      stubSvgRect(svg as SVGSVGElement);
      const cxBefore = Number(screen.getByTestId('eig-scatter-point-0').getAttribute('cx'));
      fireEvent.wheel(svg as SVGSVGElement, {
        deltaY: -100,
        clientX: 160,
        clientY: 120,
      });
      act(() => {
        requestEigViewReset();
      });
      const cxReset = Number(screen.getByTestId('eig-scatter-point-0').getAttribute('cx'));
      expect(cxReset).toBe(cxBefore);
    });

    it('requestEigLogToggle flips data-x-scale', () => {
      useAnalyzeStore.getState().setEigResult(RESULT);
      render(<EIGScatter />);
      expect(screen.getByTestId('eig-scatter')).toHaveAttribute('data-x-scale', 'linear');
      act(() => {
        requestEigLogToggle();
      });
      expect(screen.getByTestId('eig-scatter')).toHaveAttribute('data-x-scale', 'log');
    });
  });

  describe('log scale', () => {
    it('toggle button switches data-x-scale + axis label', async () => {
      useAnalyzeStore.getState().setEigResult(RESULT);
      const { container } = render(<EIGScatter />);
      const user = userEvent.setup();
      const wrapper = screen.getByTestId('eig-scatter');
      expect(wrapper).toHaveAttribute('data-x-scale', 'linear');
      // Linear axis labelled "Re".
      expect(container.textContent).toContain('Re');

      await user.click(screen.getByTestId('eig-scatter-log-toggle'));
      expect(wrapper).toHaveAttribute('data-x-scale', 'log');
      // Log axis is labelled "log|Re|".
      const labels = container.querySelectorAll('text');
      const labelText = Array.from(labels).map((t) => t.textContent);
      expect(labelText).toContain('log|Re|');
    });

    it('shows a warning chip when growing modes (Re > 0) are visible', async () => {
      const withGrowing: EigResult = {
        eigenvalues: [
          { real: -0.1, imag: 2.0 }, // damped, visible
          { real: 0.2, imag: 1.5 }, // growing! Re > 0, damping < 0
        ],
        damping_ratios: [0.05, -0.13],
        frequencies_hz: [0.318, 0.239],
        mode_count: 2,
        state_count: 2,
        state_names: ['s0', 's1'],
        tds_initialized: true,
      };
      useAnalyzeStore.getState().setEigResult(withGrowing);
      // Widen the filter so both points stay visible.
      useAnalyzeStore.getState().setFilter({ dampingMax: 1.5, realAbsMax: 100 });
      render(<EIGScatter />);
      const user = userEvent.setup();
      // Linear scale → no warning chip.
      expect(screen.queryByTestId('eig-scatter-log-warning')).not.toBeInTheDocument();
      // Flip to log → chip surfaces.
      await user.click(screen.getByTestId('eig-scatter-log-toggle'));
      const chip = screen.getByTestId('eig-scatter-log-warning');
      expect(chip).toBeInTheDocument();
      expect(chip.textContent).toMatch(/growing/);
    });
  });

  describe('hover tooltip', () => {
    it('surfaces the tooltip near the cursor when over a point', () => {
      useAnalyzeStore.getState().setEigResult(RESULT);
      const { container } = render(<EIGScatter />);
      const svg = container.querySelector('svg') as SVGSVGElement;
      stubSvgRect(svg);
      // Move the cursor over point-0's pixel position by reading its
      // current cx/cy off the rendered <circle>.
      const circle = screen.getByTestId('eig-scatter-point-0');
      const cx = Number(circle.getAttribute('cx'));
      const cy = Number(circle.getAttribute('cy'));
      // jsdom's PointerEvent constructor doesn't always populate
      // clientX/clientY from the init dict; pass via mouse-style
      // coords too so React's synthetic event surface picks them up.
      fireEvent.pointerMove(svg, {
        clientX: cx,
        clientY: cy,
        pointerId: 1,
        pointerType: 'mouse',
      });
      const tip = screen.getByTestId('eig-scatter-tooltip');
      expect(tip).toBeInTheDocument();
      expect(tip).toHaveAttribute('data-mode-idx', '0');
      // Tooltip body shows λ + damping + frequency.
      expect(tip.textContent).toMatch(/λ\s*=/);
      expect(tip.textContent).toMatch(/ζ\s*=/);
      expect(tip.textContent).toMatch(/f\s*=/);
    });

    it('hides the tooltip when the pointer leaves the chart', () => {
      useAnalyzeStore.getState().setEigResult(RESULT);
      const { container } = render(<EIGScatter />);
      const svg = container.querySelector('svg') as SVGSVGElement;
      stubSvgRect(svg);
      const circle = screen.getByTestId('eig-scatter-point-0');
      const cx = Number(circle.getAttribute('cx'));
      const cy = Number(circle.getAttribute('cy'));
      fireEvent.pointerMove(svg, { clientX: cx, clientY: cy, pointerId: 1 });
      expect(screen.getByTestId('eig-scatter-tooltip')).toBeInTheDocument();
      fireEvent.pointerLeave(svg);
      expect(screen.queryByTestId('eig-scatter-tooltip')).not.toBeInTheDocument();
    });
  });

  // Plan callout: integration test "zoom state preserved when switching
  // sub-modes and back" doesn't fit cleanly because view state is local
  // to the component and resets on remount. Marked .todo so it stays
  // visible in the suite output until we lift the state into a slice
  // (KTD-15 — requires hoisting view state out of EIGScatter).
  it.todo('zoom state preserved when switching sub-modes and back');
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('computeViewport', () => {
  it('returns a 1×1 default for an empty point set', () => {
    expect(computeViewport([])).toEqual({
      xMin: -1,
      xMax: 1,
      yMin: -1,
      yMax: 1,
    });
  });
});

describe('signedLog10', () => {
  it('preserves sign and is roughly log of magnitude', () => {
    expect(signedLog10(100)).toBeCloseTo(2, 5);
    expect(signedLog10(-100)).toBeCloseTo(-2, 5);
    expect(signedLog10(1)).toBeCloseTo(0, 5);
  });

  it('clamps near-zero values to log10(EPSILON) instead of -Infinity', () => {
    expect(Number.isFinite(signedLog10(0))).toBe(true);
    expect(Number.isFinite(signedLog10(1e-12))).toBe(true);
  });
});
