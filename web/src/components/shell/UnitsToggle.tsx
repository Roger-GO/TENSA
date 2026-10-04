import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useUnitsStore } from '@/store/units';
import { cn } from '@/lib/cn';

/**
 * UnitsToggle. Top-bar switch between per-unit and actual units for what
 * the UI shows of bus voltage (pu or kV) and generator speed (pu or Hz),
 * in the Buses grid, on the diagram, in the Inspector and on the plots.
 * Angles are degrees either way, and powers are MW / MVAr either way.
 *
 * A quantity whose base is unknown (a bus with no rated voltage, a case
 * with no system frequency) stays per unit and is labelled so.
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
        title="Actual units: bus voltage in kV and generator speed in Hz, where the case gives the base"
      >
        Actual
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
