import { cn } from '@/lib/cn';
import { voltageMarkerLabel, type VoltageBand, type VoltageSide } from './voltage';

export interface VoltageMarkerProps {
  band: VoltageBand;
  side: VoltageSide | null;
  className?: string;
  'data-testid'?: string;
}

/**
 * The colour-free sign of a bus voltage at a limit: a triangle that points
 * up at the upper limit and down at the lower one. Filled in the danger
 * colour with a dark outline when the voltage is beyond the limit, an
 * empty outline when it is only near it, so the amber and red bars are not
 * the one thing telling them apart from a normal bus. Draws nothing for a
 * bus in the clear.
 *
 * Both shapes keep the dark outline (not the amber / red) because the
 * outline is what has to read against the diagram's background.
 */
export function VoltageMarker({
  band,
  side,
  className,
  'data-testid': testId,
}: VoltageMarkerProps) {
  const label = voltageMarkerLabel(band, side);
  if (label === null) return null;
  const up = side === 'high';
  const beyond = band === 'danger';
  return (
    <svg
      data-testid={testId}
      data-band={band}
      data-side={side ?? undefined}
      role="img"
      aria-label={label}
      viewBox="0 0 10 10"
      className={cn('h-[9px] w-[9px] shrink-0', className)}
    >
      <title>{label}</title>
      <polygon
        points={up ? '5,1 9.2,9 0.8,9' : '5,9 9.2,1 0.8,1'}
        strokeLinejoin="round"
        className={cn('stroke-foreground', beyond ? 'fill-danger' : 'fill-transparent')}
        strokeWidth={beyond ? 1 : 1.5}
      />
    </svg>
  );
}
