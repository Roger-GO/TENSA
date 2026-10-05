import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { usePflowStore } from '@/store/pflow';
import { usePflowOptionsStore } from '@/store/pflowOptions';
import { usePflowRunAction } from '@/lib/usePflowRunAction';
import { shownSwitch } from '@/lib/pflowOptions';
import { assessQLimit } from '@/components/sld/qLimit';
import type { PflowResult } from '@/api/types';

/**
 * CpfQLimitsSwitch: the "Enforce generator Q limits" box of the two CPF forms
 * (nose curve and QV curve).
 *
 * It is the power-flow options' own switch, not a second one. A continuation
 * starts from the solved power flow, so a curve that holds generators to their
 * limits needs a power flow that did: one setting for both keeps them
 * together, and the "Run power flow" a refused run offers then solves it the
 * right way. The run hooks read the same store when a run starts.
 *
 * When the box is ticked and the last power flow left generators past a limit,
 * the server would refuse the run (409). The note says so beforehand and runs
 * the power flow again, with the limits on, from a button.
 *
 * Test hooks: ``{idPrefix}-enforce-q-limits`` (the checkbox),
 * ``{idPrefix}-enforce-q-limits-case-note``,
 * ``{idPrefix}-q-limits-pflow-note`` and ``{idPrefix}-q-limits-run-pflow``.
 */
export interface CpfQLimitsSwitchProps {
  /** Prefix of the element ids, so the two CPF forms do not share one. */
  idPrefix: string;
  className?: string;
}

/** How many generator names a note lists before it counts the rest. */
const MAX_NAMED = 4;

/**
 * The generators a converged power flow leaves past a reactive limit, by idx.
 * Empty for no result, or one without generator rows (the operating point read
 * back after a time-domain run).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function generatorsPastLimits(pflow: PflowResult | null): string[] {
  if (pflow === null || !pflow.converged) return [];
  const past: string[] = [];
  for (const [idx, row] of Object.entries(pflow.generator_outputs ?? {})) {
    const state = assessQLimit(row.q, row.q_min, row.q_max);
    if (state === 'above-max' || state === 'below-min') past.push(idx);
  }
  return past;
}

function named(idx: readonly string[]): string {
  const shown = idx.slice(0, MAX_NAMED).join(', ');
  const more = idx.length - MAX_NAMED;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

export function CpfQLimitsSwitch({ idPrefix, className }: CpfQLimitsSwitchProps) {
  const choice = usePflowOptionsStore((s) => s.options.enforceQLimits);
  const caseOwn = usePflowOptionsStore((s) => s.caseSettings.enforceQLimits);
  const setOptions = usePflowOptionsStore((s) => s.setOptions);
  const lastPf = usePflowStore((s) => s.lastRun);
  const pfRunning = usePflowStore((s) => s.isRunning);
  const runPflow = usePflowRunAction();

  const id = `${idPrefix}-enforce-q-limits`;
  const checked = shownSwitch(choice, caseOwn);
  const past = checked ? generatorsPastLimits(lastPf) : [];

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label
        htmlFor={id}
        className={cn(
          'flex items-start gap-2',
          'cursor-pointer rounded px-1 py-1',
          'hover:bg-muted/40 transition-colors',
        )}
      >
        <input
          id={id}
          data-testid={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => setOptions({ enforceQLimits: e.target.checked })}
          className={cn(
            'border-border mt-0.5 h-3.5 w-3.5 rounded border',
            'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          )}
        />
        <span className="flex flex-col">
          <span className="text-foreground text-xs">Enforce generator Q limits</span>
          <span className="text-muted-foreground text-[10px] leading-snug">
            Hold each generator at its Qmin or Qmax from the point where it gets there, and let its
            voltage go. Without it generators supply whatever the curve asks for and the nose comes
            later than the limits allow. This is the same switch as in the power flow options: the
            curve starts from the power flow, so both use it.
          </span>
          {caseOwn === true ? (
            <span
              data-testid={`${id}-case-note`}
              className="text-muted-foreground text-[10px] leading-snug"
            >
              {choice === false
                ? 'The case itself turns this on. Runs go without it while this is unticked.'
                : 'The case itself turns this on. Untick it to run without.'}
            </span>
          ) : null}
        </span>
      </label>

      {past.length > 0 ? (
        <div
          data-testid={`${idPrefix}-q-limits-pflow-note`}
          role="status"
          className={cn(
            'border-warning/40 bg-warning/10 text-foreground',
            'flex flex-wrap items-center gap-2 rounded border px-2 py-1.5 text-[11px] leading-snug',
          )}
        >
          <span className="min-w-0 flex-1">
            The last power flow left {past.length === 1 ? 'generator' : 'generators'} {named(past)}{' '}
            past a Q limit. The curve starts from that solution, so run the power flow again with
            the limits on first.
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pfRunning}
            onClick={runPflow}
            data-testid={`${idPrefix}-q-limits-run-pflow`}
          >
            {pfRunning ? 'Running PF…' : 'Run power flow with Q limits'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
