import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useShallow } from 'zustand/react/shallow';
import { fetchResponseMetrics } from '@/api/queries';
import type { MetricExtremum, SeriesMetrics } from '@/api/types';
import { useRunsStore } from '@/store/runs';
import type { RunState } from '@/store/runs';
import { usePlotStore } from '@/store/plot';
import { useUnitsStore } from '@/store/units';
import { formatSignificant } from '@/lib/series';
import {
  ROCOF_WINDOW_S,
  SETTLING_BAND,
  displayedSeries,
  metricsRequest,
  metricsWindow,
} from '@/lib/responseMetrics';
import { runLabel } from '@/lib/runLabel';
import { cn } from '@/lib/cn';
import { primaryRunOf, resolveOverlayRuns, usePlotRunId } from './overlayRuns';

/**
 * ResponseMetricsPanel: how each plotted signal of the run responded, in a table:
 * where it started and ended, its nadir and peak, its largest swing, the steepest
 * rate of change, how long it took to settle, how far it overshot, and the
 * damping and frequency of its oscillation. The numbers are the substrate's
 * (``POST /response-metrics``, definitions in ``tensa.core.response_metrics``),
 * read off the values the charts show, in the charts' units.
 *
 * With both A/B cursors placed the metrics describe the stretch between them, so
 * a fault applied at 1 s and cleared at 1.1 s is analysed by putting A on the
 * fault and B at the end of the swing; otherwise they describe the whole run.
 * They are computed once the run has finished (a streaming run's values are
 * still arriving) and again when the selection, the window or the unit mode
 * changes. The values are the ones the browser holds: the stream is thinned to
 * at most 30 samples a second, so a peak is where the thinned signal peaks.
 */

const FINISHED: ReadonlySet<RunState> = new Set<RunState>(['done', 'aborted', 'error']);

/** A value of the signal and the time it is reached, the time under the value. */
function Extremum({ found }: { found: MetricExtremum | null | undefined }) {
  if (!found) return <>–</>;
  return (
    <>
      {formatSignificant(found.value)}
      <span className="text-muted-foreground block text-[10px]">
        at {formatSignificant(found.t, 5)} s
      </span>
    </>
  );
}

function MetricsRow({ result, unit }: { result: SeriesMetrics; unit: string }) {
  const id = result.name;
  const cell = 'px-2 py-1 text-right align-top font-mono';
  if (result.error) {
    return (
      <tr data-testid={`response-metrics-row-${id}`}>
        <td className="px-2 py-1 text-left align-top font-mono">{id}</td>
        <td
          colSpan={9}
          data-testid={`response-metrics-error-${id}`}
          className="text-muted-foreground px-2 py-1 text-left"
        >
          {result.error}
        </td>
      </tr>
    );
  }
  return (
    <tr data-testid={`response-metrics-row-${id}`}>
      <td className="px-2 py-1 text-left align-top">
        <span className="font-mono">{id}</span>
        {unit === '' ? null : <span className="text-muted-foreground"> · {unit}</span>}
      </td>
      <td className={cell} data-testid={`response-metrics-initial-${id}`}>
        {formatSignificant(result.initial)}
      </td>
      <td className={cell} data-testid={`response-metrics-final-${id}`}>
        {formatSignificant(result.final)}
      </td>
      <td className={cell} data-testid={`response-metrics-nadir-${id}`}>
        <Extremum found={result.nadir} />
      </td>
      <td className={cell} data-testid={`response-metrics-peak-${id}`}>
        <Extremum found={result.peak} />
      </td>
      <td className={cell} data-testid={`response-metrics-deviation-${id}`}>
        <Extremum found={result.max_deviation} />
      </td>
      <td className={cell} data-testid={`response-metrics-rocof-${id}`}>
        {result.rocof ? (
          <>
            {formatSignificant(result.rocof.value)}
            <span className="text-muted-foreground block text-[10px]">
              at {formatSignificant(result.rocof.t, 5)} s
            </span>
          </>
        ) : (
          '–'
        )}
      </td>
      <td className={cell} data-testid={`response-metrics-settling-${id}`}>
        {result.settling_time === null || result.settling_time === undefined ? (
          <span title="Still outside the band at the end of the window">not settled</span>
        ) : (
          formatSignificant(result.settling_time)
        )}
      </td>
      <td className={cell} data-testid={`response-metrics-overshoot-${id}`}>
        {result.overshoot_pct === null || result.overshoot_pct === undefined
          ? '–'
          : formatSignificant(result.overshoot_pct, 3)}
      </td>
      <td className={cell} data-testid={`response-metrics-damping-${id}`}>
        {result.damping ? (
          <>
            ζ {formatSignificant(result.damping.ratio, 3)}
            <span className="text-muted-foreground block text-[10px]">
              {formatSignificant(result.damping.frequency_hz, 3)} Hz
            </span>
          </>
        ) : (
          '–'
        )}
      </td>
    </tr>
  );
}

export function ResponseMetricsPanel({ className }: { className?: string }) {
  // The run the plot keys its selection and cursors on.
  const plotRun = usePlotRunId();
  // The run the metrics are of, the one ``TimeSeriesPlot`` exports: the active
  // run while there is one, whose cursors the window above is read from.
  const primaryRunId = useRunsStore(
    (s) => primaryRunOf(resolveOverlayRuns(s), plotRun)?.runId ?? null,
  );
  const overlayCount = useRunsStore((s) => resolveOverlayRuns(s).length);
  const primaryLabel = useRunsStore(
    useShallow((s) => {
      const run = primaryRunOf(resolveOverlayRuns(s), plotRun);
      return run === undefined ? '' : runLabel(run);
    }),
  );
  const runState = useRunsStore((s) =>
    primaryRunId === null ? null : (s.runs[primaryRunId]?.state ?? null),
  );
  // The row count of a finished run, and a constant while it streams, so the panel
  // is not redrawn at the frame rate for numbers it will not use until the end.
  const rows = useRunsStore((s) => {
    const run = primaryRunId === null ? undefined : s.runs[primaryRunId];
    return run !== undefined && FINISHED.has(run.state) ? run.seqCount : -1;
  });
  const selected = usePlotStore((s) => (plotRun === null ? undefined : s.selectedByRun[plotRun]));
  const cursors = usePlotStore((s) => (plotRun === null ? undefined : s.cursorsByRun[plotRun]));
  const mode = useUnitsStore((s) => s.mode);
  const window = metricsWindow(cursors);

  const finished = runState !== null && FINISHED.has(runState) && rows > 0;
  const names = useRunsStore(
    useShallow((s) => {
      const run = primaryRunId === null ? undefined : s.runs[primaryRunId];
      if (run === undefined || selected === undefined) return [] as string[];
      return run.columnNames.filter((n) => selected.has(n) && run.columns[n] !== undefined);
    }),
  );
  const enabled = finished && primaryRunId !== null && names.length > 0;

  const metrics = useQuery({
    queryKey: ['response-metrics', primaryRunId, rows, names, window.tStart, window.tEnd, mode],
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: keepPreviousData,
    retry: false,
    queryFn: async ({ signal }) => {
      const run = primaryRunId === null ? undefined : useRunsStore.getState().runs[primaryRunId];
      if (run === undefined) throw new Error('the run is gone');
      const plan = metricsRequest(displayedSeries(run, new Set(names), mode), window);
      const response = await fetchResponseMetrics(plan.request, signal);
      return {
        results: response.results,
        units: Object.fromEntries(plan.asked.map((s) => [s.name, s.unit])),
        skipped: plan.skipped,
        stride: plan.stride,
      };
    },
  });

  let message: string | null = null;
  if (primaryRunId === null) message = 'Run a TDS to see response metrics.';
  else if (names.length === 0) message = 'Select variables to plot to see their response metrics.';
  else if (runState !== null && !FINISHED.has(runState)) {
    message = 'The metrics are computed when the run finishes.';
  } else if (!finished) message = 'The run recorded no samples.';
  else if (metrics.isError) message = `Could not compute the metrics: ${metrics.error.message}`;
  else if (metrics.data === undefined) message = 'Computing…';

  const windowText =
    window.tStart === null
      ? 'the whole run'
      : `A to B, ${formatSignificant(window.tStart, 5)} to ${formatSignificant(window.tEnd, 5)} s`;

  return (
    <div
      data-testid="response-metrics-panel"
      className={cn('flex flex-col gap-1.5 p-2 text-xs', className)}
    >
      <p data-testid="response-metrics-window" className="text-muted-foreground text-[10px]">
        Over {windowText}. Settling within {SETTLING_BAND * 100} % of the largest distance from the
        final value; rate of change over {ROCOF_WINDOW_S} s.
        {window.tStart === null
          ? ' Place cursors A and B on the plot to measure between them.'
          : ''}
      </p>
      {overlayCount > 1 ? (
        <p
          data-testid="response-metrics-overlay-note"
          className="text-muted-foreground text-[10px]"
        >
          With runs overlaid, the metrics describe {primaryLabel} only.
        </p>
      ) : null}
      {message !== null ? (
        <p data-testid="response-metrics-message" className="text-muted-foreground">
          {message}
        </p>
      ) : metrics.data ? (
        <>
          <div
            className={cn('overflow-x-auto', metrics.isPlaceholderData ? 'opacity-60' : '')}
            data-testid="response-metrics-table"
          >
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="px-2 py-1 text-left font-medium">Series</th>
                  <th className="px-2 py-1 text-right font-medium">Initial</th>
                  <th className="px-2 py-1 text-right font-medium">Final</th>
                  <th className="px-2 py-1 text-right font-medium">Nadir</th>
                  <th className="px-2 py-1 text-right font-medium">Peak</th>
                  <th className="px-2 py-1 text-right font-medium">Max deviation</th>
                  <th className="px-2 py-1 text-right font-medium">Rate of change (per s)</th>
                  <th className="px-2 py-1 text-right font-medium">Settling (s)</th>
                  <th className="px-2 py-1 text-right font-medium">Overshoot (%)</th>
                  <th className="px-2 py-1 text-right font-medium">Damping</th>
                </tr>
              </thead>
              <tbody>
                {metrics.data.results.map((result) => (
                  <MetricsRow
                    key={result.name}
                    result={result}
                    unit={metrics.data.units[result.name] ?? ''}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {metrics.data.skipped > 0 ? (
            <p data-testid="response-metrics-skipped" className="text-muted-foreground text-[10px]">
              {metrics.data.skipped} more plotted series are left out: one request describes at most{' '}
              {metrics.data.results.length} of this run's length. Plot fewer to see them.
            </p>
          ) : null}
          {metrics.data.stride > 1 ? (
            <p data-testid="response-metrics-stride" className="text-muted-foreground text-[10px]">
              The run is long: every {metrics.data.stride}th sample was used.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
