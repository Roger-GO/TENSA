import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import type { CpfResult } from '@/api/types';
import { moreSteps, stepLimitReached } from '@/lib/cpfOptions';

/**
 * CpfStepLimitNote: what to do about a nose-curve run that used up its steps.
 *
 * A run takes 500 steps unless Max steps says otherwise, and ANDES sizes each
 * step itself, moving lambda by half a unit at most. A path that is long in
 * lambda therefore ends before its nose, which is what a custom direction
 * made of small increases gives: lambda counts multiples of them. The result
 * is a curve that stops, and nothing in it says that more steps would have
 * finished it. This says so where the run was started, with the button that
 * does it.
 *
 * Nothing renders for a run that ended any other way. Presentational: the
 * parent owns the result and starts the run.
 *
 * Test hooks: ``cpf-step-limit-note`` and ``cpf-step-limit-run-again``.
 */
export interface CpfStepLimitNoteProps {
  result: CpfResult | null;
  /** Start a run that may take this many steps. */
  onRunAgain: (maxSteps: number) => void;
  /** No run can be started now: one is under way, or the routine is not ready. */
  disabled?: boolean;
  className?: string;
}

function lambdaText(value: number | undefined): string {
  return value === undefined ? '?' : value.toFixed(4);
}

export function CpfStepLimitNote({
  result,
  onRunAgain,
  disabled = false,
  className,
}: CpfStepLimitNoteProps) {
  const limit = result === null ? null : stepLimitReached(result);
  if (result === null || limit === null) return null;

  const next = moreSteps(limit);
  const last = lambdaText(result.lambdas[result.lambdas.length - 1]);

  return (
    <div
      data-testid="cpf-step-limit-note"
      role="status"
      className={cn(
        'border-warning/40 bg-warning/10 text-foreground',
        'flex flex-wrap items-center gap-2 rounded border px-2 py-1.5 text-[11px] leading-snug',
        className,
      )}
    >
      <span className="min-w-0 flex-1 basis-72">
        {result.truncated
          ? `The run used all of its ${limit} steps and stopped at λ = ${last}, before it reached the nose. The curve below ends there.`
          : `The run used all of its ${limit} steps: it found the nose (λ = ${lambdaText(result.max_lam)}) and stopped on the lower branch at λ = ${last}, before it was back at the base load.`}{' '}
        {result.direction === 'custom'
          ? 'With a custom direction λ counts multiples of the increases you typed, and one step moves λ by half a unit at most, so small increases make a long path. More steps take it further, and so do larger numbers: ten times the increases is the same curve at a tenth of the λ.'
          : 'More steps take it further.'}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => onRunAgain(next)}
        data-testid="cpf-step-limit-run-again"
      >
        Run again with up to {next} steps
      </Button>
    </div>
  );
}
