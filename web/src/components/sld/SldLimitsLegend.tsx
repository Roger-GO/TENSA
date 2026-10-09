import { cn } from '@/lib/cn';
import { usePflowStore } from '@/store/pflow';
import { LOADING_LIMIT_PCT, LOADING_WARNING_PCT } from './loading';
import { assessQLimit, qLimitMarker } from './qLimit';
import { VoltageMarker } from './VoltageMarker';

/**
 * What the diagram shows of the two limits a bus voltage's legend leaves out
 * after a converged power flow: whether any rated line is loaded, and whether
 * any generator's reactive output is on or past a limit.
 */
function useLimitsOnDiagram(): { loading: boolean; reactive: boolean } {
  const loading = usePflowStore(
    (s) =>
      s.lastRun?.converged === true &&
      Object.values(s.lastRun.line_flows ?? {}).some(
        (flow) => typeof flow.loading_pct === 'number' && Number.isFinite(flow.loading_pct),
      ),
  );
  const reactive = usePflowStore(
    (s) =>
      s.lastRun?.converged === true &&
      Object.values(s.lastRun.generator_outputs ?? {}).some((row) => {
        const { band } = qLimitMarker(assessQLimit(row.q, row.q_min, row.q_max));
        return band === 'danger' || band === 'warning';
      }),
  );
  return { loading, reactive };
}

/**
 * On-canvas key to the line colours and the generator limit markers, below
 * the bus voltage legend. A line the case rates goes amber from
 * `LOADING_WARNING_PCT` of its rating and red past it, heavier as it does, and
 * shows its loading beside its flow; a generator whose reactive output is on
 * or past a limit is outlined amber or red and carries the same triangle a bus
 * does (up at `qmax`, down at `qmin`; empty on the limit, filled past it).
 * Each part draws only when the diagram shows what it explains, so a case with
 * no ratings and no generator at a limit gets no legend at all. Sits inside
 * the canvas surface, so a PNG export of the diagram includes it. `compact`
 * leaves the sentences under the rows out, as for the voltage legend.
 */
export function SldLimitsLegend({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const { loading, reactive } = useLimitsOnDiagram();
  if (!loading && !reactive) return null;
  return (
    <div
      role="group"
      aria-label="Line loading and generator limit legend"
      data-testid="sld-limits-legend"
      className={cn(
        'border-border bg-background/90 text-foreground pointer-events-none rounded-lg border',
        'px-2 py-1.5 text-[10px] leading-tight shadow-sm',
        className,
      )}
    >
      {loading ? (
        <div data-testid="sld-limits-legend-loading">
          <p className="text-muted-foreground mb-1 font-medium">Line loading</p>
          <ul className="flex flex-col gap-1">
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true" className="bg-warning h-[2.4px] w-5 shrink-0 rounded-full" />
              <span>
                {LOADING_WARNING_PCT}% to {LOADING_LIMIT_PCT}% of the rating
              </span>
            </li>
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true" className="bg-danger h-[3px] w-5 shrink-0 rounded-full" />
              <span>Over the rating</span>
            </li>
          </ul>
          {compact ? null : (
            <p className="text-muted-foreground mt-1">
              Percent of the rating is on each line. A line with no rating is not coloured.
            </p>
          )}
        </div>
      ) : null}
      {reactive ? (
        <div data-testid="sld-limits-legend-reactive" className={loading ? 'mt-1.5' : undefined}>
          <p className="text-muted-foreground mb-1 font-medium">Generator reactive power</p>
          <ul className="flex flex-col gap-1">
            <li className="flex items-center gap-1.5">
              <span className="flex w-5 shrink-0 items-center gap-0.5">
                <VoltageMarker band="warning" side="high" label="On the upper limit" />
                <VoltageMarker band="warning" side="low" label="On the lower limit" />
              </span>
              <span>On a Q limit</span>
            </li>
            <li className="flex items-center gap-1.5">
              <span className="flex w-5 shrink-0 items-center gap-0.5">
                <VoltageMarker band="danger" side="high" label="Past the upper limit" />
                <VoltageMarker band="danger" side="low" label="Past the lower limit" />
              </span>
              <span>Past a Q limit</span>
            </li>
          </ul>
          {compact ? null : <p className="text-muted-foreground mt-1">Up: Qmax. Down: Qmin.</p>}
        </div>
      ) : null}
    </div>
  );
}
