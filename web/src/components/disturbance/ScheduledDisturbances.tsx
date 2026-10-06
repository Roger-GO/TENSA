import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useCaseStore } from '@/store/case';
import {
  disturbanceSummary,
  disturbanceTime,
  sortedDisturbances,
  useDisturbanceStore,
} from '@/store/disturbance';
import type { DisturbanceLocal } from '@/store/disturbance';
import type { CaseEvent, DisturbanceSpec } from '@/api/types';
import { cn } from '@/lib/cn';
import { LazyMount } from '@/components/ui/Lazy';
import { lazyNamed } from '@/lib/lazyNamed';

// The dialog and the three forms inside it are fetched when it is first opened:
// this list is on the first screen of a loaded case, the forms are not.
const AddEventDialog = lazyNamed(() => import('./AddEventDialog'), 'AddEventDialog', 'overlay');

/**
 * ScheduledDisturbances. The list of what the next TDS run will do to the
 * system (a fault, a line trip, a parameter change), with the button that adds
 * one. It sits in the left sidebar under the loaded case, where a first-time
 * user looks after switching to TDS: the per-element Disturbances section of
 * the Inspector needs a selection and is folded away at the bottom of it.
 *
 * The list has two kinds of row. The user's own are the same slice the
 * Inspector and ``RunButton`` read, so a disturbance added in either place
 * shows in both and is committed at the next TDS run; they can be edited and
 * deleted. The others are read-only: the events the case's own files define
 * (``kundur_full.xlsx`` trips a line at 2 s) and the ones a bundle import or
 * snapshot restore replayed, which the topology reports because the run
 * applies them though the user never scheduled them.
 *
 * With neither, it says what that means: the run starts from the power flow
 * and nothing in the list or the case disturbs it.
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

/** What a read-only row says about where the event comes from. */
function origin(event: CaseEvent): string {
  if (event.source === 'restored') return 'Replayed from a bundle or snapshot';
  return event.name != null && event.name !== ''
    ? `Set by the case (${event.name})`
    : 'Set by the case';
}

/**
 * What a read-only row says, in the words of the user's own rows: the same
 * title for a fault, a toggle or an alteration of the same device.
 */
function describeEvent(
  event: CaseEvent,
  busNames: ReadonlyMap<string, string>,
): { title: string; detail?: string } {
  const dev = event.dev_idx == null ? '' : String(event.dev_idx);
  if (event.kind === 'fault') {
    const name = busNames.get(dev);
    const bus = name !== undefined && name !== dev ? `${name} (idx ${dev})` : dev;
    return {
      title: `Fault on bus ${bus}`,
      detail:
        event.tc == null
          ? `Applied at ${seconds(event.t)}, not cleared`
          : `Applied at ${seconds(event.t)}, cleared at ${seconds(event.tc)}`,
    };
  }
  const model = event.model ?? '';
  if (event.kind === 'toggle') {
    return { title: `Toggle ${model} ${dev}`, detail: `At ${seconds(event.t)}` };
  }
  const change = `${event.src ?? ''} ${event.method ?? ''} ${event.amount ?? ''}`.trim();
  return { title: `Alter ${model} ${dev}: ${change}`, detail: `At ${seconds(event.t)}` };
}

/** One row of the list, in the order the run applies them. */
type Row =
  | { kind: 'event'; time: number; event: CaseEvent; index: number }
  | { kind: 'own'; time: number; disturbance: DisturbanceLocal };

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
  const events = topology?.events;
  // Time order, the case's events first where one ties with the user's own.
  const rows = useMemo<Row[]>(() => {
    const own = sortedDisturbances(disturbances).map(
      (d): Row => ({ kind: 'own', time: disturbanceTime(d.spec), disturbance: d }),
    );
    const fromCase = (events ?? []).map(
      (event, index): Row => ({ kind: 'event', time: event.t, event, index }),
    );
    return [...fromCase, ...own].sort((a, b) => a.time - b.time);
  }, [disturbances, events]);

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
      {rows.length === 0 ? (
        <p data-testid="scheduled-disturbances-empty" className="text-muted-foreground text-xs">
          No fault is set. Neither this list nor the case schedules a fault, a trip or a parameter
          change, so a TDS run has nothing to disturb the system. You can also right-click a bus on
          the diagram and choose Fault here.
        </p>
      ) : (
        <>
          <ul data-testid="scheduled-disturbances-list" className="flex flex-col gap-1">
            {rows.map((row) => {
              if (row.kind === 'event') {
                const { title, detail } = describeEvent(row.event, busNames);
                return (
                  <li
                    key={`event-${row.index}`}
                    data-testid={`scheduled-case-event-${row.index}`}
                    className="border-border bg-background rounded border border-dashed px-2 py-1 text-xs"
                  >
                    <span className="block">{title}</span>
                    {detail !== undefined ? (
                      <span className="text-muted-foreground block">{detail}</span>
                    ) : null}
                    <span className="text-muted-foreground block">{origin(row.event)}</span>
                  </li>
                );
              }
              const d = row.disturbance;
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
        </>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={openAdd}
        data-testid="scheduled-disturbances-add"
        className="self-start text-xs"
      >
        {disturbances.length === 0 ? 'Add fault' : 'Add disturbance'}
      </Button>

      <LazyMount when={dialog.mode !== 'closed'} onLoadFailed={() => setDialog({ mode: 'closed' })}>
        <AddEventDialog
          open={dialog.mode !== 'closed'}
          onOpenChange={(next) => {
            if (!next) setDialog({ mode: 'closed' });
          }}
          initialSpec={dialog.mode === 'edit' ? dialog.spec : null}
          onSave={handleSave}
        />
      </LazyMount>
    </div>
  );
}
