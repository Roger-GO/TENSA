/**
 * EigSweepPanel: the "Parameter sweep" section of the Analyze panel's EIG
 * sub-mode. It takes the eigenvalues at each of a list of values of one
 * parameter of one device (root locus data), from
 * ``POST /sessions/{id}/eig/sweep``.
 *
 * The form (model, device and parameter pickers fed from the topology and the
 * alterable-params hook, then start, end and points) builds the linear list of
 * values. The result is drawn as one dot per eigenvalue per value, in one
 * token colour whose opacity grows with the parameter's value, from 0.25 at
 * the smallest to 1 at the largest; the legend shows that ramp with the two
 * values at its ends. No mode is followed through the sweep (the server keeps
 * none), so the dots are not joined. The table under the plot is its text
 * alternative: per value, how many modes are unstable and the smallest damping
 * ratio, by the rules of ``lib/eigModes.ts`` that the single run's scatter and
 * the HTML report count by.
 *
 * A point that fails fails the whole sweep: the server answers 422 with a
 * detail that names the value, which the routine's error banner shows. A
 * success carries every point.
 *
 * The form state is local and starts over on remount; the panel is keyed by
 * the case path where it is mounted, so it starts over with each case. The
 * result lives in the analyze store and is dropped with the power flow it was
 * solved from (the cascade in ``store/index.ts``).
 */
import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Input } from '@/components/ui/Input';
import { ExportMenu } from '@/components/export/ExportMenu';
import { useExportCaseName } from '@/components/export/useExportCaseName';
import { smallestDampingRatio, unstableModeCount } from '@/lib/eigModes';
import { formatSignificant } from '@/lib/series';
import { useAlterableParams, useCurrentTopology, useEigSweepRun } from '@/api/queries';
import type { EigSweepResponse, TopologySummary } from '@/api/types';
import { useAnalyzeStore } from '@/store/analyze';
import { useSessionStore } from '@/store/session';
import { AnalyzeRoutineError, AnalyzeRunButton } from './AnalyzePanel';
import { RunReadinessNote } from './RunReadinessNote';
import { computeTicks, computeViewport, formatTick } from './EIGScatter';
import { eigSweepResultToCsv } from './analyzeExport';

export interface EigSweepPanelProps {
  className?: string;
}

/** The most values one sweep may have: the server's own cap. */
export const MAX_SWEEP_POINTS = 200;

/** Opacity of the dots at the smallest value of the sweep; the largest is 1. */
const FIRST_OPACITY = 0.25;

const SVG_WIDTH = 320;
const SVG_HEIGHT = 240;
const PADDING = 28;

const POINTS_ERROR = `Enter a whole number of points from 1 to ${MAX_SWEEP_POINTS}.`;

/**
 * Validate one bound (start or end) of the sweep: ``null`` when valid, the
 * message otherwise. The server's values are finite numbers.
 */
function validateBound(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'Enter a number.';
  if (!Number.isFinite(Number(trimmed))) return 'Enter a finite number.';
  return null;
}

/** Validate the number of points: a whole number from 1 to the cap. */
function validatePoints(text: string): string | null {
  const trimmed = text.trim();
  if (!/^\+?\d+$/.test(trimmed)) return POINTS_ERROR;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_SWEEP_POINTS) return POINTS_ERROR;
  return null;
}

/**
 * The values of a sweep from ``start`` to ``end`` in ``n`` equal steps:
 * ``start + (end - start) * i / (n - 1)``, the last one ``end`` exactly. A
 * single point is ``[start]``. A range may run downwards, and a start equal
 * to the end gives ``n`` equal values.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function sweepValues(start: number, end: number, n: number): number[] {
  if (n <= 1) return [start];
  const values: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    values.push(start + ((end - start) * i) / (n - 1));
  }
  values.push(end);
  return values;
}

/**
 * Every model the topology lists, with the idxs of its devices in the order
 * the case gives them, as text (the server takes an idx as text and matches
 * it to a numeric one by its text).
 */
function modelDevicesOf(topology: TopologySummary | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (topology === null) return out;
  const buckets = [
    topology.buses,
    topology.lines,
    topology.transformers,
    topology.generators,
    topology.loads,
    topology.shunts,
    topology.controllers,
  ];
  for (const bucket of buckets) {
    for (const entry of bucket ?? []) {
      const list = out.get(entry.kind) ?? [];
      const idx = String(entry.idx);
      if (!list.includes(idx)) list.push(idx);
      out.set(entry.kind, list);
    }
  }
  return out;
}

/**
 * The opacity of a dot at ``value``: it grows with the value, from 0.25 at the
 * smallest of the sweep to 1 at the largest. A sweep of one value is drawn at
 * full opacity.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function valueOpacity(value: number, min: number, max: number): number {
  if (max === min) return 1;
  const t = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return FIRST_OPACITY + (1 - FIRST_OPACITY) * t;
}

export function EigSweepPanel({ className }: EigSweepPanelProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const result = useAnalyzeStore((s) => s.eigSweepResult);
  const sweepRun = useEigSweepRun();
  const topology = useCurrentTopology();

  const [model, setModel] = useState<string | null>(null);
  const [idx, setIdx] = useState<string | null>(null);
  const [param, setParam] = useState<string | null>(null);
  const [startText, setStartText] = useState('');
  const [endText, setEndText] = useState('');
  const [pointsText, setPointsText] = useState('');
  // A blank field says nothing until a run is asked for; a field with text in
  // it says what is wrong with it as it is typed.
  const [attempted, setAttempted] = useState(false);

  const modelDevices = useMemo(() => modelDevicesOf(topology), [topology]);
  const models = useMemo(() => [...modelDevices.keys()].sort(), [modelDevices]);
  const devices = model !== null ? (modelDevices.get(model) ?? []) : [];
  const alterable = useAlterableParams(model);
  const params = alterable.data?.params ?? [];

  const shown = (text: string, error: string | null) =>
    error !== null && (attempted || text.trim().length > 0) ? error : null;
  const startError = shown(startText, validateBound(startText));
  const endError = shown(endText, validateBound(endText));
  const pointsError = shown(pointsText, validatePoints(pointsText));
  const modelError = attempted && model === null ? 'Choose a model.' : null;
  const idxError = attempted && idx === null ? 'Choose a device.' : null;
  const paramError = attempted && param === null ? 'Choose a parameter.' : null;

  const onModelChange = (next: string) => {
    setModel(next === '' ? null : next);
    setIdx(null);
    setParam(null);
  };

  const onRun = () => {
    setAttempted(true);
    if (!sessionId) return;
    // An invalid field shows its error inline and sends nothing.
    if (model === null || idx === null || param === null) return;
    if (
      validateBound(startText) !== null ||
      validateBound(endText) !== null ||
      validatePoints(pointsText) !== null
    ) {
      return;
    }
    const values = sweepValues(
      Number(startText.trim()),
      Number(endText.trim()),
      Number(pointsText.trim()),
    );
    sweepRun.mutate({ sessionId, model, idx, param, values });
  };

  const caseName = useExportCaseName();
  const onExportCsv = useCallback(
    () => (result === null ? null : eigSweepResultToCsv(result)),
    [result],
  );

  const selectClass = cn(
    'border-border bg-background text-foreground h-7 rounded border px-1 text-xs',
    'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
    'disabled:opacity-50',
  );

  return (
    <details className={cn('group', className)} data-testid="eig-sweep">
      <summary
        className={cn(
          'text-muted-foreground hover:text-foreground cursor-pointer text-[11px] font-medium',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        )}
      >
        Parameter sweep
      </summary>

      <p className="text-muted-foreground mt-1 text-[10px] leading-snug">
        The eigenvalues at each of a range of values of one parameter of one device, each value
        solved on a system of its own. The case itself is not changed.
      </p>

      <div className="mt-2 grid grid-cols-3 gap-2">
        <Field id="eig-sweep-model" label="model" error={modelError}>
          <select
            id="eig-sweep-model"
            data-testid="eig-sweep-model"
            value={model ?? ''}
            onChange={(e) => onModelChange(e.target.value)}
            aria-invalid={modelError ? true : undefined}
            aria-describedby={modelError ? 'eig-sweep-model-error' : undefined}
            className={selectClass}
          >
            <option value="">Choose a model</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>

        <Field id="eig-sweep-idx" label="device (idx)" error={idxError}>
          <select
            id="eig-sweep-idx"
            data-testid="eig-sweep-idx"
            value={idx ?? ''}
            onChange={(e) => setIdx(e.target.value === '' ? null : e.target.value)}
            disabled={model === null}
            aria-invalid={idxError ? true : undefined}
            aria-describedby={idxError ? 'eig-sweep-idx-error' : undefined}
            className={selectClass}
          >
            <option value="">Choose a device</option>
            {devices.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </Field>

        <Field id="eig-sweep-param" label="param" error={paramError}>
          <select
            id="eig-sweep-param"
            data-testid="eig-sweep-param"
            value={param ?? ''}
            onChange={(e) => setParam(e.target.value === '' ? null : e.target.value)}
            disabled={model === null}
            aria-invalid={paramError ? true : undefined}
            aria-describedby={paramError ? 'eig-sweep-param-error' : undefined}
            className={selectClass}
          >
            <option value="">Choose a parameter</option>
            {params.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2">
        <Field
          id="eig-sweep-start"
          label="start"
          error={startError}
          hint="First value, on the base the case file uses."
        >
          <Input
            id="eig-sweep-start"
            data-testid="field-eig-sweep-start"
            inputMode="decimal"
            value={startText}
            onChange={setStartText}
            aria-invalid={startError ? true : undefined}
            aria-describedby={startError ? 'eig-sweep-start-error' : 'eig-sweep-start-hint'}
            className="h-7 font-mono text-xs"
          />
        </Field>
        <Field id="eig-sweep-end" label="end" error={endError} hint="Last value.">
          <Input
            id="eig-sweep-end"
            data-testid="field-eig-sweep-end"
            inputMode="decimal"
            value={endText}
            onChange={setEndText}
            aria-invalid={endError ? true : undefined}
            aria-describedby={endError ? 'eig-sweep-end-error' : 'eig-sweep-end-hint'}
            className="h-7 font-mono text-xs"
          />
        </Field>
        <Field
          id="eig-sweep-points"
          label="points"
          error={pointsError}
          hint={`At most ${MAX_SWEEP_POINTS} points: each one costs a power flow and an eigenvalue analysis of the case.`}
        >
          <Input
            id="eig-sweep-points"
            data-testid="field-eig-sweep-points"
            inputMode="numeric"
            value={pointsText}
            onChange={setPointsText}
            aria-invalid={pointsError ? true : undefined}
            aria-describedby={pointsError ? 'eig-sweep-points-error' : 'eig-sweep-points-hint'}
            className="h-7 font-mono text-xs"
          />
        </Field>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <AnalyzeRunButton
          routine="eig"
          label="Run sweep"
          pendingLabel="Running sweep…"
          isPending={sweepRun.isPending}
          onClick={onRun}
          testId="analyze-run-eig-sweep"
        />
      </div>

      <RunReadinessNote routine="eig" testId="analyze-run-eig-sweep" />

      <AnalyzeRoutineError routine="eig" testIdPrefix="eig-sweep" error={sweepRun.error} />

      <div className="mt-2">
        {result === null ? (
          <div
            data-testid="eig-sweep-empty"
            className={cn(
              'border-border bg-muted/20 text-muted-foreground',
              'flex min-h-[120px] items-center justify-center rounded border p-4 text-xs',
            )}
          >
            Run a sweep to see the root locus.
          </div>
        ) : (
          <EigSweepResult result={result} caseName={caseName} onExportCsv={onExportCsv} />
        )}
      </div>
    </details>
  );
}

/** A labelled field of the form, with its inline error or its hint under it. */
function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error: string | null;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-muted-foreground text-xs font-medium">
        {label}
      </label>
      {children}
      {error !== null ? (
        <span
          id={`${id}-error`}
          role="alert"
          data-testid={`error-${id}`}
          className="text-danger text-[10px] leading-snug"
        >
          {error}
        </span>
      ) : hint !== undefined ? (
        <span id={`${id}-hint`} className="text-muted-foreground text-[10px] leading-snug">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** The root locus plot, its legend and the per-value table of one sweep result. */
function EigSweepResult({
  result,
  caseName,
  onExportCsv,
}: {
  result: EigSweepResponse;
  caseName: string;
  onExportCsv: () => Blob | null;
}) {
  const plotW = SVG_WIDTH - PADDING * 2;
  const plotH = SVG_HEIGHT - PADDING * 2;

  const dots = useMemo(
    () =>
      result.points.flatMap((point, pointIdx) =>
        point.eigenvalues.map((z, modeIdx) => ({
          pointIdx,
          modeIdx,
          value: point.value,
          real: z.real,
          imag: z.imag,
        })),
      ),
    [result],
  );

  // The scatter's own fit: symmetric about the origin, 10% past the farthest
  // dot on each axis, so every dot is inside the plot and the origin (where a
  // zero eigenvalue is drawn) is always in view.
  const view = useMemo(
    () => computeViewport(dots.map((d, i) => ({ idx: i, real: d.real, imag: d.imag }))),
    [dots],
  );
  const xRange = view.xMax - view.xMin;
  const yRange = view.yMax - view.yMin;
  const xToPx = (x: number) => PADDING + ((x - view.xMin) / xRange) * plotW;
  const yToPx = (y: number) => PADDING + ((view.yMax - y) / yRange) * plotH;
  const xTicks = computeTicks(view.xMin, view.xMax);
  const yTicks = computeTicks(view.yMin, view.yMax);

  const values = result.points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const swept = `${result.param} of ${result.model} ${result.idx}`;

  return (
    <div
      data-testid="eig-sweep-locus"
      className="border-border bg-background relative flex flex-col rounded border"
    >
      <div className="border-border text-muted-foreground flex items-center justify-between gap-3 border-b px-2.5 py-1.5 text-[11px]">
        <span className="tabular-nums">
          Root locus: {result.points.length} {result.points.length === 1 ? 'value' : 'values'},{' '}
          {result.mode_count} modes at each
        </span>
        <div data-export-ignore="" className="bg-muted/40 flex items-center gap-0.5 rounded p-0.5">
          <ExportMenu
            formats={['csv']}
            panel="eig-sweep"
            caseName={caseName}
            onExportCsv={onExportCsv}
            className="h-6 px-2"
          />
        </div>
      </div>
      <div
        data-testid="eig-sweep-legend"
        className="border-border text-muted-foreground flex flex-wrap items-center gap-2 border-b px-2.5 py-1 text-[10px]"
      >
        <span data-testid="eig-sweep-legend-name">{swept}</span>
        <span data-testid="eig-sweep-legend-min" className="tabular-nums">
          {formatSignificant(min, 6)}
        </span>
        <span
          aria-hidden="true"
          data-testid="eig-sweep-legend-ramp"
          className="from-primary/25 to-primary inline-block h-1.5 w-16 rounded bg-linear-to-r"
        />
        <span data-testid="eig-sweep-legend-max" className="tabular-nums">
          {formatSignificant(max, 6)}
        </span>
        <span className="sr-only">
          The dots are fainter at smaller values of {result.param} and solid at larger ones.
        </span>
      </div>
      <svg
        viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
        className="mx-auto w-full select-none"
        style={{ aspectRatio: `${SVG_WIDTH} / ${SVG_HEIGHT}`, maxWidth: 720 }}
        role="img"
        aria-label={`Root locus of ${swept}: the eigenvalues at ${result.points.length} values from ${formatSignificant(min, 6)} to ${formatSignificant(max, 6)}. The table below lists them by value.`}
      >
        <g data-testid="eig-sweep-grid" aria-hidden="true">
          {xTicks.map((tick) => {
            const px = xToPx(tick);
            return (
              <g key={`x-${tick}`}>
                <line
                  x1={px}
                  y1={PADDING}
                  x2={px}
                  y2={PADDING + plotH}
                  className="stroke-border/60"
                  strokeWidth={0.5}
                />
                <text
                  x={px}
                  y={PADDING + plotH + 8}
                  textAnchor="middle"
                  className="fill-muted-foreground/80 text-[6px] tabular-nums"
                >
                  {formatTick(tick)}
                </text>
              </g>
            );
          })}
          {yTicks.map((tick) => {
            const py = yToPx(tick);
            return (
              <g key={`y-${tick}`}>
                <line
                  x1={PADDING}
                  y1={py}
                  x2={PADDING + plotW}
                  y2={py}
                  className="stroke-border/60"
                  strokeWidth={0.5}
                />
                <text
                  x={PADDING - 3}
                  y={py + 2}
                  textAnchor="end"
                  className="fill-muted-foreground/80 text-[6px] tabular-nums"
                >
                  {formatTick(tick)}
                </text>
              </g>
            );
          })}
        </g>
        {/* The view is symmetric about the origin, so both axes are inside it. */}
        <line
          data-testid="eig-sweep-real-axis"
          x1={PADDING}
          y1={yToPx(0)}
          x2={PADDING + plotW}
          y2={yToPx(0)}
          className="stroke-border"
          strokeWidth={1}
        />
        <line
          data-testid="eig-sweep-imag-axis"
          x1={xToPx(0)}
          y1={PADDING}
          x2={xToPx(0)}
          y2={PADDING + plotH}
          className="stroke-foreground/60"
          strokeWidth={1}
        />
        <text
          x={PADDING + plotW}
          y={SVG_HEIGHT - 4}
          textAnchor="end"
          className="fill-muted-foreground text-[6.5px]"
        >
          Re [1/s]
        </text>
        <text x={4} y={PADDING - 8} className="fill-muted-foreground text-[6.5px]">
          Im [rad/s]
        </text>
        <g>
          {dots.map((d) => (
            <circle
              key={`${d.pointIdx}-${d.modeIdx}`}
              cx={xToPx(d.real)}
              cy={yToPx(d.imag)}
              r={2}
              data-testid={`eig-sweep-locus-point-${d.pointIdx}-${d.modeIdx}`}
              className="fill-primary"
              opacity={valueOpacity(d.value, min, max)}
            >
              <title>{`${result.param} = ${formatSignificant(d.value, 6)}: ${formatSignificant(d.real)} ${d.imag < 0 ? '-' : '+'} ${formatSignificant(Math.abs(d.imag))}i`}</title>
            </circle>
          ))}
        </g>
      </svg>
      <table
        data-testid="eig-sweep-table"
        className="border-border text-muted-foreground w-full border-t text-[10px]"
      >
        <caption className="sr-only">
          Per value of {swept}: the number of unstable modes and the smallest damping ratio.
        </caption>
        <thead>
          <tr className="text-left">
            <th scope="col" className="px-2 py-1 font-medium">
              {result.param}
            </th>
            <th scope="col" className="px-2 py-1 font-medium">
              unstable modes
            </th>
            <th scope="col" className="px-2 py-1 font-medium">
              min damping ratio
            </th>
          </tr>
        </thead>
        <tbody>
          {result.points.map((point, i) => {
            const unstable = unstableModeCount(point.eigenvalues);
            return (
              <tr key={i} data-testid={`eig-sweep-row-${i}`} className="border-border border-t">
                <td data-col="value" className="px-2 py-0.5 tabular-nums">
                  {formatSignificant(point.value, 6)}
                </td>
                <td
                  data-col="unstable"
                  className={cn('px-2 py-0.5 tabular-nums', unstable > 0 && 'text-danger')}
                >
                  {unstable}
                </td>
                <td data-col="damping" className="px-2 py-0.5 tabular-nums">
                  {formatSignificant(smallestDampingRatio(point.damping_ratios), 4)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
