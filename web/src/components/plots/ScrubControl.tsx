/**
 * Custom timeline-strip scrub control.
 *
 * Drives a shared ``scrubT`` value (in ``usePlotStore``) that the
 * TimeSeriesPlot cursor + SLD overlay both subscribe to. ``scrubT``
 * is null → live mode (cursor follows incoming frames at run.tCurrent);
 * a number → scrub mode (cursor pinned to that t).
 *
 * Why a custom strip rather than a Radix Slider:
 *   The plan's "Open Questions" settled on a custom timeline strip
 *   because Radix Slider UX feels wrong for a continuous time domain
 *   with potentially thousands of buffered frames. The strip directly
 *   visualises the buffered range (filled bar) and uses a draggable
 *   cursor (vertical line) so the user sees what range is actually
 *   replay-able.
 *
 * Layout:
 *  - Horizontal strip ~28px tall.
 *  - Background = neutral track.
 *  - Filled portion from t=0 to t=tCurrent shows the buffered range.
 *  - Vertical cursor line at scrubT (or at tCurrent in live mode).
 *  - Play/pause button to the left of the strip.
 *  - Current time / total time display to the right.
 *
 * Interaction:
 *  - Click anywhere on the strip → seek (sets scrubT to that t).
 *  - Pointerdown + drag on the strip → scrubT updates continuously
 *    until pointerup. Capture the pointer so the drag survives the
 *    pointer leaving the strip bounds.
 *  - Play → start a requestAnimationFrame loop that advances scrubT
 *    at 1× wall-clock rate (1 sim-second per second). Stops at tCurrent
 *    (the latest buffered frame). Pause → cancel the loop, leave scrubT
 *    where it is.
 *
 * Live mode:
 *  - Resume-live button reappears whenever scrubT is non-null. Click
 *    sets scrubT back to null. Releasing the drag cursor at the right
 *    edge also returns to live mode (matches the plan's "click the
 *    rightmost edge" affordance).
 *
 * Animation loop cleanup:
 *  - The rAF handle is held in a ref. The play-effect tears down via
 *    cancelAnimationFrame in its cleanup so unmounting (or pausing)
 *    cancels in-flight frames cleanly.
 *
 * Accessibility / pointer events:
 *  - Uses native pointer events (pointerdown/move/up + setPointerCapture).
 *    Pointer events normalise mouse + touch + pen on desktop browsers,
 *    matching the plan's "pointer events work on both mouse + touch"
 *    constraint. Dedicated mobile touch UX is deferred.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useRunsStore } from '@/store/runs';
import { usePlotStore } from '@/store/plot';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

export interface ScrubControlProps {
  /**
   * Optional run id override. Defaults to the active run from the runs
   * store. Tests pass an explicit value to bypass the store coupling.
   */
  runId?: string;
  /** Optional class on the wrapper. */
  className?: string;
  /**
   * Playback rate (sim-seconds per wall-clock-second). Defaults to 1.0.
   * Adjustable in v0.5; exposed here so tests can pin a deterministic rate.
   */
  playbackRate?: number;
}

/**
 * Format a t value (seconds) as ``M:SS.mmm`` for the time display.
 * For sub-second sims the minute prefix collapses to "0:".
 */
function formatTime(t: number): string {
  if (!Number.isFinite(t)) return '--';
  const sign = t < 0 ? '-' : '';
  const abs = Math.abs(t);
  const m = Math.floor(abs / 60);
  const s = abs - m * 60;
  // Pad seconds to 2 digits before the decimal so "1.234" → "01.234".
  const sStr = s.toFixed(3).padStart(6, '0');
  return `${sign}${m}:${sStr}`;
}

export function ScrubControl({ runId, className, playbackRate = 1.0 }: ScrubControlProps) {
  const activeRunId = useRunsStore((s) => s.activeRunId);
  const effectiveRunId = runId ?? activeRunId;
  const run = useRunsStore((s) => (effectiveRunId ? s.runs[effectiveRunId] : undefined));

  const scrubT = usePlotStore((s) =>
    effectiveRunId ? (s.scrubByRun[effectiveRunId] ?? null) : null,
  );
  const playing = usePlotStore((s) =>
    effectiveRunId ? (s.playingByRun[effectiveRunId] ?? false) : false,
  );
  const setScrubT = usePlotStore((s) => s.setScrubT);
  const setPlaying = usePlotStore((s) => s.setPlaying);

  const stripRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const tMax = run?.tCurrent ?? 0;
  const seqCount = run?.seqCount ?? 0;
  // What the cursor actually shows: in live mode (scrubT === null)
  // we render at tMax; in scrub mode we render at scrubT (which can
  // be anywhere — including past tMax if the run hasn't reached it).
  const cursorT = scrubT ?? tMax;

  // ---- pointer handling ---------------------------------------------------

  /**
   * Convert a clientX into a sim-time using the strip's bounding box.
   * Clamps to [0, tMax] so a click outside the strip's right edge maps
   * to live (tMax), not to t > tMax. Returns null when the strip is
   * unmounted or when the run has no buffered range yet.
   */
  const tFromClientX = useCallback(
    (clientX: number): number | null => {
      const el = stripRef.current;
      if (!el) return null;
      if (tMax <= 0) return null;
      const rect = el.getBoundingClientRect();
      const width = rect.width;
      if (width <= 0) return null;
      const x = clientX - rect.left;
      const ratio = Math.min(1, Math.max(0, x / width));
      return ratio * tMax;
    },
    [tMax],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!effectiveRunId) return;
      if (tMax <= 0) return;
      const t = tFromClientX(e.clientX);
      if (t === null) return;
      draggingRef.current = true;
      // Pause playback when the user grabs the cursor; matches the
      // user's expectation that scrubbing wins over auto-play.
      setPlaying(effectiveRunId, false);
      setScrubT(effectiveRunId, t);
      // Capture so move/up events keep flowing even if the pointer
      // exits the strip's bounding box.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // jsdom + some legacy browsers throw; non-fatal — drag still
        // works via the global move/up handlers attached below.
      }
    },
    [effectiveRunId, tMax, tFromClientX, setPlaying, setScrubT],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      if (!effectiveRunId) return;
      const t = tFromClientX(e.clientX);
      if (t === null) return;
      setScrubT(effectiveRunId, t);
    },
    [effectiveRunId, tFromClientX, setScrubT],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Best-effort.
      }
      if (!effectiveRunId) return;
      // Snap-to-live if the user released within the last 2% of the strip.
      // Mirrors the plan's "click the rightmost edge → resume live" affordance.
      const t = tFromClientX(e.clientX);
      if (t !== null && tMax > 0 && t / tMax >= 0.98) {
        setScrubT(effectiveRunId, null);
      }
    },
    [effectiveRunId, tMax, tFromClientX, setScrubT],
  );

  // ---- play/pause + animation loop ----------------------------------------

  const onPlayPause = useCallback(() => {
    if (!effectiveRunId) return;
    if (tMax <= 0) return;
    if (playing) {
      setPlaying(effectiveRunId, false);
      return;
    }
    // If we're in live mode (scrubT === null) and click play, start
    // playback from the start of the buffer. This is the only sensible
    // interpretation — playback from "live" is a no-op (cursor would
    // already be at tMax). Same for scrubT at the end.
    const startT = scrubT === null || scrubT >= tMax ? 0 : scrubT;
    setScrubT(effectiveRunId, startT);
    setPlaying(effectiveRunId, true);
  }, [effectiveRunId, tMax, playing, scrubT, setPlaying, setScrubT]);

  const onResumeLive = useCallback(() => {
    if (!effectiveRunId) return;
    setPlaying(effectiveRunId, false);
    setScrubT(effectiveRunId, null);
  }, [effectiveRunId, setPlaying, setScrubT]);

  // The animation loop. Effect activates whenever ``playing`` flips
  // true; cleanup cancels the in-flight rAF so unmounting (or pausing)
  // tears down cleanly.
  useEffect(() => {
    if (!playing) return undefined;
    if (!effectiveRunId) return undefined;
    let raf = 0;
    // Use ``null`` (not 0) as the "uninitialised" sentinel so a first
    // rAF callback with ts === 0 (which our test scheduler starts at)
    // doesn't get re-treated as uninitialised on the next tick.
    let lastTs: number | null = null;
    const tick = (ts: number) => {
      // Read the latest scrub + tMax INSIDE the rAF callback. Capturing
      // them in the effect closure would freeze them at effect-mount
      // time; we want each tick to see live values (frames may still
      // be streaming in alongside playback).
      const state = usePlotStore.getState();
      const runState = useRunsStore.getState().runs[effectiveRunId];
      const currentScrub = state.scrubByRun[effectiveRunId] ?? 0;
      const ceiling = runState?.tCurrent ?? 0;
      if (lastTs === null) {
        // First tick: just record the timestamp so dt is meaningful on
        // the next call. Don't advance scrubT — that would waste any
        // sub-frame time the browser took to start the loop.
        lastTs = ts;
        raf = requestAnimationFrame(tick);
        return;
      }
      const dtMs = ts - lastTs;
      lastTs = ts;
      const next = currentScrub + (dtMs / 1000) * playbackRate;
      if (next >= ceiling) {
        // Reached the end of the buffer: pin the cursor to ceiling and
        // pause. The user can press play again to resume from 0 (or
        // wherever they re-seek).
        state.setScrubT(effectiveRunId, ceiling);
        state.setPlaying(effectiveRunId, false);
        return;
      }
      state.setScrubT(effectiveRunId, next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [playing, effectiveRunId, playbackRate]);

  // ---- render -------------------------------------------------------------

  if (!effectiveRunId || !run) {
    return (
      <div
        data-testid="scrub-control-empty"
        className={cn(
          'border-border text-muted-foreground flex h-12 w-full items-center justify-center rounded border text-xs',
          className,
        )}
      >
        No active run
      </div>
    );
  }

  // Buffered fill ratio: empty strip when the run hasn't received any
  // frames yet (tMax === 0); strip fills as frames arrive.
  const bufferedRatio = tMax > 0 ? 1 : 0;
  // Cursor position: clamped to [0, 1] for rendering; cursorT can exceed
  // tMax in the edge case where the user scrubbed past the end and the
  // run hasn't caught up — the cursor stays parked at the right edge.
  const cursorRatio = tMax > 0 ? Math.min(1, Math.max(0, cursorT / tMax)) : 0;

  const isLive = scrubT === null;
  const isEmptyRange = tMax === 0;

  return (
    <div
      data-testid="scrub-control"
      data-run-id={effectiveRunId}
      data-live={isLive}
      data-playing={playing}
      data-scrub-t={scrubT === null ? '' : String(scrubT)}
      className={cn('flex w-full items-center gap-2', className)}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onPlayPause}
        disabled={isEmptyRange}
        aria-label={playing ? 'Pause' : 'Play'}
        data-testid="scrub-control-play"
      >
        {/* Inline glyph keeps the bundle free of an icon-set dep. */}
        {playing ? (
          <span aria-hidden="true" className="font-mono text-sm">
            ||
          </span>
        ) : (
          <span aria-hidden="true" className="font-mono text-sm">
            ▶
          </span>
        )}
      </Button>
      <div
        ref={stripRef}
        role="slider"
        aria-label="Scrub timeline"
        aria-valuemin={0}
        aria-valuemax={tMax || 0}
        aria-valuenow={cursorT}
        aria-disabled={isEmptyRange}
        tabIndex={isEmptyRange ? -1 : 0}
        data-testid="scrub-control-strip"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={cn(
          'border-border bg-muted relative h-7 flex-1 cursor-pointer touch-none overflow-hidden rounded border select-none',
          isEmptyRange && 'pointer-events-none cursor-default opacity-60',
        )}
      >
        {/* Buffered range fill. */}
        <div
          data-testid="scrub-control-buffered"
          className="bg-primary/20 pointer-events-none absolute inset-y-0 left-0"
          style={{ width: `${bufferedRatio * 100}%` }}
        />
        {/* Cursor line. */}
        {!isEmptyRange && (
          <div
            data-testid="scrub-control-cursor"
            className="bg-primary pointer-events-none absolute top-0 bottom-0 w-[2px] -translate-x-[1px]"
            style={{ left: `${cursorRatio * 100}%` }}
          />
        )}
      </div>
      <div
        data-testid="scrub-control-time"
        className="text-muted-foreground min-w-[7.5rem] text-right font-mono text-xs tabular-nums"
      >
        {formatTime(cursorT)} / {formatTime(run.tf || tMax)}
      </div>
      {!isLive && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onResumeLive}
          data-testid="scrub-control-live"
        >
          Live
        </Button>
      )}
      {/* Frame-count debug attribute (testing convenience). */}
      <span data-testid="scrub-control-seq" className="sr-only">
        {seqCount}
      </span>
    </div>
  );
}
