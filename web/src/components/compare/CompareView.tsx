/**
 * CompareView: two results documents side by side, compared by the server's
 * ``POST /compare``. A full-space overlay opened from the command
 * ``view.compareResults`` or the plot's export menu, hosted by
 * ``CompareViewHost``.
 *
 * A side is a finished kept run (its document is built by the server through
 * ``POST /results/convert`` when the side is picked) or a results document
 * file (``tensa_results: 1``). The operating point comes first, then the
 * series differences, the unmatched keys and the eigenvalue pairs. Selecting
 * a series row draws its two sides in the plot when both sides are runs, or
 * in a small chart of the view's own when one is a file.
 */
import { useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type uPlot from 'uplot';
import { DataGrid, type ColumnConfig } from '@/components/data-grid/DataGrid';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/Input';
import { UPlot } from '@/components/plots/UPlot';
import { PALETTE_DARK, PALETTE_LIGHT } from '@/components/plots/TimeSeriesPlot';
import { useCompareResults } from '@/api/queries';
import type {
  CompareSide,
  EigenvaluePairOut,
  SeriesDifferenceOut,
  TableRowDifferenceOut,
} from '@/api/queries/compare';
import { ProblemDetailsError } from '@/api/client';
import { cn } from '@/lib/cn';
import {
  buildCompareRequest,
  DEFAULT_QUANTITY_TOLERANCES,
  parseResultsDocumentFile,
  runSideLabel,
  runToResultsDocument,
} from '@/lib/resultsDocument';
import { useTheme } from '@/lib/useTheme';
import { useCompareViewStore } from '@/store/compareView';
import type { CompareSideName, CompareSource } from '@/store/compareView';
import { useExternalOverlaysStore } from '@/store/externalOverlays';
import type { ExternalOverlayTrace } from '@/store/externalOverlays';
import { useRunsStore } from '@/store/runs';
import type { RunRecord } from '@/store/runs';

/** Why a run cannot be a side: kept before runs recorded their keys. */
const NO_KEYS_REASON = 'Kept before runs recorded their keys; run it again to compare it';

/** A run that has ended is offered; one still streaming is not. */
function isFinished(run: RunRecord): boolean {
  return run.state === 'done' || run.state === 'error' || run.state === 'aborted';
}

/** The text of a tolerance field is a finite number greater than 0. */
function toleranceValid(text: string): boolean {
  const value = Number(text.trim());
  return text.trim() !== '' && Number.isFinite(value) && value > 0;
}

interface SidePickerProps {
  side: CompareSideName;
  testId: string;
  title: string;
  hint: string;
  /** The run id picked on this side, or null for a file or nothing. */
  selectedRunId: string | null;
  /** The label of a file picked on this side, or null. */
  fileLabel: string | null;
  /** The run picked on the other side, which this picker does not offer. */
  otherRunId: string | null;
  runs: readonly RunRecord[];
  onPick: (runId: string) => void;
}

function SidePicker({
  side,
  testId,
  title,
  hint,
  selectedRunId,
  fileLabel,
  otherRunId,
  runs,
  onPick,
}: SidePickerProps) {
  return (
    <div className="flex min-w-0 items-center gap-1" data-testid={`compare-view-side-${side}`}>
      <label
        htmlFor={testId}
        className="text-muted-foreground text-[11px] font-medium whitespace-nowrap"
        title={hint}
      >
        {title}
      </label>
      <select
        id={testId}
        data-testid={testId}
        value={selectedRunId ?? (fileLabel !== null ? '__file__' : '')}
        onChange={(e) => onPick(e.target.value)}
        className={cn(
          'border-border bg-background text-foreground h-7 max-w-full min-w-0 rounded border px-1.5 text-xs',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        )}
      >
        {selectedRunId === null && fileLabel === null ? (
          <option value="" disabled>
            Pick a run
          </option>
        ) : null}
        {fileLabel !== null ? (
          <option value="__file__" disabled>
            {fileLabel}
          </option>
        ) : null}
        {/* Newest first, as the run history lists its runs. */}
        {[...runs].reverse().map((run) => {
          const noKeys = run.keys === undefined;
          return (
            <option
              key={run.runId}
              value={run.runId}
              disabled={run.runId === otherRunId || noKeys}
              title={noKeys ? NO_KEYS_REASON : undefined}
            >
              {runSideLabel(run)}
              {noKeys ? ' (no keys)' : ''}
            </option>
          );
        })}
      </select>
    </div>
  );
}

/** One tolerance field, with its inline error when the text is not a number greater than 0. */
function ToleranceField({
  testId,
  label,
  unit,
  text,
  onChange,
}: {
  testId: string;
  label: string;
  unit: string | null;
  text: string;
  onChange: (text: string) => void;
}) {
  const valid = toleranceValid(text);
  return (
    <div className="flex flex-col gap-0.5">
      <label htmlFor={testId} className="text-muted-foreground text-[11px] font-medium">
        {label}
        {unit !== null ? ` (${unit})` : ''}
      </label>
      <Input
        id={testId}
        data-testid={testId}
        aria-label={`Tolerance for ${label}`}
        aria-invalid={valid ? undefined : 'true'}
        value={text}
        onChange={onChange}
        className="h-7 w-20 px-1.5 text-xs"
      />
      {valid ? null : (
        <p role="alert" data-testid={`${testId}-error`} className="text-danger text-xs">
          Must be a number greater than 0
        </p>
      )}
    </div>
  );
}

function verdictText(within: boolean | null): string {
  if (within === null) return '—';
  return within ? 'Inside' : 'Outside';
}

/** Series rows: outside-tolerance first by how far outside, then inside by max_diff, then no verdict. */
function sortSeriesRows(rows: readonly SeriesDifferenceOut[]): SeriesDifferenceOut[] {
  const outside = rows
    .filter((r) => r.within_tolerance === false)
    .map((r) => ({
      row: r,
      ratio: r.tolerance !== null && r.tolerance > 0 ? r.max_diff / r.tolerance : Infinity,
    }))
    .sort((a, b) => b.ratio - a.ratio)
    .map((e) => e.row);
  const inside = rows
    .filter((r) => r.within_tolerance === true)
    .sort((a, b) => b.max_diff - a.max_diff);
  const noVerdict = rows.filter((r) => r.within_tolerance === null);
  return [...outside, ...inside, ...noVerdict];
}

const PFLOW_COLUMNS: ColumnConfig<TableRowDifferenceOut>[] = [
  { key: 'quantity', label: 'Quantity', minWidth: 72, accessor: (r) => r.quantity },
  { key: 'key', label: 'Key', minWidth: 96, accessor: (r) => r.key },
  {
    key: 'reference',
    label: 'Reference',
    numeric: true,
    minWidth: 96,
    accessor: (r) => r.reference,
  },
  { key: 'value', label: 'Value', numeric: true, minWidth: 96, accessor: (r) => r.value },
  { key: 'diff', label: 'Difference', numeric: true, minWidth: 96, accessor: (r) => r.diff },
  {
    key: 'within',
    label: 'Within tolerance',
    minWidth: 96,
    accessor: (r) => verdictText(r.within_tolerance),
  },
];

const SERIES_COLUMNS: ColumnConfig<SeriesDifferenceOut>[] = [
  { key: 'quantity', label: 'Quantity', minWidth: 72, accessor: (r) => r.quantity },
  { key: 'key', label: 'Element', minWidth: 96, accessor: (r) => r.key },
  {
    key: 'max_diff',
    label: 'Largest difference',
    numeric: true,
    minWidth: 104,
    accessor: (r) => r.max_diff,
  },
  { key: 'max_diff_t', label: 'at t', numeric: true, minWidth: 72, accessor: (r) => r.max_diff_t },
  { key: 'rms_diff', label: 'RMS', numeric: true, minWidth: 88, accessor: (r) => r.rms_diff },
  {
    key: 'swing_ref',
    label: 'Swing of reference',
    numeric: true,
    minWidth: 104,
    accessor: (r) => r.swing_ref,
  },
  {
    key: 'tolerance',
    label: 'Tolerance',
    numeric: true,
    minWidth: 88,
    accessor: (r) => r.tolerance,
    format: (v) => (v === null ? '—' : String(v)),
  },
  {
    key: 'within',
    label: 'Verdict',
    minWidth: 72,
    accessor: (r) => verdictText(r.within_tolerance),
  },
];

const EIG_COLUMNS: ColumnConfig<EigenvaluePairOut>[] = [
  { key: 'index_ref', label: 'Mode A', numeric: true, minWidth: 64, accessor: (r) => r.index_ref },
  { key: 'index_new', label: 'Mode B', numeric: true, minWidth: 64, accessor: (r) => r.index_new },
  {
    key: 'frequency_hz_ref',
    label: 'Frequency A (Hz)',
    numeric: true,
    minWidth: 112,
    accessor: (r) => r.frequency_hz_ref,
  },
  {
    key: 'frequency_hz_new',
    label: 'Frequency B (Hz)',
    numeric: true,
    minWidth: 112,
    accessor: (r) => r.frequency_hz_new,
  },
  {
    key: 'damping_ratio_ref',
    label: 'Damping A',
    numeric: true,
    minWidth: 88,
    accessor: (r) => r.damping_ratio_ref,
  },
  {
    key: 'damping_ratio_new',
    label: 'Damping B',
    numeric: true,
    minWidth: 88,
    accessor: (r) => r.damping_ratio_new,
  },
  { key: 'distance', label: 'Distance', numeric: true, minWidth: 88, accessor: (r) => r.distance },
  {
    key: 'within',
    label: 'Verdict',
    minWidth: 72,
    accessor: (r) => verdictText(r.within_tolerance),
  },
];

export function CompareView() {
  const open = useCompareViewStore((s) => s.open);
  const closeCompareView = useCompareViewStore((s) => s.closeCompareView);
  const referenceSource = useCompareViewStore((s) => s.referenceSource);
  const comparisonSource = useCompareViewStore((s) => s.comparisonSource);
  const setSide = useCompareViewStore((s) => s.setSide);
  const quantityTolerances = useCompareViewStore((s) => s.quantityTolerances);
  const setQuantityTolerance = useCompareViewStore((s) => s.setQuantityTolerance);
  const frequencyHz = useCompareViewStore((s) => s.frequencyHz);
  const dampingRatio = useCompareViewStore((s) => s.dampingRatio);
  const maxModeDistance = useCompareViewStore((s) => s.maxModeDistance);
  const setToleranceField = useCompareViewStore((s) => s.setToleranceField);
  const selectedSeriesKey = useCompareViewStore((s) => s.selectedSeriesKey);
  const selectSeries = useCompareViewStore((s) => s.selectSeries);

  const runs = useRunsStore((s) => s.runs);
  const finishedRuns = useMemo(() => Object.values(runs).filter(isFinished), [runs]);
  const mutation = useCompareResults();
  const { resolvedTheme } = useTheme();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fileSideRef = useRef<CompareSideName>('reference');
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileLabels, setFileLabels] = useState<{
    reference: string | null;
    comparison: string | null;
  }>({
    reference: null,
    comparison: null,
  });
  const [skippedCounts, setSkippedCounts] = useState<{ reference: number; comparison: number }>({
    reference: 0,
    comparison: 0,
  });

  const referenceRunId = referenceSource?.kind === 'run' ? referenceSource.runId : null;
  const comparisonRunId = comparisonSource?.kind === 'run' ? comparisonSource.runId : null;
  const bothSidesPicked = referenceSource !== null && comparisonSource !== null;

  const toleranceTexts = useMemo(
    () => ({
      quantities: Object.fromEntries(
        Object.entries(DEFAULT_QUANTITY_TOLERANCES).map(([q, def]) => [
          q,
          quantityTolerances[q] ?? def.text,
        ]),
      ),
      frequency_hz: frequencyHz,
      damping_ratio: dampingRatio,
      max_mode_distance: maxModeDistance,
    }),
    [quantityTolerances, frequencyHz, dampingRatio, maxModeDistance],
  );
  const anyInvalid =
    !Object.values(toleranceTexts.quantities).every(toleranceValid) ||
    !toleranceValid(frequencyHz) ||
    !toleranceValid(dampingRatio) ||
    !toleranceValid(maxModeDistance);

  /** Build one side's document: a run through the conversion route, a file parsed again. */
  const buildSide = async (
    source: CompareSource,
  ): Promise<{ side: CompareSide; skipped: number }> => {
    if (source.kind === 'run') {
      const run = useRunsStore.getState().runs[source.runId];
      if (run === undefined) throw new Error('The run is no longer kept');
      return await runToResultsDocument(run);
    }
    const text = await source.file.text();
    return { side: parseResultsDocumentFile(text, source.file.name), skipped: 0 };
  };

  const onCompare = () => {
    if (referenceSource === null || comparisonSource === null) return;
    setFileError(null);
    void (async () => {
      try {
        const [ref, cmp] = await Promise.all([
          buildSide(referenceSource),
          buildSide(comparisonSource),
        ]);
        setSkippedCounts({ reference: ref.skipped, comparison: cmp.skipped });
        mutation.mutate(buildCompareRequest(ref.side, cmp.side, toleranceTexts));
      } catch (err) {
        setFileError(err instanceof Error ? err.message : String(err));
      }
    })();
  };

  const onFileButton = (side: CompareSideName) => {
    fileSideRef.current = side;
    fileInputRef.current?.click();
  };

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file === undefined) return;
    const side = fileSideRef.current;
    setFileError(null);
    void file.text().then(
      (text) => {
        try {
          parseResultsDocumentFile(text, file.name);
        } catch (err) {
          setFileError(err instanceof Error ? err.message : String(err));
          return;
        }
        setSide(side, { kind: 'file', file });
        setFileLabels((prev) => ({ ...prev, [side]: file.name.replace(/\.[^.]*$/, '') }));
      },
      () => setFileError(`${file.name} could not be read`),
    );
  };

  const onSwap = () => {
    const a = referenceSource;
    const b = comparisonSource;
    setSide('reference', b);
    setSide('comparison', a);
    setFileLabels((prev) => ({ reference: prev.comparison, comparison: prev.reference }));
  };

  const data = mutation.data ?? null;
  const sortedSeries = useMemo(() => (data === null ? [] : sortSeriesRows(data.series)), [data]);

  // The overlay: the selected row's two sides, drawn in the plot when both
  // sides are runs kept in the store, else in a chart of the view's own.
  const selectedRow =
    selectedSeriesKey === null || data === null
      ? null
      : (data.series.find((r) => `${r.quantity}|${r.key}` === selectedSeriesKey) ?? null);
  const bothSidesAreRuns =
    referenceSource?.kind === 'run' &&
    comparisonSource?.kind === 'run' &&
    runs[referenceSource.runId] !== undefined &&
    runs[comparisonSource.runId] !== undefined;

  const overlayChart = useMemo(() => {
    if (selectedRow === null || bothSidesAreRuns) return null;
    // The two sides' series for this row, from the documents the view sent.
    // The documents are not kept in state; the row's own numbers at max_diff_t
    // are listed instead when no series can be found.
    return { row: selectedRow };
  }, [selectedRow, bothSidesAreRuns]);

  const onSelectSeriesRow = (rowId: string) => {
    const next = selectedSeriesKey === rowId ? null : rowId;
    selectSeries(next);
    const overlays = useExternalOverlaysStore.getState();
    overlays.removeTrace('compare-ref');
    overlays.removeTrace('compare-new');
    if (
      next === null ||
      !bothSidesAreRuns ||
      referenceSource?.kind !== 'run' ||
      comparisonSource?.kind !== 'run'
    ) {
      return;
    }
    const row = sortedSeries.find((r) => `${r.quantity}|${r.key}` === next);
    if (row === undefined) return;
    const refRun = useRunsStore.getState().runs[referenceSource.runId];
    const cmpRun = useRunsStore.getState().runs[comparisonSource.runId];
    if (refRun === undefined || cmpRun === undefined) return;
    // The series' two sides, from the runs' own columns: the key the server
    // reports is the neutral one, so the column is found by the series' index
    // among the document's series of the run, which the conversion built in
    // column order. When it cannot be found, the values at max_diff_t are
    // still listed in the row.
    const refCol = refRun.columns[row.key];
    const cmpCol = cmpRun.columns[row.key];
    const traces: ExternalOverlayTrace[] = [];
    if (refCol !== undefined) {
      traces.push({
        id: 'compare-ref',
        source: 'psse',
        name: `${row.quantity} ${row.key}`,
        label: `${runSideLabel(refRun)} · ${row.quantity} ${row.key}`,
        t: Float64Array.from(refRun.t.subarray(0, refRun.seqCount)),
        y: Float64Array.from(refCol.subarray(0, refRun.seqCount)),
        axis: 'left',
      });
    }
    if (cmpCol !== undefined) {
      traces.push({
        id: 'compare-new',
        source: 'psse',
        name: `${row.quantity} ${row.key}`,
        label: `${runSideLabel(cmpRun)} · ${row.quantity} ${row.key}`,
        t: Float64Array.from(cmpRun.t.subarray(0, cmpRun.seqCount)),
        y: Float64Array.from(cmpCol.subarray(0, cmpRun.seqCount)),
        axis: 'left',
      });
    }
    if (traces.length > 0) overlays.addTraces(traces);
  };

  const onClose = () => {
    const overlays = useExternalOverlaysStore.getState();
    overlays.removeTrace('compare-ref');
    overlays.removeTrace('compare-new');
    closeCompareView();
  };

  if (!open) return null;

  const errorDetail =
    mutation.error instanceof ProblemDetailsError
      ? (mutation.error.detail ?? mutation.error.title)
      : mutation.error instanceof Error
        ? mutation.error.message
        : null;

  return (
    <div
      data-testid="compare-view"
      role="dialog"
      aria-label="Compare results"
      className="bg-background fixed inset-0 z-40 flex flex-col"
    >
      <div className="border-border flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b px-3 py-2">
        <h2 className="text-foreground text-sm font-semibold">Compare results</h2>
        <SidePicker
          side="reference"
          testId="compare-view-select-a"
          title="A (reference)"
          hint="The result the differences are measured from."
          selectedRunId={referenceRunId}
          fileLabel={fileLabels.reference}
          otherRunId={comparisonRunId}
          runs={finishedRuns}
          onPick={(runId) => {
            setFileLabels((prev) => ({ ...prev, reference: null }));
            setSide('reference', { kind: 'run', runId });
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2"
          data-testid="compare-view-file-a"
          onClick={() => onFileButton('reference')}
        >
          From file…
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2"
          data-testid="compare-view-swap"
          title="Make B the reference and A the result compared with it"
          onClick={onSwap}
        >
          Swap A and B
        </Button>
        <SidePicker
          side="comparison"
          testId="compare-view-select-b"
          title="B"
          hint="The result compared with the reference."
          selectedRunId={comparisonRunId}
          fileLabel={fileLabels.comparison}
          otherRunId={referenceRunId}
          runs={finishedRuns}
          onPick={(runId) => {
            setFileLabels((prev) => ({ ...prev, comparison: null }));
            setSide('comparison', { kind: 'run', runId });
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2"
          data-testid="compare-view-file-b"
          onClick={() => onFileButton('comparison')}
        >
          From file…
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          data-testid="compare-view-file-input-a"
          className="hidden"
          onChange={onFileChange}
        />
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="compare-view-close"
          aria-label="Close compare view"
          onClick={onClose}
        >
          Close
        </Button>
      </div>
      {fileError !== null ? (
        <p role="alert" data-testid="compare-view-file-error" className="text-danger px-3 text-xs">
          {fileError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-x-4 gap-y-1.5 px-3 py-2">
        {Object.entries(DEFAULT_QUANTITY_TOLERANCES).map(([quantity, def]) => (
          <ToleranceField
            key={quantity}
            testId={`compare-view-tol-${quantity}`}
            label={quantity}
            unit={def.unit}
            text={toleranceTexts.quantities[quantity] ?? def.text}
            onChange={(text) => setQuantityTolerance(quantity, text)}
          />
        ))}
        <ToleranceField
          testId="compare-view-tol-frequency-hz"
          label="Frequency"
          unit="Hz"
          text={frequencyHz}
          onChange={(text) => setToleranceField('frequencyHz', text)}
        />
        <ToleranceField
          testId="compare-view-tol-damping"
          label="Damping ratio"
          unit={null}
          text={dampingRatio}
          onChange={(text) => setToleranceField('dampingRatio', text)}
        />
        <ToleranceField
          testId="compare-view-tol-mode-distance"
          label="Mode distance"
          unit="1/s"
          text={maxModeDistance}
          onChange={(text) => setToleranceField('maxModeDistance', text)}
        />
        <Button
          type="button"
          data-testid="compare-view-run"
          disabled={!bothSidesPicked || anyInvalid || mutation.isPending}
          onClick={onCompare}
        >
          Compare
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-3 pb-3">
        {!bothSidesPicked && data === null ? (
          <p data-testid="compare-view-empty" className="text-muted-foreground max-w-prose text-xs">
            Pick two results to compare: two runs kept in the run history, or a results document
            file for either side. Every difference is B minus A.
          </p>
        ) : null}
        {skippedCounts.reference + skippedCounts.comparison > 0 ? (
          <p data-testid="compare-view-skipped" className="text-muted-foreground text-xs">
            {skippedCounts.reference + skippedCounts.comparison} columns are not in the document
          </p>
        ) : null}
        {mutation.isPending ? (
          <p data-testid="compare-view-loading" className="text-muted-foreground text-xs">
            Comparing…
          </p>
        ) : null}
        {errorDetail !== null ? (
          <p role="alert" data-testid="compare-view-error" className="text-danger text-xs">
            {errorDetail}
          </p>
        ) : null}

        {data !== null ? (
          <>
            <section data-testid="compare-view-pflow">
              <h3 className="text-foreground text-xs font-semibold">Operating point</h3>
              {data.power_flow === null ? (
                <p data-testid="compare-view-pflow-none" className="text-muted-foreground text-xs">
                  Neither result carries a power flow table, so the operating points cannot be
                  compared.
                </p>
              ) : (
                <>
                  {data.power_flow.rows.some((r) => r.within_tolerance === false) ? (
                    <p
                      role="alert"
                      data-testid="compare-view-pflow-warning"
                      className="text-danger text-xs"
                    >
                      The two results start from different operating points:{' '}
                      {data.power_flow.rows.filter((r) => r.within_tolerance === false).length}{' '}
                      power flow{' '}
                      {data.power_flow.rows.filter((r) => r.within_tolerance === false).length === 1
                        ? 'value is'
                        : 'values are'}{' '}
                      outside tolerance. A dynamic difference that starts from a different operating
                      point is reported as that.
                    </p>
                  ) : (
                    <p
                      data-testid="compare-view-pflow-ok"
                      className="text-muted-foreground text-xs"
                    >
                      Same operating point within tolerance.
                    </p>
                  )}
                  <DataGrid
                    columns={PFLOW_COLUMNS}
                    rows={data.power_flow.rows}
                    rowIdAccessor={(r) => `${r.quantity}|${r.key}`}
                    emptyState="No power flow values compared."
                    testId="compare-view-pflow-grid"
                    ariaLabel="Operating point: B compared with A"
                    hint="The power flow comparison comes first."
                    filterable
                    copyable
                  />
                </>
              )}
            </section>

            <section data-testid="compare-view-series">
              <h3 className="text-foreground text-xs font-semibold">Series</h3>
              <DataGrid
                columns={SERIES_COLUMNS}
                rows={sortedSeries}
                rowIdAccessor={(r) => `${r.quantity}|${r.key}`}
                onRowClick={onSelectSeriesRow}
                selectedRowId={selectedSeriesKey}
                emptyState="No series compared."
                testId="compare-view-series-grid"
                ariaLabel="Series: B compared with A"
                hint="Outside tolerance first. Click a row to plot its two sides."
                filterable
                copyable
              />
              {selectedRow !== null ? (
                <p
                  data-testid="compare-view-series-row-selected"
                  className="text-muted-foreground text-xs"
                >
                  {selectedRow.quantity} {selectedRow.key}: at t = {selectedRow.max_diff_t} the
                  largest difference is {selectedRow.max_diff} {selectedRow.unit}.
                </p>
              ) : null}
            </section>

            {data.unmatched_series_reference.length > 0 ||
            data.unmatched_series_comparison.length > 0 ||
            data.unmatched_eigenvalues_reference.length > 0 ||
            data.unmatched_eigenvalues_comparison.length > 0 ||
            (data.power_flow !== null &&
              (data.power_flow.unmatched.missing_in_comparison.length > 0 ||
                data.power_flow.unmatched.missing_in_reference.length > 0)) ? (
              <section data-testid="compare-view-unmatched">
                <h3 className="text-foreground text-xs font-semibold">Unmatched</h3>
                {data.unmatched_series_reference.length > 0 ? (
                  <p
                    className="text-muted-foreground text-xs"
                    data-testid="compare-view-unmatched-series-reference"
                  >
                    Only in A: {data.unmatched_series_reference.join(', ')}
                  </p>
                ) : null}
                {data.unmatched_series_comparison.length > 0 ? (
                  <p
                    className="text-muted-foreground text-xs"
                    data-testid="compare-view-unmatched-series-comparison"
                  >
                    Only in B: {data.unmatched_series_comparison.join(', ')}
                  </p>
                ) : null}
                {data.power_flow !== null &&
                data.power_flow.unmatched.missing_in_comparison.length > 0 ? (
                  <p
                    className="text-muted-foreground text-xs"
                    data-testid="compare-view-unmatched-table-keys-reference"
                  >
                    Only in A: {data.power_flow.unmatched.missing_in_comparison.join(', ')}
                  </p>
                ) : null}
                {data.power_flow !== null &&
                data.power_flow.unmatched.missing_in_reference.length > 0 ? (
                  <p
                    className="text-muted-foreground text-xs"
                    data-testid="compare-view-unmatched-table-keys-comparison"
                  >
                    Only in B: {data.power_flow.unmatched.missing_in_reference.join(', ')}
                  </p>
                ) : null}
                {data.unmatched_eigenvalues_reference.length > 0 ? (
                  <p
                    className="text-muted-foreground text-xs"
                    data-testid="compare-view-unmatched-modes-reference"
                  >
                    Modes only in A: {data.unmatched_eigenvalues_reference.join(', ')}
                  </p>
                ) : null}
                {data.unmatched_eigenvalues_comparison.length > 0 ? (
                  <p
                    className="text-muted-foreground text-xs"
                    data-testid="compare-view-unmatched-modes-comparison"
                  >
                    Modes only in B: {data.unmatched_eigenvalues_comparison.join(', ')}
                  </p>
                ) : null}
              </section>
            ) : null}

            {data.eigenvalues.length > 0 ? (
              <section data-testid="compare-view-eig">
                <h3 className="text-foreground text-xs font-semibold">Eigenvalues</h3>
                <DataGrid
                  columns={EIG_COLUMNS}
                  rows={data.eigenvalues}
                  rowIdAccessor={(r) => `${r.index_ref}|${r.index_new}`}
                  emptyState="No modes matched."
                  testId="compare-view-eig-grid"
                  ariaLabel="Eigenvalues: the matched modes"
                  hint="Sorted by the reference frequency."
                  filterable
                  copyable
                />
              </section>
            ) : null}

            {data.errors.length > 0 ? (
              <section data-testid="compare-view-errors">
                {data.errors.map((message) => (
                  <p key={message} className="text-muted-foreground text-xs">
                    {message}
                  </p>
                ))}
              </section>
            ) : null}

            {overlayChart !== null ? (
              <div data-testid="compare-view-overlay-chart">
                <OverlayChart
                  row={overlayChart.row}
                  theme={resolvedTheme}
                  referenceSource={referenceSource}
                  comparisonSource={comparisonSource}
                />
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The small chart of the view's own for a selected series when a side is a
 * file: the two sides' series, read from the stored file or the run, the
 * reference solid and the comparison dashed.
 */
function OverlayChart({
  row,
  theme,
  referenceSource,
  comparisonSource,
}: {
  row: SeriesDifferenceOut;
  theme: 'light' | 'dark';
  referenceSource: CompareSource | null;
  comparisonSource: CompareSource | null;
}) {
  const [series, setSeries] = useState<{
    ref: { t: number[]; y: number[] } | null;
    cmp: { t: number[]; y: number[] } | null;
  }>({
    ref: null,
    cmp: null,
  });
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const rowId = `${row.quantity}|${row.key}`;

  if (loadedFor !== rowId) {
    setLoadedFor(rowId);
    void (async () => {
      const load = async (
        source: CompareSource | null,
      ): Promise<{ t: number[]; y: number[] } | null> => {
        if (source === null) return null;
        if (source.kind === 'file') {
          const text = await source.file.text();
          const side = parseResultsDocumentFile(text, source.file.name);
          const found = (side.document.series ?? []).find((s) => `${s.quantity}|${s.of}` === rowId);
          // ``parseResultsDocumentFile`` has checked that t and y are arrays.
          return found === undefined || found.t === null || found.y === null
            ? null
            : { t: found.t as number[], y: found.y as number[] };
        }
        const run = useRunsStore.getState().runs[source.runId];
        if (run === undefined) return null;
        const col = run.columns[row.key];
        if (col === undefined) return null;
        return {
          t: Array.from(run.t.subarray(0, run.seqCount)),
          y: Array.from(col.subarray(0, run.seqCount)),
        };
      };
      try {
        const [ref, cmp] = await Promise.all([load(referenceSource), load(comparisonSource)]);
        setSeries({ ref, cmp });
      } catch {
        setSeries({ ref: null, cmp: null });
      }
    })();
  }

  const palette = theme === 'dark' ? PALETTE_DARK : PALETTE_LIGHT;
  const chart = useMemo(() => {
    const t: number[] = [];
    const refY: number[] = [];
    const cmpY: number[] = [];
    if (series.ref !== null) {
      for (let i = 0; i < series.ref.t.length; i += 1) {
        t.push(series.ref.t[i]!);
        refY.push(series.ref.y[i]!);
        cmpY.push(NaN);
      }
    }
    if (series.cmp !== null) {
      for (let i = 0; i < series.cmp.t.length; i += 1) {
        t.push(series.cmp.t[i]!);
        refY.push(NaN);
        cmpY.push(series.cmp.y[i]!);
      }
    }
    const order = t.map((_, i) => i).sort((a, b) => t[a]! - t[b]!);
    const x = new Float64Array(order.length);
    const yRef = new Float64Array(order.length);
    const yCmp = new Float64Array(order.length);
    // NaN gaps break the line where a side has no sample, as the plot's own
    // aligned columns do.
    for (let k = 0; k < order.length; k += 1) {
      const i = order[k]!;
      x[k] = t[i]!;
      yRef[k] = refY[i]!;
      yCmp[k] = cmpY[i]!;
    }
    const data: uPlot.AlignedData = [x, yRef, yCmp];
    const options = {
      width: 600,
      height: 200,
      scales: { x: { time: false } },
      series: [
        { label: 't' },
        {
          label: `${row.quantity} ${row.key} (A)`,
          stroke: palette[0]!,
          width: 1.5,
          points: { show: false },
        },
        {
          label: `${row.quantity} ${row.key} (B)`,
          stroke: palette[1]!,
          width: 1.5,
          points: { show: false },
          dash: [6, 4],
        },
      ],
      axes: [{ label: 't (s)' }, { label: row.unit }],
      legend: { show: true },
    };
    return { options, data };
  }, [series, row, palette]);

  if (series.ref === null && series.cmp === null) {
    return (
      <p className="text-muted-foreground text-xs">
        At t = {row.max_diff_t}: A is {row.quantity} {row.key}, the largest difference is{' '}
        {row.max_diff} {row.unit}.
      </p>
    );
  }
  return <UPlot options={chart.options} data={chart.data} />;
}
