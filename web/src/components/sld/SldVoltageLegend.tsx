import { cn } from '@/lib/cn';
import { useAnimationStore } from '@/store/animation';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import { VoltageMarker } from './VoltageMarker';
import {
  DEFAULT_VOLTAGE_LIMITS,
  VOLTAGE_WARNING_MARGIN,
  barClassForBand,
  type VoltageBand,
} from './voltage';

interface LegendRow {
  band: VoltageBand;
  text: string;
  /** Whether the row's marker is the filled (beyond) or the empty (near) triangle. */
  marker: boolean;
}

const ROWS: readonly LegendRow[] = [
  { band: 'success', text: 'Within limits', marker: false },
  { band: 'warning', text: `Within ${VOLTAGE_WARNING_MARGIN} pu of a limit`, marker: true },
  { band: 'danger', text: 'Beyond a limit', marker: true },
];

/**
 * True while the diagram has bus voltages to colour: a converged power flow,
 * or a time-domain run whose frames drive the overlay. Before either, every
 * bus is the neutral bar and there is nothing for a legend to explain.
 */
function useHasBusVoltages(): boolean {
  const pflowConverged = usePflowStore((s) => s.lastRun?.converged === true);
  const activeRunId = useRunsStore((s) => s.activeRunId);
  const streaming = useAnimationStore(
    (s) => activeRunId !== null && (s.busOverlayByRun[activeRunId]?.size ?? 0) > 0,
  );
  return pflowConverged || streaming;
}

/**
 * On-canvas key to the bus colours and limit markers. A bus bar goes amber
 * near a voltage limit and red beyond it, and carries a triangle beside its
 * name (pointing up at the upper limit, down at the lower one; empty near,
 * filled beyond), so the key shows both and says which limits are meant.
 * Sits inside the canvas surface, so a PNG export of the diagram includes
 * it. Draws nothing until the diagram has voltages to colour.
 */
export function SldVoltageLegend({ className }: { className?: string }) {
  const visible = useHasBusVoltages();
  if (!visible) return null;
  return (
    <div
      role="group"
      aria-label="Bus voltage legend"
      data-testid="sld-voltage-legend"
      className={cn(
        'border-border bg-background/90 text-foreground pointer-events-none rounded-lg border',
        'px-2 py-1.5 text-[10px] leading-tight shadow-sm',
        className,
      )}
    >
      <p className="text-muted-foreground mb-1 font-medium">Bus voltage</p>
      <ul className="flex flex-col gap-1">
        {ROWS.map((row) => (
          <li
            key={row.band}
            data-testid={`sld-voltage-legend-${row.band}`}
            className="flex gap-1.5"
          >
            <span
              aria-hidden="true"
              className={cn(
                'h-[5px] w-5 shrink-0 self-center rounded-full',
                barClassForBand(row.band),
              )}
            />
            <span className="flex w-[22px] shrink-0 items-center gap-0.5">
              {row.marker ? (
                <>
                  <VoltageMarker band={row.band} side="high" />
                  <VoltageMarker band={row.band} side="low" />
                </>
              ) : null}
            </span>
            <span>{row.text}</span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground mt-1">
        Up: above vmax. Down: below vmin. Each bus uses its own limits,{' '}
        {DEFAULT_VOLTAGE_LIMITS.vmin} and {DEFAULT_VOLTAGE_LIMITS.vmax} pu if it has none.
      </p>
    </div>
  );
}
