import { Button } from '@/components/ui/button';
import { useCaseStore } from '@/store/case';

/**
 * "+ Add element" button of the Case card, at the top of the left sidebar.
 *
 * Clicking opens the AddElementPanel slide-over with no kind pre-selected. It
 * is the way in that is always in view: the Component library's tiles do the
 * same for one kind each, but sit at the foot of the sidebar, below the fold of
 * a short window, and the Workspace menu's entry is behind a click.
 *
 * `blockedReason` is why nothing can be added now (`useAddComponent`), or
 * `null`. The caller shows it as text and passes its id as `describedBy`, so
 * the disabled button is read out with its reason.
 */
export interface AddElementButtonProps {
  blockedReason: string | null;
  /** The id of the element that shows `blockedReason`. */
  describedBy?: string;
}

export function AddElementButton({ blockedReason, describedBy }: AddElementButtonProps) {
  const openAddPanel = useCaseStore((s) => s.openAddPanel);
  const blocked = blockedReason !== null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={blocked}
      onClick={() => openAddPanel(null)}
      aria-describedby={blocked ? describedBy : undefined}
      data-testid="add-element-button"
      className="text-xs"
    >
      <span aria-hidden="true">+</span>
      <span className="ml-1">Add element</span>
    </Button>
  );
}
