import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useUnitsStore } from '@/store/units';
import { cn } from '@/lib/cn';

/**
 * UnitsToggle. Top-bar switch between per-unit and actual units for what
 * the UI shows of bus voltage (pu or kV) and generator speed (pu or Hz),
 * in the Buses grid, on the diagram, in the Inspector and on the plots.
 * Angles are degrees either way, and powers are MW / MVAr either way.
 *
 * A voltage whose base the case does not give (a bus with no rated voltage,
 * which ANDES fills in as 110 kV and the server lists, so the fill-in is not
 * shown as kV) stays per unit and is labelled so, as does a speed when the case
 * has no usable frequency. The frequency is the case's own (a RAW header, or
 * the `_config` of an xlsx or json file) or else ANDES's default of 60 Hz,
 * which is what a MATPOWER case reads in the actual mode.
 */

export interface UnitsToggleProps {
  className?: string;
}

export function UnitsToggle({ className }: UnitsToggleProps) {
  const mode = useUnitsStore((s) => s.mode);
  const setMode = useUnitsStore((s) => s.setMode);

  return (
    <ToggleGroup
      type="single"
      value={mode}
      onValueChange={(value) => {
        // Radix returns '' when the user un-toggles the pressed item: keep
        // the current mode, there is always one.
        if (value === 'pu' || value === 'actual') setMode(value);
      }}
      aria-label="Display units"
      data-testid="units-toggle"
      className={cn(className)}
    >
      <ToggleGroupItem
        value="pu"
        aria-label="Per unit"
        title="Per unit: bus voltage in pu and generator speed in pu"
      >
        pu
      </ToggleGroupItem>
      <ToggleGroupItem
        value="actual"
        aria-label="Actual units"
        title="Actual units: bus voltage in kV where the case gives its rated voltage, generator speed in Hz of the case's base frequency (60 when the case sets none). It changes what is read, not what is typed: a set-point such as p0 or q0 is still edited in per unit of the system base, with its MW or MVAr shown beside it."
      >
        Actual
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
