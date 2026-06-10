import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { BoltIcon, EmptyState } from '@/components/ui/EmptyState';
import { useCaseStore } from '@/store/case';
import { disturbanceSummary, sortedDisturbances, useDisturbanceStore } from '@/store/disturbance';
import type { DisturbanceLocal } from '@/store/disturbance';
import type { AlterSpec, DisturbanceSpec, FaultSpec, ToggleSpec } from '@/api/types';
import type { SelectedElement } from '@/store/case';
import { AddEventDialog } from '@/components/disturbance/AddEventDialog';
import { cn } from '@/lib/cn';

/**
 * DisturbancesAccordion (v3 Unit 10).
 *
 * Per-element view of the disturbance editor — filters the disturbance
 * slice down to those that target the currently-selected element and
 * renders inline edit + delete affordances. The "+ Add" button opens
 * the existing ``AddEventDialog`` pre-filled with the selected element's
 * idx so the user lands on a sensible default.
 *
 * Filter logic:
 *   - Bus selected: ``FaultSpec.bus_idx === idx``.
 *   - Generator/Load/Shunt/Line: ``ToggleSpec.dev_idx`` and
 *     ``AlterSpec.dev_idx`` match the selected idx, with ``model``
 *     matching the substrate model name for the kind.
 *
 * Note: the substrate's ``ToggleSpec.model`` and ``AlterSpec.model``
 * are stringly-typed (e.g., ``"Line"``, ``"PQ"``, ``"PV"``). The match
 * here uses ``includes()`` semantics on a per-kind shortlist so a
 * generator selection matches both ``PV`` and ``Slack`` toggles.
 */

const KIND_TO_MODELS: Record<SelectedElement['kind'], readonly string[]> = {
  bus: ['Bus'],
  line: ['Line'],
  transformer: ['Line'],
  generator: ['PV', 'Slack', 'GENROU', 'GENCLS', 'REGCP1'],
  load: ['PQ', 'PQzip'],
  shunt: ['Shunt'],
  // Controllers aren't direct disturbance targets — a user disturbs the
  // parent device (generator/bus), so a controller selection matches no
  // toggle/alter spec. Empty shortlist keeps `matchesElement` total.
  controller: [],
};

function matchesElement(spec: DisturbanceSpec, selected: SelectedElement): boolean {
  if (spec.kind === 'fault') {
    if (selected.kind !== 'bus') return false;
    return String((spec as FaultSpec).bus_idx) === selected.idx;
  }
  const dev = (spec as ToggleSpec | AlterSpec).dev_idx;
  if (String(dev) !== selected.idx) return false;
  const model = (spec as ToggleSpec | AlterSpec).model;
  const allowed = KIND_TO_MODELS[selected.kind];
  return allowed.includes(model);
}

export interface DisturbancesAccordionProps {
  className?: string;
}

export function DisturbancesAccordion({ className }: DisturbancesAccordionProps) {
  const selectedElement = useCaseStore((s) => s.selectedElement);
  const disturbances = useDisturbanceStore((s) => s.disturbances);
  const addDisturbance = useDisturbanceStore((s) => s.addDisturbance);
  const updateDisturbance = useDisturbanceStore((s) => s.updateDisturbance);
  const removeDisturbance = useDisturbanceStore((s) => s.removeDisturbance);

  type DialogState =
    | { mode: 'closed' }
    | { mode: 'add' }
    | { mode: 'edit'; id: string; spec: DisturbanceSpec };
  const [dialog, setDialog] = useState<DialogState>({ mode: 'closed' });

  const filtered = useMemo<DisturbanceLocal[]>(() => {
    if (!selectedElement) return [];
    const matching = disturbances.filter((d) => matchesElement(d.spec, selectedElement));
    return sortedDisturbances(matching);
  }, [disturbances, selectedElement]);

  // Add-mode prefill: when the dialog opens from a specific element's
  // accordion, land the user on a spec already pointing at that element
  // (a bus seeds a Fault on itself; a line/transformer seeds a Toggle).
  // Memoized so the reference is stable while the dialog is open — the
  // dialog resets its draft when this changes.
  const seedSpec = useMemo<DisturbanceSpec | null>(() => {
    if (!selectedElement) return null;
    if (selectedElement.kind === 'bus') {
      return { kind: 'fault', bus_idx: selectedElement.idx, tf: 1.0, tc: 1.1, xf: 0.05, rf: 0.0 };
    }
    if (selectedElement.kind === 'line' || selectedElement.kind === 'transformer') {
      return { kind: 'toggle', model: 'Line', dev_idx: selectedElement.idx, t: 1.0 };
    }
    return null;
  }, [selectedElement]);

  if (!selectedElement) {
    return (
      <div data-testid="disturbances-accordion" className={cn('flex flex-col gap-2', className)}>
        <EmptyState
          icon={<BoltIcon />}
          title="No disturbances"
          description="Select an element to manage disturbances on it."
          emptyStateKey="disturbances-accordion-no-selection"
          className="py-4"
        />
      </div>
    );
  }

  const openAdd = () => setDialog({ mode: 'add' });
  const openEdit = (d: DisturbanceLocal) => setDialog({ mode: 'edit', id: d.id, spec: d.spec });
  const closeDialog = (next: boolean) => {
    if (!next) setDialog({ mode: 'closed' });
  };
  const handleSave = (spec: DisturbanceSpec) => {
    if (dialog.mode === 'add') addDisturbance(spec);
    else if (dialog.mode === 'edit') updateDisturbance(dialog.id, spec);
  };

  return (
    <div data-testid="disturbances-accordion" className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs">
          {filtered.length} on {selectedElement.kind} {selectedElement.idx}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={openAdd}
          data-testid="disturbances-accordion-add"
          className={cn(
            'h-7 gap-1 px-2 text-xs font-medium',
            // Tinted ghost so the add affordance reads as the primary
            // action in this section without competing with the section
            // header for visual weight.
            'text-primary border-primary/30 hover:bg-primary/10 border',
          )}
        >
          <span aria-hidden className="text-base leading-none">+</span>
          Add
        </Button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<BoltIcon />}
          title="No disturbances"
          description="No disturbances on this element. Add one to model a fault, toggle, or alteration."
          emptyStateKey="disturbances-accordion-empty"
          className="py-4"
        />
      ) : (
        <ul data-testid="disturbances-accordion-list" className="flex flex-col gap-1">
          {filtered.map((d) => (
            <li
              key={d.id}
              data-testid={`disturbances-accordion-row-${d.id}`}
              className="border-border bg-background flex items-center justify-between gap-2 rounded border px-2 py-1"
            >
              <button
                type="button"
                onClick={() => openEdit(d)}
                data-testid={`disturbances-accordion-edit-${d.id}`}
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
                data-testid={`disturbances-accordion-delete-${d.id}`}
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
        seedSpec={seedSpec}
        onSave={handleSave}
      />
    </div>
  );
}
