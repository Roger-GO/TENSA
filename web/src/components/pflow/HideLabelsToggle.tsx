import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useUiStore } from '@/store/ui';
import { cn } from '@/lib/cn';

/**
 * HideLabelsToggle. Top-bar toggle that suppresses voltage / angle /
 * flow labels on the SLD canvas (R9 — clean look for screenshots /
 * presentation). Color encoding (limit-band stroke) stays visible.
 *
 * State lives in the `ui` slice so other consumers (e.g., screenshots
 * tooling, future export-as-PNG flow) can read the same flag.
 */

export interface HideLabelsToggleProps {
  className?: string;
}

export function HideLabelsToggle({ className }: HideLabelsToggleProps) {
  const hideLabels = useUiStore((s) => s.hideLabels);
  const setHideLabels = useUiStore((s) => s.setHideLabels);

  return (
    <ToggleGroup
      type="single"
      value={hideLabels ? 'hidden' : 'visible'}
      onValueChange={(value) => {
        // Radix returns '' when the user un-toggles a single-mode item;
        // treat empty as "visible" (the default).
        setHideLabels(value === 'hidden');
      }}
      aria-label="Toggle SLD labels"
      data-testid="hide-labels-toggle"
      className={cn(className)}
    >
      <ToggleGroupItem value="visible" aria-label="Show labels">
        Labels
      </ToggleGroupItem>
      <ToggleGroupItem value="hidden" aria-label="Hide labels">
        Hide
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
