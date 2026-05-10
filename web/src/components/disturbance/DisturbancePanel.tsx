import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  disturbanceSummary,
  sortedDisturbances,
  useDisturbanceStore,
} from '@/store/disturbance';
import type { DisturbanceLocal } from '@/store/disturbance';
import type { DisturbanceSpec } from '@/api/types';
import { cn } from '@/lib/cn';
import { DisturbanceTimeline } from './DisturbanceTimeline';
import { AddEventDialog } from './AddEventDialog';

/**
 * DisturbancePanel — right-dock panel content for the disturbance
 * editor. Renders the timeline strip, the list of disturbances (with
 * per-row delete), and the "Add disturbance" button.
 *
 * Empty state: when no disturbances are scheduled, shows the empty-state
 * copy required by the plan ("No disturbances scheduled. Add one to
 * define a fault, line trip, or parameter change.").
 *
 * Edit flow: clicking a row OR a marker on the timeline opens the
 * ``AddEventDialog`` pre-filled with that disturbance's spec; Save
 * → ``updateDisturbance`` against the existing id.
 *
 * The panel is self-contained — it reads the disturbance slice directly
 * and mounts the dialog itself. Per the plan's Unit 6 / Unit 8 split
 * ("just render DisturbancePanel as a self-contained component that the
 * dock can mount"), the dock doesn't need to thread props.
 */

export interface DisturbancePanelProps {
  className?: string;
}

export function DisturbancePanel({ className }: DisturbancePanelProps) {
  const disturbances = useDisturbanceStore((s) => s.disturbances);
  const addDisturbance = useDisturbanceStore((s) => s.addDisturbance);
  const updateDisturbance = useDisturbanceStore((s) => s.updateDisturbance);
  const removeDisturbance = useDisturbanceStore((s) => s.removeDisturbance);

  // Dialog state — closed | adding | editing-{id}.
  type DialogState =
    | { mode: 'closed' }
    | { mode: 'add' }
    | { mode: 'edit'; id: string; spec: DisturbanceSpec };
  const [dialog, setDialog] = useState<DialogState>({ mode: 'closed' });

  const sorted = sortedDisturbances(disturbances);

  const openAdd = () => setDialog({ mode: 'add' });
  const openEdit = (d: DisturbanceLocal) =>
    setDialog({ mode: 'edit', id: d.id, spec: d.spec });
  const closeDialog = (next: boolean) => {
    if (!next) setDialog({ mode: 'closed' });
  };
  const handleSave = (spec: DisturbanceSpec) => {
    if (dialog.mode === 'add') {
      addDisturbance(spec);
    } else if (dialog.mode === 'edit') {
      updateDisturbance(dialog.id, spec);
    }
  };

  return (
    <section
      data-testid="disturbance-panel"
      aria-label="Disturbance editor"
      className={cn('flex h-full flex-col gap-3 p-3', className)}
    >
      <header className="flex items-center justify-between">
        <h2 className="text-foreground text-sm font-semibold">Disturbances</h2>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={openAdd}
          data-testid="add-disturbance-button"
        >
          Add disturbance
        </Button>
      </header>

      <DisturbanceTimeline
        disturbances={disturbances}
        onMarkerClick={(id) => {
          const d = disturbances.find((x) => x.id === id);
          if (d) openEdit(d);
        }}
      />

      {disturbances.length === 0 ? (
        <p
          data-testid="disturbance-empty-state"
          className="text-muted-foreground text-xs"
        >
          No disturbances scheduled. Add one to define a fault, line trip, or
          parameter change.
        </p>
      ) : (
        <ul
          data-testid="disturbance-list"
          className="flex flex-col gap-1 overflow-auto"
        >
          {sorted.map((d) => (
            <li
              key={d.id}
              data-testid={`disturbance-row-${d.id}`}
              className="border-border flex items-center justify-between gap-2 rounded border bg-background px-2 py-1"
            >
              <button
                type="button"
                onClick={() => openEdit(d)}
                data-testid={`disturbance-edit-${d.id}`}
                className={cn(
                  'flex-1 text-left text-xs',
                  'hover:underline focus-visible:underline',
                  'focus-visible:outline-none',
                )}
              >
                {disturbanceSummary(d.spec)}
              </button>
              <button
                type="button"
                onClick={() => removeDisturbance(d.id)}
                aria-label={`Delete ${d.spec.kind} disturbance`}
                title="Delete this disturbance"
                data-testid={`disturbance-delete-${d.id}`}
                className={cn(
                  'inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)]',
                  'text-muted-foreground hover:text-danger hover:bg-danger/10',
                  'transition-colors',
                  'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                )}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  width="12"
                  height="12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M2.5 4 L13.5 4" />
                  <path d="M6 4 V2.5 H10 V4" />
                  <path d="M3.5 4 L4.5 13.5 L11.5 13.5 L12.5 4" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}

      <AddEventDialog
        open={dialog.mode !== 'closed'}
        onOpenChange={closeDialog}
        initialSpec={dialog.mode === 'edit' ? dialog.spec : null}
        onSave={handleSave}
      />
    </section>
  );
}
