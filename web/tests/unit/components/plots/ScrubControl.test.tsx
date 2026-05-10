/**
 * <ScrubControl /> tests.
 *
 * Approach: drives the real runs + plot stores so the scrub flow is
 * exercised end-to-end. Pointer interactions go through ``fireEvent``
 * (jsdom's PointerEvent path); the strip's bounding box is stubbed
 * via ``Element.prototype.getBoundingClientRect`` because jsdom's
 * default returns zeros, making clientX → t conversion deterministic.
 *
 * For the play/pause animation loop we monkey-patch
 * ``window.requestAnimationFrame`` / ``cancelAnimationFrame`` with a
 * manual scheduler — fake timers don't drive rAF in jsdom. The
 * scheduler exposes ``advanceMs(dt)`` which fires a single rAF
 * callback with the new timestamp, mirroring the way React's
 * scheduler would normally invoke it.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

// jsdom 25 ships without ``window.PointerEvent``. testing-library's
// ``fireEvent.pointerDown`` falls back to ``window.Event`` in that
// case — and a generic Event drops ``clientX``/``clientY`` from the
// init bag, so our coordinate-driven handlers see ``NaN``. Polyfill
// PointerEvent as a thin subclass of MouseEvent (carries clientX).
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

import { ScrubControl } from '@/components/plots/ScrubControl';
import { useRunsStore } from '@/store/runs';
import { usePlotStore } from '@/store/plot';

// ---- helpers --------------------------------------------------------------

const STRIP_WIDTH = 1000;
const STRIP_LEFT = 0;

/**
 * Stub ``getBoundingClientRect`` on the strip element. We patch the
 * prototype rather than the instance because the strip ref is set
 * inside React's effect timing and patching the instance pre-render
 * is awkward. The test scopes the patch to elements with the
 * ``data-testid="scrub-control-strip"`` attribute.
 */
function patchStripRect() {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (this.getAttribute('data-testid') === 'scrub-control-strip') {
      return {
        x: STRIP_LEFT,
        y: 0,
        left: STRIP_LEFT,
        top: 0,
        right: STRIP_LEFT + STRIP_WIDTH,
        bottom: 28,
        width: STRIP_WIDTH,
        height: 28,
        toJSON: () => ({}),
      };
    }
    return original.call(this);
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

/** Convert a target sim time (with tMax === 10) into a clientX. */
function clientXForT(t: number, tMax: number): number {
  return STRIP_LEFT + (t / tMax) * STRIP_WIDTH;
}

/**
 * Manual rAF scheduler: replaces requestAnimationFrame so the test
 * controls when callbacks fire and at what timestamp. ``advanceMs``
 * runs the most recently queued callback once.
 */
function installRafScheduler() {
  let nextHandle = 1;
  let pending: { handle: number; cb: FrameRequestCallback } | null = null;
  let now = 0;
  const origRaf = window.requestAnimationFrame;
  const origCaf = window.cancelAnimationFrame;
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const handle = nextHandle++;
    pending = { handle, cb };
    return handle;
  };
  window.cancelAnimationFrame = (handle: number) => {
    if (pending && pending.handle === handle) pending = null;
  };
  const advanceMs = (dt: number) => {
    now += dt;
    const p = pending;
    pending = null;
    if (p) {
      act(() => {
        p.cb(now);
      });
    }
  };
  const restore = () => {
    window.requestAnimationFrame = origRaf;
    window.cancelAnimationFrame = origCaf;
  };
  return { advanceMs, restore, hasPending: () => pending !== null };
}

function seedRun(runId: string, tf: number, columnNames: string[] = ['Bus_1_v']) {
  useRunsStore.setState({ runs: {}, activeRunId: null });
  useRunsStore.getState().startRun({ runId, tf, columnNames });
}

function appendRows(runId: string, t: number[], cols: Record<string, number[]>) {
  const tArr = new Float64Array(t);
  const colArrs: Record<string, Float64Array> = {};
  for (const k of Object.keys(cols)) colArrs[k] = new Float64Array(cols[k]!);
  useRunsStore.getState().appendFrame(runId, { t: tArr, columns: colArrs });
}

// ---- tests ----------------------------------------------------------------

describe('ScrubControl', () => {
  let restoreRect: () => void;

  beforeEach(() => {
    useRunsStore.setState({ runs: {}, activeRunId: null });
    usePlotStore.setState({
      selectedByRun: {},
      filterByRun: {},
      expandedByRun: {},
      scrubByRun: {},
      playingByRun: {},
    });
    restoreRect = patchStripRect();
  });

  afterEach(() => {
    cleanup();
    restoreRect();
  });

  it('renders the empty state when no run is active', () => {
    const { getByTestId, queryByTestId } = render(<ScrubControl />);
    expect(getByTestId('scrub-control-empty')).toHaveTextContent('No active run');
    expect(queryByTestId('scrub-control-strip')).toBeNull();
  });

  it('mounts in live mode (scrubT === null) with cursor at the right edge', () => {
    seedRun('r1', 10);
    appendRows('r1', [0, 1, 2, 3, 4, 5], { Bus_1_v: [1, 1, 1, 1, 1, 1] });
    const { getByTestId } = render(<ScrubControl />);
    const root = getByTestId('scrub-control');
    // Live: data-live="true", scrubT empty.
    expect(root).toHaveAttribute('data-live', 'true');
    expect(root.getAttribute('data-scrub-t')).toBe('');
    // Cursor visible (we have buffered data).
    const cursor = getByTestId('scrub-control-cursor');
    // cursorRatio = 1 (live → cursorT === tMax === 5; tMax === 5).
    expect(cursor.style.left).toBe('100%');
  });

  it('renders disabled-looking strip when buffered range is 0 (no frames yet)', () => {
    seedRun('r1', 10);
    const { getByTestId, queryByTestId } = render(<ScrubControl />);
    // Strip mounts, but cursor element absent (isEmptyRange branch).
    expect(getByTestId('scrub-control-strip')).toBeInTheDocument();
    expect(queryByTestId('scrub-control-cursor')).toBeNull();
    // Play button disabled.
    expect(getByTestId('scrub-control-play')).toBeDisabled();
  });

  it('clicking the middle of the strip sets scrubT to the middle of the buffered range', () => {
    seedRun('r1', 10);
    appendRows('r1', [0, 2, 4, 6, 8, 10], { Bus_1_v: [1, 1, 1, 1, 1, 1] });
    const { getByTestId } = render(<ScrubControl />);
    const strip = getByTestId('scrub-control-strip');
    fireEvent.pointerDown(strip, { clientX: clientXForT(5, 10), pointerId: 1 });
    fireEvent.pointerUp(strip, { clientX: clientXForT(5, 10), pointerId: 1 });
    const scrub = usePlotStore.getState().scrubByRun['r1'];
    expect(scrub).not.toBeNull();
    expect(scrub).toBeCloseTo(5, 5);
  });

  it('drag updates scrubT continuously across pointer moves', () => {
    seedRun('r1', 10);
    appendRows('r1', [0, 2, 4, 6, 8, 10], { Bus_1_v: [1, 1, 1, 1, 1, 1] });
    const { getByTestId } = render(<ScrubControl />);
    const strip = getByTestId('scrub-control-strip');
    fireEvent.pointerDown(strip, { clientX: clientXForT(2, 10), pointerId: 1 });
    expect(usePlotStore.getState().scrubByRun['r1']).toBeCloseTo(2, 5);
    fireEvent.pointerMove(strip, { clientX: clientXForT(4, 10), pointerId: 1 });
    expect(usePlotStore.getState().scrubByRun['r1']).toBeCloseTo(4, 5);
    fireEvent.pointerMove(strip, { clientX: clientXForT(7, 10), pointerId: 1 });
    expect(usePlotStore.getState().scrubByRun['r1']).toBeCloseTo(7, 5);
    // Release at 7 → not within snap-to-live window (>=98% of tMax) so
    // scrubT stays at 7.
    fireEvent.pointerUp(strip, { clientX: clientXForT(7, 10), pointerId: 1 });
    expect(usePlotStore.getState().scrubByRun['r1']).toBeCloseTo(7, 5);
  });

  it('releasing near the right edge returns to live mode (scrubT === null)', () => {
    seedRun('r1', 10);
    appendRows('r1', [0, 2, 4, 6, 8, 10], { Bus_1_v: [1, 1, 1, 1, 1, 1] });
    const { getByTestId } = render(<ScrubControl />);
    const strip = getByTestId('scrub-control-strip');
    fireEvent.pointerDown(strip, { clientX: clientXForT(5, 10), pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: clientXForT(9.95, 10), pointerId: 1 });
    fireEvent.pointerUp(strip, { clientX: clientXForT(9.95, 10), pointerId: 1 });
    expect(usePlotStore.getState().scrubByRun['r1']).toBeNull();
  });

  it('shows the Live button only when scrubbed (scrubT !== null) and resets on click', () => {
    seedRun('r1', 10);
    appendRows('r1', [0, 5, 10], { Bus_1_v: [1, 1, 1] });
    const { getByTestId, queryByTestId, rerender } = render(<ScrubControl />);
    // Live mode → no Live button.
    expect(queryByTestId('scrub-control-live')).toBeNull();
    act(() => {
      usePlotStore.getState().setScrubT('r1', 5);
    });
    rerender(<ScrubControl />);
    expect(getByTestId('scrub-control-live')).toBeInTheDocument();
    fireEvent.click(getByTestId('scrub-control-live'));
    expect(usePlotStore.getState().scrubByRun['r1']).toBeNull();
  });

  it('clicking play starts the rAF loop that advances scrubT at the given playback rate', () => {
    seedRun('r1', 10);
    appendRows('r1', [0, 1, 2, 3, 4, 5], { Bus_1_v: [1, 1, 1, 1, 1, 1] });
    const sched = installRafScheduler();
    try {
      const { getByTestId } = render(<ScrubControl playbackRate={1.0} />);
      // Click play. scrubT was null → playback starts at 0.
      fireEvent.click(getByTestId('scrub-control-play'));
      expect(usePlotStore.getState().playingByRun['r1']).toBe(true);
      expect(usePlotStore.getState().scrubByRun['r1']).toBe(0);
      // First rAF: timestamp 0 — initialises lastTs but doesn't advance.
      sched.advanceMs(0);
      // Advance 100 ms wall-clock → scrubT should advance ~0.1 sim-s
      // (rate = 1.0 sim-s per wall-s).
      sched.advanceMs(100);
      const after = usePlotStore.getState().scrubByRun['r1'];
      expect(after).toBeCloseTo(0.1, 5);
      // Another 200 ms → 0.3 sim-s total.
      sched.advanceMs(200);
      expect(usePlotStore.getState().scrubByRun['r1']).toBeCloseTo(0.3, 5);
    } finally {
      sched.restore();
    }
  });

  it('clicking pause stops the rAF loop and leaves scrubT in place', () => {
    seedRun('r1', 10);
    appendRows('r1', [0, 1, 2, 3, 4, 5], { Bus_1_v: [1, 1, 1, 1, 1, 1] });
    const sched = installRafScheduler();
    try {
      const { getByTestId } = render(<ScrubControl playbackRate={1.0} />);
      fireEvent.click(getByTestId('scrub-control-play'));
      sched.advanceMs(0);
      sched.advanceMs(500);
      const beforePause = usePlotStore.getState().scrubByRun['r1']!;
      expect(beforePause).toBeCloseTo(0.5, 5);
      fireEvent.click(getByTestId('scrub-control-play')); // pause
      expect(usePlotStore.getState().playingByRun['r1']).toBe(false);
      // After pause, no more pending rAF (cleanup ran).
      expect(sched.hasPending()).toBe(false);
      expect(usePlotStore.getState().scrubByRun['r1']).toBeCloseTo(beforePause, 5);
    } finally {
      sched.restore();
    }
  });

  it('playback stops when scrubT reaches tCurrent (no looping)', () => {
    seedRun('r1', 10);
    appendRows('r1', [0, 0.5, 1.0], { Bus_1_v: [1, 1, 1] });
    const sched = installRafScheduler();
    try {
      const { getByTestId } = render(<ScrubControl playbackRate={1.0} />);
      fireEvent.click(getByTestId('scrub-control-play'));
      sched.advanceMs(0);
      // Run far past tCurrent (1.0).
      sched.advanceMs(2000);
      expect(usePlotStore.getState().playingByRun['r1']).toBe(false);
      // Cursor pinned at the head (1.0).
      expect(usePlotStore.getState().scrubByRun['r1']).toBeCloseTo(1.0, 5);
      // No further callbacks scheduled.
      expect(sched.hasPending()).toBe(false);
    } finally {
      sched.restore();
    }
  });

  it('cancels the rAF loop on unmount', () => {
    seedRun('r1', 10);
    appendRows('r1', [0, 1, 2], { Bus_1_v: [1, 1, 1] });
    const sched = installRafScheduler();
    try {
      const { getByTestId, unmount } = render(<ScrubControl playbackRate={1.0} />);
      fireEvent.click(getByTestId('scrub-control-play'));
      sched.advanceMs(0);
      expect(sched.hasPending()).toBe(true);
      unmount();
      expect(sched.hasPending()).toBe(false);
    } finally {
      sched.restore();
    }
  });

  it('honours an explicit runId prop over the active run from the store', () => {
    seedRun('active-run', 5);
    appendRows('active-run', [0, 1, 2], { Bus_1_v: [1, 1, 1] });
    useRunsStore.getState().startRun({ runId: 'other-run', tf: 8, columnNames: ['Bus_2_v'] });
    appendRows('other-run', [0, 4], { Bus_2_v: [1, 1] });
    const { getByTestId } = render(<ScrubControl runId="other-run" />);
    expect(getByTestId('scrub-control')).toHaveAttribute('data-run-id', 'other-run');
  });

  it('time display renders cursorT / tf in M:SS.mmm format', () => {
    seedRun('r1', 10);
    appendRows('r1', [0, 2.5], { Bus_1_v: [1, 1] });
    usePlotStore.getState().setScrubT('r1', 1.234);
    const { getByTestId } = render(<ScrubControl />);
    const time = getByTestId('scrub-control-time');
    // cursorT = 1.234 → "0:01.234"; tf = 10 → "0:10.000".
    expect(time.textContent).toContain('0:01.234');
    expect(time.textContent).toContain('0:10.000');
  });

  it('cursor position handles scrubT > tMax (run extended after seek)', () => {
    seedRun('r1', 10);
    appendRows('r1', [0, 2, 4], { Bus_1_v: [1, 1, 1] });
    // User scrubbed to t=20 (past everything).
    usePlotStore.getState().setScrubT('r1', 20);
    const { getByTestId } = render(<ScrubControl />);
    const cursor = getByTestId('scrub-control-cursor');
    // Clamped to 100 % so the cursor sticks at the right edge of the strip.
    expect(cursor.style.left).toBe('100%');
  });
});
