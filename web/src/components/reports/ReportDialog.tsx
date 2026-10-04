/**
 * ReportDialog (Unit 4 of the v2.0 plan).
 *
 * Modal that renders human-readable reports from ``PFlow.report()``,
 * ``TDS.summary()`` and ``EIG.report()``. The dialog
 * has a tab strip per routine; each tab shows the verbatim plain-text
 * body plus a :class:`LatexCopyButton` that serialises the structured
 * tables for paste into a paper.
 *
 * Wiring:
 *
 * - Trigger: ``<ReportDialogButton />`` (mounted in the TopBar). On
 *   click, opens the dialog via ``useReportDialogStore.openDialog()``.
 * - Per-tab data: ``useReport(routine, hasRunResult)`` from
 *   ``api/queries.ts``. Gated on ``hasRunResult`` so the dialog
 *   doesn't fire a guaranteed-409 when no run has happened yet.
 * - Empty / error states: a 409 ``ProblemDetailsError`` is treated as
 *   the empty state (with the substrate's actionable message). Other
 *   errors render in a ``role="alert"`` block (consistent with Unit 2's
 *   no-toast inline-error pattern).
 *
 * The deferred-mount pattern from BundleExportDialog is reused: the
 * dialog body is only mounted when ``dialogOpen`` is true, so unit
 * tests of the trigger button (which don't mount a QueryClientProvider)
 * stay green.
 */
import { useMemo } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import type { ReportResponse, ReportRoutine } from '@/api/queries';
import { useReport } from '@/api/queries';
import { ProblemDetailsError } from '@/api/client';
import { useSessionStore } from '@/store/session';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import { useReportDialogStore } from '@/store/reportDialog';
import { LatexCopyButton, type LatexReportTable } from '@/components/reports/LatexCopyButton';
import { cn } from '@/lib/cn';

// ---- trigger button -------------------------------------------------------

export function ReportDialogButton() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const openDialog = useReportDialogStore((s) => s.openDialog);
  // The button stays enabled even when no run has happened yet — the
  // dialog itself surfaces the "Run PFlow first" empty state per tab,
  // which is more discoverable than a disabled button with no
  // tooltip.
  const enabled = sessionId !== null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!enabled}
      onClick={() => openDialog()}
      data-testid="report-dialog-button"
    >
      Report
    </Button>
  );
}

// ---- dialog wrapper (deferred mount) -------------------------------------

export function ReportDialog() {
  const dialogOpen = useReportDialogStore((s) => s.dialogOpen);
  const closeDialog = useReportDialogStore((s) => s.closeDialog);
  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(next) => {
        if (!next) closeDialog();
      }}
    >
      {dialogOpen ? <ReportDialogInner /> : null}
    </Dialog>
  );
}

// ---- dialog inner --------------------------------------------------------

function ReportDialogInner() {
  const activeRoutine = useReportDialogStore((s) => s.activeRoutine);
  const setActiveRoutine = useReportDialogStore((s) => s.setActiveRoutine);

  // "Has the routine produced a result on the current session?" gates
  // the report query so we don't fire a guaranteed-409 on first open.
  const pflowConverged = usePflowStore((s) => s.lastRun?.converged === true);
  const activeRunId = useRunsStore((s) => s.activeRunId);
  const runs = useRunsStore((s) => s.runs);
  const tdsRunCompleted = useMemo(() => {
    if (activeRunId === null) return false;
    const run = runs[activeRunId];
    if (run === undefined) return false;
    // TDS report only meaningful when the run has actually advanced —
    // ``done`` (clean exit) and ``aborted`` (partial run) both
    // populate ``ss.dae.t > 0`` so the substrate can serve a report.
    // ``error`` runs may have hit zero steps; the substrate's 409
    // gate covers that case if we're optimistic here.
    return run.state === 'done' || run.state === 'aborted' || run.state === 'error';
  }, [activeRunId, runs]);

  return (
    <DialogContent data-testid="report-dialog" className="max-w-3xl">
      <DialogTitle>Reports</DialogTitle>
      <DialogDescription className="mt-2">
        Human-readable reports for the active session. Use <strong>Copy as LaTeX</strong> to paste a{' '}
        <code>tabular</code> block into your paper.
      </DialogDescription>

      <Tabs
        value={activeRoutine}
        onValueChange={(value) => setActiveRoutine(value as ReportRoutine)}
        className="mt-4 flex flex-col gap-3"
      >
        <TabsList>
          <TabsTrigger value="pflow" data-testid="report-tab-pflow">
            Power flow
          </TabsTrigger>
          <TabsTrigger value="tds" data-testid="report-tab-tds">
            TDS
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pflow">
          <ReportTabBody
            routine="pflow"
            hasRun={pflowConverged}
            emptyHint="Run PFlow first to populate the power-flow report."
          />
        </TabsContent>
        <TabsContent value="tds">
          <ReportTabBody
            routine="tds"
            hasRun={tdsRunCompleted}
            emptyHint="Run a TDS simulation first to populate the TDS report."
          />
        </TabsContent>
      </Tabs>
    </DialogContent>
  );
}

// ---- per-tab body --------------------------------------------------------

interface ReportTabBodyProps {
  routine: ReportRoutine;
  hasRun: boolean;
  emptyHint: string;
}

function ReportTabBody({ routine, hasRun, emptyHint }: ReportTabBodyProps) {
  const query = useReport(routine, hasRun);

  if (!hasRun) {
    return (
      <div
        data-testid={`report-empty-${routine}`}
        className={cn(
          'border-border bg-muted/30 text-muted-foreground',
          'rounded-[var(--radius-sm)] border px-3 py-2 text-sm',
        )}
      >
        {emptyHint}
      </div>
    );
  }

  if (query.isLoading) {
    return (
      <div data-testid={`report-loading-${routine}`} className="text-muted-foreground text-sm">
        Loading report…
      </div>
    );
  }

  if (query.isError) {
    const err = query.error;
    // 409 from the substrate means "no run yet" — surface as the
    // empty state with the substrate's actionable detail message.
    if (err instanceof ProblemDetailsError && err.status === 409) {
      return (
        <div
          data-testid={`report-empty-${routine}`}
          className={cn(
            'border-border bg-muted/30 text-muted-foreground',
            'rounded-[var(--radius-sm)] border px-3 py-2 text-sm',
          )}
        >
          {err.detail ?? err.title ?? emptyHint}
        </div>
      );
    }
    const detail =
      err instanceof ProblemDetailsError
        ? (err.detail ?? err.title ?? `HTTP ${err.status}`)
        : err instanceof Error
          ? err.message
          : 'unknown error';
    return (
      <div
        role="alert"
        data-testid={`report-error-${routine}`}
        className={cn(
          'border-danger/30 bg-danger/10 text-foreground',
          'rounded-[var(--radius-sm)] border px-3 py-2 text-sm',
        )}
      >
        Report failed: {detail}
      </div>
    );
  }

  const data = query.data as ReportResponse | undefined;
  if (data === undefined) {
    return null;
  }

  const tables: LatexReportTable[] = data.structured.tables.map((t) => ({
    title: t.title,
    headers: [...t.headers],
    rows: t.rows.map((row) => [...row]),
  }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end">
        <LatexCopyButton tables={tables} testIdSuffix={routine} />
      </div>
      <pre
        data-testid={`report-plain-text-${routine}`}
        className={cn(
          'border-border bg-muted/30 max-h-72 overflow-auto',
          'rounded-[var(--radius-sm)] border px-3 py-2',
          'font-mono text-xs whitespace-pre',
        )}
      >
        {data.plain_text}
      </pre>
      {tables.length > 0 ? (
        <div className="flex flex-col gap-3">
          {tables.map((table, idx) => (
            <StructuredTable
              key={`${routine}-${table.title}-${idx}`}
              routine={routine}
              index={idx}
              table={table}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface StructuredTableProps {
  routine: ReportRoutine;
  index: number;
  table: LatexReportTable;
}

function StructuredTable({ routine, index, table }: StructuredTableProps) {
  return (
    <div
      data-testid={`report-structured-table-${index}`}
      data-routine={routine}
      className="flex flex-col gap-1"
    >
      <span className="text-muted-foreground text-xs font-medium">{table.title}</span>
      <div className="border-border max-h-48 overflow-auto rounded-[var(--radius-sm)] border">
        <table className="w-full text-left text-xs">
          <thead className="bg-muted/40">
            <tr>
              {table.headers.map((h, i) => (
                <th key={`${h}-${i}`} className="border-border border-b px-2 py-1 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rIdx) => (
              <tr key={rIdx}>
                {row.map((cell, cIdx) => (
                  <td key={cIdx} className="border-border/50 border-b px-2 py-1 font-mono">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
