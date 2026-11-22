/**
 * ExternalResultsDialog. Imports a TSAT or PSS/E ``.xlsx`` channel export as
 * overlay traces on the time-series plot: pick the tool, pick the file, import,
 * then pick the series and their axes and add them to the plot.
 *
 * A lazy chunk: ``TimeSeriesPlot`` loads it with ``lazyNamed(..., 'overlay')``
 * and mounts it through ``LazyMount`` on the store flag, so it is fetched the
 * first time it is opened and unmounted when it closes (its state starts fresh
 * on the next open). The import registers no job and fires no toast: the
 * dialog closes and the traces are in the plot. A refusal (413, 415, 422) is
 * shown inline with the server's detail, never toasted.
 */
import { useId, useState } from 'react';
import { useImportExternalResults } from '@/api/queries';
import type { ExternalResultsResponse, ExternalSeries } from '@/api/queries';
import { ProblemDetailsError } from '@/api/client';
import { useExternalOverlaysStore } from '@/store/externalOverlays';
import type { ExternalOverlayTrace } from '@/store/externalOverlays';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

type Source = 'tsat' | 'psse';
type Phase = 'pick' | 'importing' | 'choose';

/**
 * One imported series as a stored trace: the ``(t, y)`` pairs sorted by time
 * once here (the export's order is whatever the tool wrote), with the nulls of
 * the export as NaN. Every sample is kept; the plot uses the ones inside the
 * plotted run's time range when it builds a chart.
 */
function traceOf(
  source: Source,
  series: ExternalSeries,
  axis: 'left' | 'right',
): ExternalOverlayTrace {
  const order = series.t.map((_, i) => i);
  order.sort((a, b) => (series.t[a] ?? 0) - (series.t[b] ?? 0));
  const t = new Float64Array(order.length);
  const y = new Float64Array(order.length);
  for (let k = 0; k < order.length; k += 1) {
    const i = order[k]!;
    t[k] = series.t[i]!;
    const value = series.y[i];
    y[k] = value === null || value === undefined ? NaN : value;
  }
  return {
    id: `${source}:${series.name}`,
    source,
    name: series.name,
    label: `${source}: ${series.name}`,
    t,
    y,
    axis,
  };
}

export function ExternalResultsDialog() {
  const dialogOpen = useExternalOverlaysStore((s) => s.dialogOpen);
  const closeDialog = useExternalOverlaysStore((s) => s.closeDialog);
  const addTraces = useExternalOverlaysStore((s) => s.addTraces);
  const mutation = useImportExternalResults();

  const [source, setSource] = useState<Source>('tsat');
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>('pick');
  const [result, setResult] = useState<ExternalResultsResponse | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [axisByName, setAxisByName] = useState<ReadonlyMap<string, 'left' | 'right'>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const fileInputId = useId();

  const onOpenChange = (open: boolean) => {
    if (!open) closeDialog();
  };

  // A series list belongs to the file and the format it was read from: picking
  // another of either asks for a new import before anything is added.
  const startOver = () => {
    setPhase('pick');
    setResult(null);
    setError(null);
  };

  const onImport = () => {
    if (file === null) return;
    setPhase('importing');
    setError(null);
    mutation.mutate(
      { source, file },
      {
        onSuccess: (data) => {
          setResult(data);
          setChecked(new Set(data.series.map((s) => s.name)));
          setAxisByName(new Map(data.series.map((s) => [s.name, 'left' as const])));
          setPhase('choose');
          setError(null);
        },
        onError: (err) => {
          setPhase('pick');
          setError(
            err instanceof ProblemDetailsError && err.detail
              ? err.detail
              : err instanceof Error
                ? err.message
                : 'unknown error',
          );
        },
      },
    );
  };

  const toggleSeries = (name: string, on: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  };

  const setAxis = (name: string, axis: 'left' | 'right') => {
    setAxisByName((prev) => new Map(prev).set(name, axis));
  };

  const onAdd = () => {
    if (result === null) return;
    const traces = result.series
      .filter((s) => checked.has(s.name))
      .map((s) => traceOf(result.source, s, axisByName.get(s.name) ?? 'left'));
    if (traces.length === 0) return;
    addTraces(traces);
    closeDialog();
  };

  return (
    <Dialog open={dialogOpen} onOpenChange={onOpenChange}>
      <DialogContent data-testid="external-results-dialog">
        <DialogHeader>
          <DialogTitle>Import external result</DialogTitle>
          <DialogDescription>
            Overlay a TSAT or PSS/E channel export on the plotted run.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 flex flex-col gap-4">
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-muted-foreground text-xs font-medium">Source</legend>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="external-results-source"
                  data-testid="external-results-source-tsat"
                  checked={source === 'tsat'}
                  disabled={phase === 'importing'}
                  onChange={() => {
                    setSource('tsat');
                    startOver();
                  }}
                />
                TSAT
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="external-results-source"
                  data-testid="external-results-source-psse"
                  checked={source === 'psse'}
                  disabled={phase === 'importing'}
                  onChange={() => {
                    setSource('psse');
                    startOver();
                  }}
                />
                PSS/E
              </label>
            </div>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={fileInputId} className="text-muted-foreground text-xs font-medium">
              Export file (.xlsx)
            </label>
            <input
              id={fileInputId}
              type="file"
              accept=".xlsx"
              data-testid="external-results-file"
              disabled={phase === 'importing'}
              onChange={(e) => {
                setFile(e.currentTarget.files?.[0] ?? null);
                startOver();
              }}
              className="text-sm"
            />
          </div>

          {phase === 'choose' && result !== null ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm">
                {`The file holds ${result.samples} samples in ${result.series.length} series. Pick the series to plot.`}
              </p>
              <ul data-testid="external-results-series-list" className="flex flex-col gap-1.5">
                {result.series.map((series) => (
                  <li key={series.name} className="flex items-center gap-3">
                    <label className="flex flex-1 items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        data-testid={`external-results-series-${series.name}`}
                        checked={checked.has(series.name)}
                        onChange={(e) => toggleSeries(series.name, e.currentTarget.checked)}
                      />
                      {series.name}
                    </label>
                    <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
                      Axis
                      <select
                        aria-label={`Axis of ${series.name}`}
                        data-testid={`external-results-axis-${series.name}`}
                        value={axisByName.get(series.name) ?? 'left'}
                        onChange={(e) =>
                          setAxis(series.name, e.currentTarget.value === 'right' ? 'right' : 'left')
                        }
                        className={cn(
                          'border-border bg-background text-foreground rounded-[var(--radius-sm)] border px-1.5 py-0.5 text-xs',
                          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                        )}
                      >
                        <option value="left">Left axis</option>
                        <option value="right">Right axis</option>
                      </select>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {error !== null ? (
            <div role="alert" data-testid="external-results-error" className="text-danger text-sm">
              {error}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={closeDialog}>
            Cancel
          </Button>
          {phase === 'choose' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="external-results-add"
              disabled={checked.size === 0}
              onClick={onAdd}
            >
              Add to plot
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="external-results-import"
              disabled={file === null || phase === 'importing'}
              onClick={onImport}
            >
              {phase === 'importing' ? 'Importing…' : 'Import'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
