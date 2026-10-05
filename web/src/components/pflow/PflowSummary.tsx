import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { ExportMenu } from '@/components/export/ExportMenu';
import { recordsToCsv } from '@/components/export/exportToCsv';
import { useExportCaseName } from '@/components/export/useExportCaseName';
import { usePflowStore } from '@/store/pflow';
import { usePflowHistoryStore } from '@/store/pflowHistory';
import { openPflowComparePanel } from '@/lib/openPflowPanel';
import { describeSettings } from '@/lib/pflowOptions';
import { lossShare, summaryRows } from '@/lib/pflowSummary';

/**
 * PflowSummary: how the last power flow came out, and what the whole system
 * draws and makes. Generation, load, bus shunts and line losses, in P and in Q
 * (generation = load + shunts + losses, to the solver's tolerance), and the
 * slack generator's share of the generation.
 *
 * It reads the last converged run from the pflow slice. After a time-domain run
 * that slice holds the end-state operating point instead (bus voltages only), which
 * has no totals, and the panel says so rather than showing a stale table.
 *
 * Once a second power flow has converged, a button leads to the Compare tab,
 * where the result is set against an earlier one.
 */

export interface PflowSummaryProps {
  className?: string;
}

function mw(value: number | null): string {
  return value === null ? '-' : value.toFixed(2);
}

export function PflowSummary({ className }: PflowSummaryProps) {
  const lastRun = usePflowStore((s) => s.lastRun);
  const comparable = usePflowHistoryStore((s) => s.snapshots.length > 1);
  const caseName = useExportCaseName();
  const summary = lastRun?.summary ?? null;
  const settings = lastRun?.settings ?? null;
  const rows = useMemo(() => (summary === null ? [] : summaryRows(summary)), [summary]);

  const onExportCsv = () => {
    if (summary === null) return null;
    return recordsToCsv({
      columns: ['quantity', 'P (MW)', 'Q (MVAr)'],
      rows: rows.map((r) => [r.label, r.p, r.q]),
      comments: settings === null ? undefined : [`Settings: ${describeSettings(settings)}`],
    });
  };

  let status: string;
  if (lastRun === null) {
    status = 'Run a power flow to see what the system generates, draws and loses.';
  } else if (!lastRun.converged) {
    status = `The last power flow did not converge in ${lastRun.iterations} iterations, so there are no totals. The banner above the diagram has adjusted retries.`;
  } else if (summary === null) {
    status =
      'The operating point on screen was read after a time-domain run, which gives no totals. Run a power flow for them.';
  } else {
    status = `Converged in ${lastRun.iterations} iterations, final mismatch ${lastRun.mismatch.toExponential(2)}.`;
  }

  const share = summary === null ? null : lossShare(summary);

  return (
    <section
      data-testid="pflow-summary"
      aria-label="Power flow system summary"
      className={cn('flex flex-col gap-3', className)}
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-foreground text-sm font-semibold">System summary</h2>
        <div className="flex items-center gap-1">
          {comparable ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={openPflowComparePanel}
              title="Set this result against an earlier power flow: what each voltage, angle and line flow changed by"
              data-testid="pflow-summary-compare"
              className="text-xs"
            >
              Compare with an earlier run
            </Button>
          ) : null}
          <ExportMenu
            formats={['csv']}
            panel="pf-summary"
            caseName={caseName}
            disabled={summary === null}
            disabledTooltip="Run a power flow to export its totals"
            onExportCsv={onExportCsv}
            label="Export summary"
          />
        </div>
      </header>

      <p data-testid="pflow-summary-status" className="text-muted-foreground text-xs leading-snug">
        {status}
        {summary !== null && settings !== null ? (
          <span data-testid="pflow-summary-settings"> Ran with {describeSettings(settings)}.</span>
        ) : null}
      </p>

      {summary === null ? null : (
        <>
          <table data-testid="pflow-summary-table" className="w-full max-w-md text-xs">
            <thead>
              <tr className="text-muted-foreground border-border border-b text-left">
                <th scope="col" className="py-1 font-medium">
                  <span className="sr-only">Quantity</span>
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  P (MW)
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Q (MVAr)
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  data-testid={`pflow-summary-row-${row.id}`}
                  title={row.title}
                  className={cn(
                    'border-border/50 border-b last:border-b-0',
                    row.id === 'slack' ? 'text-muted-foreground' : 'text-foreground',
                  )}
                >
                  <th
                    scope="row"
                    className={cn('py-1 text-left font-normal', row.id === 'slack' ? 'pl-3' : '')}
                  >
                    {row.label}
                  </th>
                  <td className="py-1 text-right font-mono tabular-nums">{mw(row.p)}</td>
                  <td className="py-1 text-right font-mono tabular-nums">{mw(row.q)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-muted-foreground text-[10px] leading-snug">
            Generation equals load plus bus shunts plus line losses
            {share === null ? '' : `; the lines lose ${share.toFixed(2)}% of the active generation`}
            . A negative Q is reactive power supplied, by a capacitor or by line charging.
          </p>
        </>
      )}
    </section>
  );
}
