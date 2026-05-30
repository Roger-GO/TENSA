/**
 * EditModeToggle (v3.1 Unit 22).
 *
 * A two-state Edit / Run toggle that mounts in the RightInspector header.
 * ``Run`` mode (the default) keeps every inspector input read-only; ``Edit``
 * mode unlocks the whitelisted dynamic-controller params so they commit via the
 * clone-on-write endpoint.
 *
 * Clone-init behaviour: switching INTO Edit mode ensures the per-session clone
 * is initialised up front (``useInitClone``), so the first param edit doesn't
 * pay the clone-copy latency mid-keystroke and the Modified-from-Original diff
 * (Unit 23) has a clone to compare against immediately. Init is idempotent on
 * the substrate, so an already-initialised clone is a cheap no-op. Switching
 * back to Run mode leaves the clone in place (the edits persist); the explicit
 * "Discard edits" path (``useCloneReset``) is the only thing that drops it.
 *
 * The toggle is disabled while a TDS run streams (mirrors the inspector-input
 * guard) and while the init request is in flight.
 */
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { useRunsStore } from '@/store/runs';
import { useInitClone } from '@/api/queries';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';

/** True when any run is currently starting / streaming (TDS guard). */
function useTdsStreaming(): boolean {
  return useRunsStore((s) =>
    Object.values(s.runs).some((r) => r.state === 'starting' || r.state === 'streaming'),
  );
}

export interface EditModeToggleProps {
  className?: string;
}

export function EditModeToggle({ className }: EditModeToggleProps) {
  const editMode = useCaseStore((s) => s.editMode);
  const setEditMode = useCaseStore((s) => s.setEditMode);
  const sessionId = useSessionStore((s) => s.sessionId);
  const initClone = useInitClone();
  const streaming = useTdsStreaming();

  const disabled = streaming || initClone.isPending || sessionId === null;

  const handleToggle = () => {
    if (disabled) return;
    const next = editMode === 'edit' ? 'run' : 'edit';
    setEditMode(next);
    // Entering Edit mode pre-initialises the clone so the first edit is fast
    // and the diff has something to compare. Idempotent on the substrate.
    if (next === 'edit' && sessionId !== null) {
      initClone.mutate(sessionId);
    }
  };

  const isEdit = editMode === 'edit';
  const tooltipLabel = streaming
    ? 'TDS streaming — switch modes when the run completes.'
    : isEdit
      ? 'Editing enabled. Switch to Run mode to lock inputs.'
      : 'Switch to Edit mode to change controller parameters.';

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            role="switch"
            aria-checked={isEdit}
            // Fixed name for the switch; aria-checked carries on/off so AT
            // doesn't double-announce state (the visible "Edit"/"Run" label is
            // decorative for sighted users).
            aria-label="Edit mode"
            data-testid="edit-mode-toggle"
            data-mode={editMode}
            disabled={disabled}
            onClick={handleToggle}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-2 py-1',
              'text-[10px] font-semibold tracking-[0.08em] uppercase',
              'transition-colors duration-[var(--duration-fast)]',
              'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
              'disabled:cursor-not-allowed disabled:opacity-50',
              isEdit
                ? 'border-warning/40 bg-warning/15 text-foreground'
                : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground',
              className,
            )}
          >
            <span
              aria-hidden="true"
              data-testid="edit-mode-dot"
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                isEdit ? 'bg-warning' : 'bg-muted-foreground',
              )}
            />
            {isEdit ? 'Edit' : 'Run'}
          </button>
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent data-testid="edit-mode-toggle-tooltip">{tooltipLabel}</TooltipContent>
        </TooltipPortal>
      </Tooltip>
    </TooltipProvider>
  );
}
