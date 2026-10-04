import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useCaseStore } from '@/store/case';
import { disturbanceSummary, sortedDisturbances, useDisturbanceStore } from '@/store/disturbance';
import type { DisturbanceLocal } from '@/store/disturbance';
import type { DisturbanceSpec } from '@/api/types';
import { cn } from '@/lib/cn';
import { AddEventDialog } from './AddEventDialog';

/**
 * ScheduledDisturbances. The list of what the next TDS run will do to the
 * system (a fault, a line trip, a parameter change), with the button that adds
 * one. It sits in the left sidebar under the loaded case, where a first-time
 * user looks after switching to TDS: the per-element Disturbances section of
 * the Inspector needs a selection and is folded away at the bottom of it.
 *
 * With nothing scheduled it says what that means, since the run then starts
 * from the power flow, nothing disturbs it, and the plots stay flat. The list
 * is the same slice the Inspector and ``RunButton`` read, so a disturbance
 * added in either place shows in both and is committed at the next TDS run.
 */

/** A time in seconds without trailing zeros: 1, 1.1, 2.55. */
function seconds(t: number): string {
  return `${Number(t.toFixed(3))} s`;
}

/**
 * What a row says: a fault names its bus and says when it starts and ends, the
 * others use the store's summary.
 */
function describe(
  spec: DisturbanceSpec,
  busNames: ReadonlyMap<string, string>,
): { title: string; detail?: string } {
  if (spec.kind !== 'fault') return { title: disturbanceSummary(spec) };
  const idx = String(spec.bus_idx);
  const name = busNames.get(idx);
  // The diagram labels a bus with its name, the forms and the API use its idx.
  const bus = name !== undefined && name !== idx ? `${name} (idx ${idx})` : idx;
  return {
    title: `Fault on bus ${bus}`,
    detail: `Applied at ${seconds(spec.tf)}, cleared at ${seconds(spec.tc)}`,
  };
}

type DialogState =
  | { mode: 'closed' }
  | { mode: 'add' }
  | { mode: 'edit'; id: string; spec: DisturbanceSpec };

export interface ScheduledDisturbancesProps {
  className?: string;
}

export function ScheduledDisturbances({ className }: ScheduledDisturbancesProps) {
  const disturbances = useDisturbanceStore((s) => s.disturbances);
  const addDisturbance = useDisturbanceStore((s) => s.addDisturbance);
  const updateDisturbance = useDisturbanceStore((s) => s.updateDisturbance);
  const removeDisturbance = useDisturbanceStore((s) => s.removeDisturbance);
  const topology = useCaseStore((s) => s.topology);
  const [dialog, setDialog] = useState<DialogState>({ mode: 'closed' });

  const busNames = useMemo(
    () => new Map((topology?.buses ?? []).map((b) => [String(b.idx), String(b.name)])),
    [topology],
  );
  const sorted = useMemo(() => sortedDisturbances(disturbances), [disturbances]);

  const openAdd = () => setDialog({ mode: 'add' });
  const openEdit = (d: DisturbanceLocal) => setDialog({ mode: 'edit', id: d.id, spec: d.spec });
  const handleSave = (spec: DisturbanceSpec) => {
    if (dialog.mode === 'add') addDisturbance(spec);
    else if (dialog.mode === 'edit') updateDisturbance(dialog.id, spec);
  };

  return (
    <div
      data-testid="scheduled-disturbances"
      className={cn('flex flex-col gap-2 px-3 pb-3', className)}
    >
      {sorted.length === 0 ? (
        <>
          <p data-testid="scheduled-disturbances-empty" className="text-muted-foreground text-xs">
            No fault is set. A TDS run then has nothing to disturb the system, and the curves stay
            flat.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openAdd}
            data-testid="scheduled-disturbances-add"
            className="self-start text-xs"
          >
            Add fault
          </Button>
        </>
      ) : (
        <>
          <ul data-testid="scheduled-disturbances-list" className="flex flex-col gap-1">
            {sorted.map((d) => {
              const { title, detail } = describe(d.spec, busNames);
              return (
                <li
                  key={d.id}
                  data-testid={`scheduled-disturbance-${d.id}`}
                  className="border-border bg-background flex items-center justify-between gap-2 rounded border px-2 py-1"
                >
                  <button
                    type="button"
                    onClick={() => openEdit(d)}
                    title="Edit this disturbance"
                    data-testid={`scheduled-disturbance-edit-${d.id}`}
                    className={cn(
                      'flex-1 text-left text-xs',
                      'hover:underline focus-visible:underline',
                      'focus-visible:outline-none',
                    )}
                  >
                    <span className="block">{title}</span>
                    {detail !== undefined ? (
                      <span className="text-muted-foreground block">{detail}</span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeDisturbance(d.id)}
                    aria-label={`Delete ${d.spec.kind} disturbance`}
                    title="Delete this disturbance"
                    data-testid={`scheduled-disturbance-delete-${d.id}`}
                    className={cn(
                      'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)]',
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
              );
            })}
          </ul>
          <p className="text-muted-foreground text-xs">Applied the next time you run TDS.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openAdd}
            data-testid="scheduled-disturbances-add"
            className="self-start text-xs"
          >
            Add disturbance
          </Button>
        </>
      )}

      <AddEventDialog
        open={dialog.mode !== 'closed'}
        onOpenChange={(next) => {
          if (!next) setDialog({ mode: 'closed' });
        }}
        initialSpec={dialog.mode === 'edit' ? dialog.spec : null}
        onSave={handleSave}
      />
    </div>
  );
}
