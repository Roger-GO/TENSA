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
 *  - Current time / total time display to the right, with a one-line
 *    status under it (Playing at 10×, Paused, End of run, ...), then the
 *    speed selector.
 *
 * Interaction:
 *  - Click anywhere on the strip → seek (sets scrubT to that t).
 *  - Pointerdown + drag on the strip → scrubT updates continuously
 *    until pointerup. Capture the pointer so the drag survives the
 *    pointer leaving the strip bounds.
 *  - Play → start a requestAnimationFrame loop that advances scrubT
 *    at the selected speed (``playbackRate`` in the plot store: 1× is
 *    1 sim-second per wall-clock second, the selector offers 0.25× to
 *    10×). Stops at tCurrent (the latest buffered frame), where the
 *    button becomes Replay and the status says the run has ended, so a
 *    fast speed that gets there in a second is not mistaken for a pause.
 *    Pause → cancel the loop, leave scrubT where it is.
 *  - Changing the speed while playing takes effect on the next frame,
 *    from where the cursor is: the loop reads the rate each tick rather
 *    than restarting.
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
 *  - The status line is a polite live region, so a change of speed or
 *    the end of playback is announced as well as shown.
 *  - Uses native pointer events (pointerdown/move/up + setPointerCapture).
 *    Pointer events normalise mouse + touch + pen on desktop browsers,
 *    matching the plan's "pointer events work on both mouse + touch"
 *    constraint. Dedicated mobile touch UX is deferred.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useRunsStore } from '@/store/runs';
import { PLAYBACK_RATES, usePlotStore } from '@/store/plot';
import { usePlotRunId } from './overlayRuns';
import { Button } from '@/components/ui/button';
import { ExportMenu } from '@/components/export/ExportMenu';
import { useExportCaseName } from '@/components/export/useExportCaseName';
import { RUN_VALUES_UNITS_COMMENT, timeSeriesToCsv } from '@/components/export/exportToCsv';
import { exportRunToComtrade } from '@/components/export/exportToComtrade';
import { cn } from '@/lib/cn';

/** What the run's data exports as: every column, as text or as a COMTRADE record. */
const RUN_DATA_FORMATS = ['csv', 'comtrade'] as const;

export interface ScrubControlProps {
  /**
   * Optional run id override. Defaults to the active run from the runs
   * store. Tests pass an explicit value to bypass the store coupling.
   */
  runId?: string;
  /** Optional class on the wrapper. */
  className?: string;
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

export function ScrubControl({ runId, className }: ScrubControlProps) {
  const effectiveRunId = usePlotRunId(runId);
  const run = useRunsStore((s) => (effectiveRunId ? s.runs[effectiveRunId] : undefined));
  const caseName = useExportCaseName();

  const scrubT = usePlotStore((s) =>
    effectiveRunId ? (s.scrubByRun[effectiveRunId] ?? null) : null,
  );
  const playing = usePlotStore((s) =>
    effectiveRunId ? (s.playingByRun[effectiveRunId] ?? false) : false,
  );
  const playbackRate = usePlotStore((s) => s.playbackRate);
  const setScrubT = usePlotStore((s) => s.setScrubT);
  const setPlaying = usePlotStore((s) => s.setPlaying);
  const setPlaybackRate = usePlotStore((s) => s.setPlaybackRate);

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
      // The rate is read here too, so a change of speed mid-playback
      // applies from the next frame without tearing the loop down (which
      // would drop a frame's worth of time).
      const rate = state.playbackRate;
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
      const next = currentScrub + (dtMs / 1000) * rate;
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
  }, [playing, effectiveRunId]);

  // ---- render -------------------------------------------------------------

  // CSV export over the entire run buffer (not just the scrubbed
  // window) — the scrub control's role is timeline replay, but a CSV
  // dump of the underlying data is the natural "give me the data
  // behind this control" affordance. PNG isn't meaningful for the
  // timeline strip itself.
  const onExportCsv = useCallback(() => {
    if (!run) return null;
    const len = run.seqCount;
    if (len === 0) return null;
    const tSlice = run.t.subarray(0, len);
    const cols: Record<string, ArrayLike<number>> = {};
    for (const name of run.columnNames) {
      const col = run.columns[name];
      if (!col) continue;
      cols[name] = col.subarray(0, len);
    }
    const droppedRowCount = run.connection === 'lagged' ? 1 : undefined;
    return timeSeriesToCsv({
      t: tSlice,
      columns: cols,
      droppedRowCount,
      comments: [RUN_VALUES_UNITS_COMMENT],
    });
  }, [run]);

  // The same columns as a COMTRADE record (IEEE C37.111), which the substrate
  // writes from the samples sent to it: the form fault-record viewers read.
  const onExportComtrade = useCallback(
    () => (run ? exportRunToComtrade(run, run.columnNames) : null),
    [run],
  );

  if (!effectiveRunId || !run) {
    return (
      <div
        data-testid="scrub-control-empty"
        className={cn(
          'border-border text-muted-foreground flex h-12 w-full items-center justify-center gap-2 rounded border text-xs',
          className,
        )}
      >
        <span>No active run</span>
        <ExportMenu formats={RUN_DATA_FORMATS} disabled panel="scrub" label="Export run data" />
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
  // Playback ran into the end of the buffer and stopped there. For a run that
  // is still streaming that is only the latest frame, not the end of the run.
  const runStreaming = run.state === 'starting' || run.state === 'streaming';
  const atEnd = scrubT !== null && !playing && !isEmptyRange && scrubT >= tMax;

  // What the transport is doing, in words. The play button flipping back from
  // Pause is the only other sign that playback stopped, and a change of speed
  // would otherwise show nowhere but in the selector.
  let status: string;
  if (playing) status = `Playing at ${playbackRate}×`;
  else if (isEmptyRange) status = runStreaming ? 'Waiting for data' : 'No data';
  else if (atEnd) status = runStreaming ? 'Caught up with the run' : 'End of run';
  else if (isLive) status = runStreaming ? 'Live' : 'Press Play to replay';
  else status = 'Paused';

  const playLabel = playing ? 'Pause' : atEnd ? 'Replay' : 'Play';
  let playTitle: string;
  if (isEmptyRange) playTitle = 'Nothing to play yet: the run has no data';
  else if (playing) playTitle = 'Pause playback';
  else if (atEnd) playTitle = 'Replay from the start';
  else if (isLive) playTitle = 'Play the run from the start';
  else playTitle = 'Continue playing from the cursor';

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
        aria-label={playLabel}
        title={playTitle}
        data-testid="scrub-control-play"
      >
        {/* Inline glyph keeps the bundle free of an icon-set dep. */}
        <span aria-hidden="true" className="font-mono text-sm">
          {playing ? '||' : atEnd ? '↻' : '▶'}
        </span>
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
      <div className="text-muted-foreground flex min-w-[7.5rem] flex-col items-end leading-tight">
        <div data-testid="scrub-control-time" className="font-mono text-xs tabular-nums">
          {formatTime(cursorT)} / {formatTime(run.tf || tMax)}
        </div>
        <div
          role="status"
          data-testid="scrub-control-status"
          className={cn('text-[11px] whitespace-nowrap', playing && 'text-foreground')}
        >
          {status}
        </div>
      </div>
      <label className="text-muted-foreground flex items-center gap-1 text-xs">
        <span>Speed</span>
        <select
          aria-label="Playback speed"
          title="Playback speed, in simulated seconds per second: 1× is real time, 10× plays a 10 s run in 1 s. Changing it while playing carries on from where the cursor is."
          data-testid="scrub-control-speed"
          value={playbackRate}
          onChange={(e) => setPlaybackRate(Number(e.target.value))}
          className={cn(
            'bg-background border-border text-foreground h-7 rounded border px-1 font-mono text-xs',
            'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          )}
        >
          {PLAYBACK_RATES.map((rate) => (
            <option key={rate} value={rate}>
              {rate}×
            </option>
          ))}
        </select>
      </label>
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
      <ExportMenu
        formats={RUN_DATA_FORMATS}
        label="Export run data"
        disabled={isEmptyRange}
        panel="scrub"
        // A run kept from another case is named for its own case.
        caseName={run.caseName ?? caseName}
        runId={effectiveRunId}
        onExportCsv={onExportCsv}
        onExportComtrade={onExportComtrade}
      />
      {/* Frame-count debug attribute (testing convenience). */}
      <span data-testid="scrub-control-seq" className="sr-only">
        {seqCount}
      </span>
    </div>
  );
}
