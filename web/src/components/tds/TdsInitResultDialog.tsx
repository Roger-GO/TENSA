import { useId } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import type { TdsInitClamp, TdsInitResidual, TdsInitResult } from '@/api/types';
import { describeError } from '@/lib/describeError';
import { runLockNotice } from '@/lib/runLock';
import { formatSignificant } from '@/lib/series';
import { cn } from '@/lib/cn';

/**
 * TdsInitResultDialog. The answer of the "Check initialisation" action in the
 * menu beside the TDS run control: whether every dynamic model starts at a steady state,
 * with the clamped-limit and residual tables when it does not, and what the
 * check did to the session. The check sets the system up and initialises the
 * run, so the dialog says what every place a run has fixed the system says
 * (`runLockNotice`), with Reset run beside it, and what the next run does.
 *
 * The dialog receives the result, or the error, by props and imports nothing
 * from `@/api/queries`; the RunButton owns the mutation and the reset.
 */
export interface TdsInitResultDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The successful response; mutually exclusive with ``error``. */
  result: TdsInitResult | null;
  /**
   * The thrown error (a 422 ``ProblemDetailsError`` or any other failure);
   * mutually exclusive with ``result``. ``describeError`` reads the server's
   * detail off a ``ProblemDetailsError`` and the message off anything else.
   */
  error: Error | null;
  /** Whether Reset run would lose edits (`useReloadDiscardsEdits`), for the lock's wording. */
  discardsEdits: boolean;
  /** Reset run, as the run button does it. */
  onResetRun: () => void;
  /** A reset is under way. */
  resetting: boolean;
  /**
   * Disturbances are listed for the next run: it then reads the case again to
   * add them, and initialises afresh rather than from this check.
   */
  disturbancesListed: boolean;
  /** Where the focus goes when the dialog closes (Radix's `onCloseAutoFocus`). */
  onCloseAutoFocus?: (event: Event) => void;
}

/** A value of the tables, to four significant digits. */
function cell(value: number): string {
  return formatSignificant(value, 4);
}

/** The verdict, true to `test_ok`: passed, failed, or not checked. */
function verdictLines(result: TdsInitResult, residualRows: number): string[] {
  const testOk = result.test_ok ?? null;
  if (testOk === true) return ['Every dynamic model starts at a steady state.'];
  if (testOk === null) {
    return ['The check was switched off; the lists below were computed without it.'];
  }
  const count = `${residualRows}${result.diagnostics_truncated ? ' or more' : ''}`;
  const lines = [
    `${count} equations do not balance at the start; the largest residual is ${formatSignificant(result.max_residual, 3)}.`,
  ];
  if (result.nan_residuals > 0) {
    lines.push(
      `${result.nan_residuals} residuals are not numbers, which usually means a parameter of zero where a model divides by it.`,
    );
  }
  return lines;
}

/** What the next Run TDS does after this check. */
function nextRunNote(result: TdsInitResult, disturbancesListed: boolean): string {
  if (disturbancesListed) {
    return 'Run TDS reads the case again to add the listed disturbances, so it initialises afresh rather than from this check.';
  }
  const base =
    'Run TDS carries on from this initialisation: its record starts at the first step, not at 0 s.';
  return result.test_ok === false
    ? `${base} Since the check failed, that run is reported as not converged.`
    : base;
}

const noteClasses =
  'border-border bg-muted/30 text-muted-foreground rounded border px-2.5 py-1.5 text-xs';

export function TdsInitResultDialog({
  open,
  onOpenChange,
  result,
  error,
  discardsEdits,
  onResetRun,
  resetting,
  disturbancesListed,
  onCloseAutoFocus,
}: TdsInitResultDialogProps) {
  const clampedLabelId = useId();
  const residualsLabelId = useId();
  const clamped: TdsInitClamp[] = result?.clamped ?? [];
  const residuals: TdsInitResidual[] = result?.residuals ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="tds-init-dialog"
        widthClassName="max-w-2xl"
        className="flex max-h-[90vh] flex-col"
        {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
      >
        <DialogTitle>Check initialisation</DialogTitle>
        {error !== null ? (
          <DialogDescription className="mt-2" data-testid="tds-init-error" asChild>
            <p>The initialisation could not be checked: {describeError(error)}</p>
          </DialogDescription>
        ) : null}
        {result !== null ? (
          <div className="mt-2 flex min-h-0 flex-col gap-2 overflow-y-auto">
            <DialogDescription asChild>
              <div data-testid="tds-init-verdict" className="text-foreground text-sm">
                {verdictLines(result, residuals.length).map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </DialogDescription>
            <p className="text-muted-foreground text-xs" data-testid="tds-init-counts">
              {result.n_states} state variables, {result.n_algeb} algebraic variables.
            </p>
            {clamped.length > 0 ? (
              <div
                data-testid="tds-init-clamped"
                className="border-border bg-background flex shrink-0 flex-col overflow-hidden rounded border"
              >
                <div
                  id={clampedLabelId}
                  className="border-border text-muted-foreground border-b px-2 py-0.5 text-[10px]"
                >
                  Variables clamped at a limit
                </div>
                <div className="max-h-60 overflow-auto">
                  <table className="w-full text-xs" aria-labelledby={clampedLabelId}>
                    <thead className="bg-background text-muted-foreground sticky top-0">
                      <tr className="bg-muted/40">
                        <th scope="col" className="px-2 py-1 text-left font-medium">
                          Model
                        </th>
                        <th scope="col" className="px-2 py-1 text-left font-medium">
                          Idx
                        </th>
                        <th scope="col" className="px-2 py-1 text-left font-medium">
                          Variable
                        </th>
                        <th scope="col" className="px-2 py-1 text-left font-medium">
                          Limit
                        </th>
                        <th scope="col" className="px-2 py-1 text-right font-medium">
                          Limit value
                        </th>
                        <th scope="col" className="px-2 py-1 text-right font-medium">
                          Wanted value
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {clamped.map((row, i) => (
                        <tr
                          key={`${row.model}-${row.idx}-${row.var}-${i}`}
                          data-testid={`tds-init-clamped-row-${i}`}
                          className="border-border/60 hover:bg-muted/30 border-t"
                        >
                          <td className="px-2 py-1 font-mono break-all">{row.model}</td>
                          <td className="px-2 py-1 font-mono break-all">{row.idx}</td>
                          <td className="px-2 py-1 font-mono break-all">{row.var}</td>
                          <td className="px-2 py-1 font-mono break-all">{row.limit_name}</td>
                          <td className="px-2 py-1 text-right font-mono">{cell(row.limit_val)}</td>
                          <td className="px-2 py-1 text-right font-mono">{cell(row.unconstr)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
            {residuals.length > 0 ? (
              <div
                data-testid="tds-init-residuals"
                className="border-border bg-background flex shrink-0 flex-col overflow-hidden rounded border"
              >
                <div
                  id={residualsLabelId}
                  className="border-border text-muted-foreground border-b px-2 py-0.5 text-[10px]"
                >
                  Equations that do not balance
                </div>
                <div className="max-h-60 overflow-auto">
                  <table className="w-full text-xs" aria-labelledby={residualsLabelId}>
                    <thead className="bg-background text-muted-foreground sticky top-0">
                      <tr className="bg-muted/40">
                        <th scope="col" className="px-2 py-1 text-left font-medium">
                          Name
                        </th>
                        <th scope="col" className="px-2 py-1 text-right font-medium">
                          Mismatch
                        </th>
                        <th scope="col" className="px-2 py-1 text-left font-medium">
                          Equation
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {residuals.map((row, i) => (
                        <tr
                          key={`${row.name}-${i}`}
                          data-testid={`tds-init-residual-row-${i}`}
                          className="border-border/60 hover:bg-muted/30 border-t align-top"
                        >
                          <td className="px-2 py-1 font-mono break-all">{row.name}</td>
                          <td className="px-2 py-1 text-right font-mono whitespace-nowrap">
                            {row.mismatch === null ? 'not a number' : cell(row.mismatch)}
                          </td>
                          <td className="px-2 py-1 font-mono break-all whitespace-pre-wrap">
                            {row.equation}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
            {result.diagnostics_truncated ? (
              <p className={noteClasses} data-testid="tds-init-truncated">
                The lists were cut at 500 rows; the full tables are in the session messages.
              </p>
            ) : null}
            <div
              className={cn(noteClasses, 'flex flex-col gap-1')}
              data-testid="tds-init-session-note"
            >
              <p>{runLockNotice(discardsEdits)}</p>
              <p>{nextRunNote(result, disturbancesListed)}</p>
            </div>
          </div>
        ) : null}
        <DialogFooter className="mt-4">
          {result !== null ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={resetting}
              onClick={() => {
                onOpenChange(false);
                onResetRun();
              }}
              data-testid="tds-init-reset-run"
            >
              {resetting ? 'Reloading…' : 'Reset run'}
            </Button>
          ) : null}
          <DialogClose asChild>
            <Button type="button" variant="primary" size="sm" data-testid="tds-init-close">
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
