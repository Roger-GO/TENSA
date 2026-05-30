/**
 * SweepProgressPanel — Unit 18 of the v2.0 plan.
 *
 * Renders an in-progress sweep's iteration list and live progress bar.
 * Owns the WS subscription via ``SweepStream`` for the duration of
 * the sweep; on mount it opens the WS, on unmount it disposes the
 * stream cleanly.
 *
 * Embedded inside the HistoryDrawer (per the Unit 18 spec). Surfaces
 * a compact representation: which sweep is running + progress count +
 * scrollable per-iteration table (parameter value, converged?, final_t,
 * error).
 */
import { useEffect, useRef } from 'react';
import { useSweepStore } from '@/store/sweep';
import { useSessionStore } from '@/store/session';
import { useAuthStore } from '@/store/auth';
import { SweepStream } from '@/streaming/SweepStream';
import { buildRunStreamWsUrl } from '@/streaming/wsUrl';
import { cn } from '@/lib/cn';

export function SweepProgressPanel() {
  const activeSweepId = useSweepStore((s) => s.activeSweepId);
  const sweeps = useSweepStore((s) => s.sweeps);
  const sweep = activeSweepId ? sweeps[activeSweepId] : null;

  const sessionId = useSessionStore((s) => s.sessionId);
  const token = useAuthStore((s) => s.token);
  // No-auth: empty token is accepted by the WS auth frame.
  const authDisabled = useAuthStore((s) => s.authDisabled);

  const appendIteration = useSweepStore((s) => s.appendIteration);
  const markFinished = useSweepStore((s) => s.markSweepFinished);

  // Hold the stream in a ref so the cleanup path can dispose it
  // without re-running on every iteration tick.
  const streamRef = useRef<SweepStream | null>(null);

  useEffect(() => {
    if (!sweep || (sweep.state !== 'pending' && sweep.state !== 'running')) return;
    if (!sessionId || (token === null && !authDisabled)) return;
    const stream = new SweepStream({
      sessionId,
      sweepId: sweep.sweepId,
      token: token ?? '',
      wsUrl: buildRunStreamWsUrl(),
      onIteration: (iter) => {
        appendIteration(sweep.sweepId, iter);
      },
      onFinished: (event) => {
        markFinished(sweep.sweepId, event.state, {
          error: event.error ?? null,
        });
      },
      onError: (err) => {
        // Surface the substrate-side error onto the sweep record so
        // the UI shows it without burying it in console logs.
        markFinished(sweep.sweepId, 'error', {
          error: { category: err.code, detail: err.reason },
        });
      },
    });
    stream.start();
    streamRef.current = stream;
    return () => {
      stream.dispose();
      streamRef.current = null;
    };
    // ``sweep.state`` is intentionally NOT in the dep list — the
    // stream's terminal events drive state changes; we don't want to
    // re-create the stream when state flips from running → completed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sweep?.sweepId, sessionId, token, authDisabled, appendIteration, markFinished]);

  if (!sweep) {
    return (
      <div
        data-testid="sweep-progress-empty"
        className="text-muted-foreground p-2 text-center text-xs"
      >
        No sweep in progress.
      </div>
    );
  }

  const completed = sweep.iterations.length;
  const total = sweep.total;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div
      data-testid="sweep-progress-panel"
      data-sweep-id={sweep.sweepId}
      data-sweep-state={sweep.state}
      className="flex flex-col gap-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-foreground text-xs font-medium">Sweep · {sweep.parameterKind}</span>
        <span className="text-muted-foreground text-xs">
          {completed}/{total} ({percent}%)
        </span>
      </div>
      <div className="bg-muted/40 h-2 w-full overflow-hidden rounded" aria-label="sweep progress">
        <div
          data-testid="sweep-progress-bar"
          className={cn(
            'h-full transition-all duration-300',
            sweep.state === 'error' || sweep.state === 'aborted'
              ? 'bg-danger'
              : sweep.state === 'completed'
                ? 'bg-success'
                : 'bg-primary',
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      {sweep.error !== null ? (
        <div
          role="alert"
          data-testid="sweep-progress-error"
          className={cn(
            'border-danger/30 bg-danger/10 text-foreground',
            'rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs',
          )}
        >
          {sweep.error.category}: {sweep.error.detail}
        </div>
      ) : null}
      <div
        data-testid="sweep-progress-iterations"
        className="border-border max-h-32 overflow-y-auto rounded border text-xs"
      >
        <table className="w-full">
          <thead className="bg-muted/40 text-muted-foreground sticky top-0">
            <tr>
              <th className="px-2 py-1 text-left">#</th>
              <th className="px-2 py-1 text-left">Value</th>
              <th className="px-2 py-1 text-left">Converged</th>
              <th className="px-2 py-1 text-left">final_t</th>
            </tr>
          </thead>
          <tbody>
            {sweep.iterations.map((it) => (
              <tr
                key={it.iteration}
                data-testid={`sweep-progress-iter-${it.iteration}`}
                data-iter-converged={String(it.converged)}
              >
                <td className="px-2 py-1">{it.iteration}</td>
                <td className="px-2 py-1">{it.parameter_value.toFixed(4)}</td>
                <td className="px-2 py-1">
                  {it.error !== null ? 'err' : it.converged ? 'yes' : 'no'}
                </td>
                <td className="px-2 py-1">{it.final_t.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
