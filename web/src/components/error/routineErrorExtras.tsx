/**
 * Per-routine error detail RENDERERS (v3.1 Phase 3, Unit 9).
 *
 * JSX companions to the pure formatters in `routineErrorDetails.ts`. The
 * migrated error wrappers pass these as the `extras` of the single
 * `<ProblemDetailsErrorSurface>` primitive so each routine's curated `dl`
 * grid renders inside the one error UI — preserving the bespoke layout +
 * numbers without the primitive knowing anything routine-specific.
 */
import {
  type DetailRow,
  type PflowConvergenceDetailData,
  pflowConvergenceRows,
} from './routineErrorDetails';

/** Render a routine detail grid identically to the bespoke `<dl>` blocks. */
export function RoutineDetailGrid({ rows }: { rows: readonly DetailRow[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.map((row) => (
        <DetailPair key={row.key} row={row} />
      ))}
    </dl>
  );
}

function DetailPair({ row }: { row: DetailRow }) {
  return (
    <>
      <dt className="text-muted-foreground font-mono">{row.key}</dt>
      <dd
        className={
          row.truncate
            ? 'text-foreground truncate font-mono'
            : 'text-foreground font-mono break-words'
        }
      >
        {row.value}
      </dd>
    </>
  );
}

/**
 * The PF convergence detail grid + explanatory note. Mirrors the bespoke
 * `ConvergenceErrorPanel` slide-out content (iteration / last mismatch /
 * run_id + the Newton-Raphson hint) verbatim.
 */
export function PflowConvergenceExtras({ data }: { data: PflowConvergenceDetailData }) {
  return (
    <div data-testid="convergence-error-details" className="flex flex-col gap-2 px-3 py-2">
      <RoutineDetailGrid rows={pflowConvergenceRows(data)} />
      <p className="text-muted-foreground text-xs leading-relaxed">
        The Newton-Raphson iteration did not reach the convergence threshold. Inspect bus voltages +
        adjust the case (slack bus, generator setpoints, line impedance) and retry.
      </p>
    </div>
  );
}
