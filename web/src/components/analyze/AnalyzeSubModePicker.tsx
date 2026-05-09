import { cn } from '@/lib/cn';
import { ANALYZE_SUB_MODES, useAnalyzeStore } from '@/store/analyze';
import type { AnalyzeSubMode } from '@/store/analyze';

/**
 * AnalyzeSubModePicker — segmented control that swaps the routine
 * sub-view inside the Analyze panel (Unit 6 of the v2.0 plan).
 *
 * Per KTD-6: this picker (PF / TDS / EIG) replaces the v0.1
 * ``RunMode = 'pf' | 'tds'`` toggle inside the Analyze panel. CPF and
 * SE arrive in Phase 3.
 *
 * Behaviour:
 *
 * - Click swaps ``useAnalyzeStore.subMode``. Default is ``pflow`` so a
 *   first-time visitor lands on a familiar surface.
 * - The picker itself does NOT trigger a routine run — that's the
 *   RunButton's job. EIG runs are gated behind an explicit "Run EIG"
 *   click so the user opts-in to the dae-state mutation side-effect.
 *
 * Visually mirrors the existing ``RunButton`` segmented control so
 * the two affordances feel consistent.
 */

const LABELS: Record<AnalyzeSubMode, string> = {
  pflow: 'PF',
  tds: 'TDS',
  eig: 'EIG',
};

const HINTS: Record<AnalyzeSubMode, string> = {
  pflow: 'Power flow result',
  tds: 'Time-domain simulation config + result',
  eig: 'Eigenvalue analysis (small-signal stability)',
};

export interface AnalyzeSubModePickerProps {
  className?: string;
}

export function AnalyzeSubModePicker({ className }: AnalyzeSubModePickerProps) {
  const subMode = useAnalyzeStore((s) => s.subMode);
  const setSubMode = useAnalyzeStore((s) => s.setSubMode);

  return (
    <div
      role="radiogroup"
      aria-label="Analyze sub-mode"
      data-testid="analyze-sub-mode-picker"
      className={cn(
        'inline-flex overflow-hidden rounded-[var(--radius-md)]',
        'border-border border text-xs',
        className,
      )}
    >
      {ANALYZE_SUB_MODES.map((mode, idx) => {
        const isActive = subMode === mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={isActive}
            data-testid={`analyze-sub-mode-${mode}`}
            title={HINTS[mode]}
            onClick={() => setSubMode(mode)}
            className={cn(
              'px-3 py-1 transition-colors',
              idx > 0 && 'border-border border-l',
              isActive
                ? 'bg-primary/15 text-foreground'
                : 'text-muted-foreground hover:text-foreground',
              'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
            )}
          >
            {LABELS[mode]}
          </button>
        );
      })}
    </div>
  );
}
