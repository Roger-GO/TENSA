/**
 * ModifiedFromOriginalDot (v3.1 Unit 23).
 *
 * A 4px ``bg-warning`` dot rendered next to a clone-editable param label when
 * that param's value in the clone file differs from the original case file. The
 * hover tooltip surfaces both values ("Original: X → Y") and a one-click
 * "Revert this field" mini-button that re-applies the original value via
 * ``useCloneEdit``.
 *
 * The dot is purely presentational: the caller (``ElementFormFields``) reads the
 * per-device diff via ``useCloneDiff`` once and passes each changed param's
 * ``{original, current}`` pair down. Params not in the diff render no dot.
 */
import { useCloneEdit } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import type { CloneDiffPair, ParamValue } from '@/api/types';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';

/** Format a diff value for the tooltip ("—" for an absent value). */
function formatDiffValue(v: ParamValue | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v);
    if (Number.isInteger(v)) return String(v);
    // Trim to 6 significant figures but drop trailing zeros so "1.5" reads
    // as "1.5", not "1.50000".
    return String(Number(v.toPrecision(6)));
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v;
}

export interface ModifiedFromOriginalDotProps {
  /** ANDES model class of the device (e.g. ``IEEEX1``). */
  model: string;
  /** Device idx (stringified). */
  idx: string;
  /** Param name this dot annotates. */
  param: string;
  /** The clone-vs-original value pair for this param. */
  diff: CloneDiffPair;
  className?: string;
}

export function ModifiedFromOriginalDot({
  model,
  idx,
  param,
  diff,
  className,
}: ModifiedFromOriginalDotProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const cloneEdit = useCloneEdit();

  const original = diff.original ?? null;
  const current = diff.current ?? null;

  const handleRevert = () => {
    // Revert is a clone-edit back to the original file value. Skip when the
    // original is absent (nothing meaningful to revert to) or no session.
    if (sessionId === null || original === null) return;
    cloneEdit.mutate({ sessionId, model, idx, param, value: original });
  };

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            aria-label={`${param} modified from original`}
            data-testid={`modified-dot-${param}`}
            className={cn('bg-warning inline-block h-1 w-1 rounded-full', className)}
          />
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent
            data-testid={`modified-dot-tooltip-${param}`}
            className="flex flex-col gap-1.5"
          >
            <span>
              Original: {formatDiffValue(original)} → {formatDiffValue(current)}
            </span>
            <button
              type="button"
              data-testid={`modified-dot-revert-${param}`}
              disabled={cloneEdit.isPending || sessionId === null || original === null}
              onClick={handleRevert}
              className={cn(
                'self-start rounded-[var(--radius-sm)] px-1.5 py-0.5',
                'bg-background text-foreground text-[10px] font-medium',
                'hover:bg-muted transition-colors duration-[var(--duration-fast)]',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {cloneEdit.isPending ? 'Reverting…' : 'Revert this field'}
            </button>
          </TooltipContent>
        </TooltipPortal>
      </Tooltip>
    </TooltipProvider>
  );
}
