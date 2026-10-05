import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAddElement, useCurrentTopology, useTopologySchema } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { ProblemDetailsError } from '@/api/client';
import type { ParamValue } from '@/api/types';
import { cn } from '@/lib/cn';
import { ElementForm } from './ElementForm';
import { CancelConfirmDialog } from './CancelConfirmDialog';
import { elementDefaults } from './elementHelp';

/**
 * AddElementPanel — compact slide-over from the right edge of the dock
 * (fixed ~420px wide). The canvas and Inspector remain visible to the
 * left so the user can watch the diagram grow while adding elements
 * (e.g., picking a bus from the dropdown while viewing Bus 1's
 * properties underneath).
 *
 * R18-compliant: this is a slide-over, not a modal — no backdrop
 * click-to-dismiss, no scroll lock, dismissable only via Cancel /
 * back-arrow. The CancelConfirmDialog (destructive) IS a modal.
 *
 * State flow (per the plan's "Submit sequence"):
 *
 *   pick kind → form renders → fill → Submit →
 *     Saving (button locks, spinner) →
 *     201 → topology re-fetch → the form resets for the next element, under
 *           a line that names what was added and says the panel stays open
 *     422 → inline error, panel stays open
 *     409 → close + caller surfaces reset banner
 *
 * Opened from a bus of the diagram ("Add element here"), the panel says which
 * bus and every form with a bus field opens on it (`addPanelBus`).
 */

/**
 * Kind picker entries. ``value`` is the picker's UI handle (e.g.,
 * "Transformer2W"); ``submitModel`` is what the substrate's
 * ``add_element`` endpoint expects (e.g., "Line" — ANDES models 2W
 * transformers as Lines with a non-default ``tap``).
 *
 * ``defaultParams`` pre-fills the form on kind selection so transformer
 * adds default to ``tap=1.05`` (off-nominal — required for the
 * Line→Transformer split heuristic to route the new device into the
 * transformers bucket).
 */
const SUPPORTED_KINDS: ReadonlyArray<{
  value: string;
  label: string;
  group:
    | 'Network'
    | 'Transformers'
    | 'Generators'
    | 'Exciters'
    | 'Governors'
    | 'Storage'
    | 'Loads'
    | 'Shunts';
  submitModel: string;
  defaultParams?: Record<string, string | number | boolean>;
}> = [
  { value: 'Bus', label: 'Bus', group: 'Network', submitModel: 'Bus' },
  { value: 'Line', label: 'Line', group: 'Network', submitModel: 'Line' },
  {
    value: 'Transformer2W',
    label: 'Transformer (2W)',
    group: 'Transformers',
    submitModel: 'Line',
    defaultParams: { tap: 1.05 },
  },
  { value: 'PV', label: 'PV generator', group: 'Generators', submitModel: 'PV' },
  { value: 'Slack', label: 'Slack generator', group: 'Generators', submitModel: 'Slack' },
  { value: 'GENROU', label: 'GENROU (synchronous)', group: 'Generators', submitModel: 'GENROU' },
  { value: 'GENCLS', label: 'GENCLS (classic)', group: 'Generators', submitModel: 'GENCLS' },
  // Dynamic controllers — attach to a synchronous machine (GENROU/GENCLS) via
  // the ``syn`` link. They make the machine's voltage (exciters) and speed
  // (governors) regulated, so a from-scratch dynamic system is no longer
  // GENROU-only. The machine link renders as a SynIdxSelect dropdown.
  { value: 'IEEEX1', label: 'IEEEX1 exciter', group: 'Exciters', submitModel: 'IEEEX1' },
  { value: 'ESDC2A', label: 'ESDC2A exciter', group: 'Exciters', submitModel: 'ESDC2A' },
  { value: 'EXST1', label: 'EXST1 exciter', group: 'Exciters', submitModel: 'EXST1' },
  { value: 'SEXS', label: 'SEXS exciter (simple)', group: 'Exciters', submitModel: 'SEXS' },
  { value: 'TGOV1', label: 'TGOV1 governor', group: 'Governors', submitModel: 'TGOV1' },
  { value: 'IEEEG1', label: 'IEEEG1 governor', group: 'Governors', submitModel: 'IEEEG1' },
  // A battery takes over a static generator on its bus (the ``gen`` link, a
  // GenIdxSelect dropdown) when a time-domain run starts. The form says what
  // its parameters mean, and opens rated on the system base (`elementHelp`).
  { value: 'ESD1', label: 'ESD1 battery', group: 'Storage', submitModel: 'ESD1' },
  { value: 'PQ', label: 'PQ load', group: 'Loads', submitModel: 'PQ' },
  { value: 'ZIP', label: 'ZIP load', group: 'Loads', submitModel: 'ZIP' },
  { value: 'Shunt', label: 'Shunt', group: 'Shunts', submitModel: 'Shunt' },
];

/**
 * The Component library names families, not models: a Generator tile cannot say
 * whether the user wants a PV, a Slack or a GENROU. The panel opens on the most
 * common model of the family, with the picker one click away, rather than on a
 * kind it has no form for (its own model names are the picker's values above).
 * The Battery tile stands for the one storage model the picker has.
 */
const DEFAULT_KIND_OF_FAMILY: Readonly<Record<string, string>> = {
  Generator: 'PV',
  Load: 'PQ',
  Transformer: 'Transformer2W',
  Battery: 'ESD1',
};

/** The picker kind a requested kind stands for: the family's default, else itself. */
function pickerKindFor(kind: string | null): string | null {
  return kind === null ? null : (DEFAULT_KIND_OF_FAMILY[kind] ?? kind);
}

/** "PV generator 6 on bus 4": what an add made, for the line that confirms it. */
function describeAdded(label: string, params: Readonly<Record<string, ParamValue>>): string {
  const text = (value: ParamValue | undefined) =>
    value === undefined || value === '' ? null : String(value);
  const idx = text(params.idx);
  const bus = text(params.bus);
  return `${label}${idx === null ? '' : ` ${idx}`}${bus === null ? '' : ` on bus ${bus}`}`;
}

export interface AddElementPanelProps {
  className?: string;
}

export function AddElementPanel({ className }: AddElementPanelProps) {
  const open = useCaseStore((s) => s.addPanelOpen);
  const requestedKind = useCaseStore((s) => s.addPanelKind);
  const dirty = useCaseStore((s) => s.addPanelDirty);
  const setKind = useCaseStore((s) => s.setAddPanelKind);
  const closeAddPanel = useCaseStore((s) => s.closeAddPanel);
  const openAddPanelOnBus = useCaseStore((s) => s.openAddPanelOnBus);
  const setDirty = useCaseStore((s) => s.setAddPanelDirty);
  // v3 Unit 5: optional drop coordinate seeded by SldCanvas's onDrop
  // handler. For kind === 'Bus' this surfaces as a "drop position" hint
  // above the form (the Bus model has no x/y param fields — coords
  // live in the sidecar layout — so we surface the seed for the user
  // to confirm rather than auto-writing into a non-existent field).
  // For non-Bus kinds dropCoord is informational and the panel ignores
  // it (non-Bus elements anchor to a parent bus, so a free coordinate
  // doesn't apply).
  const dropCoord = useCaseStore((s) => s.addPanelDropCoord);
  // The bus "Add element here" was chosen on, which each form opens on.
  const seedBus = useCaseStore((s) => s.addPanelBus);
  const sessionId = useSessionStore((s) => s.sessionId);
  const addMutation = useAddElement();
  const schema = useTopologySchema();
  const topology = useCurrentTopology();
  const baseMva = topology?.base_mva ?? null;
  const [serverError, setServerError] = useState<string | null>(null);
  // What the server refused goes once the form no longer holds it.
  const clearServerError = useCallback(() => setServerError(null), []);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  // Building a system means adding many elements in a row, so the panel stays
  // OPEN after a successful add and resets the form for the next element
  // (close explicitly via the ✕). ``addedCount`` bumps the form ``key`` so it
  // remounts with fresh defaults; ``lastAdded`` drives a brief confirmation.
  const [addedCount, setAddedCount] = useState(0);
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);

  // The confirmation is about this visit to the panel: the next time it opens,
  // the element it names was added a while ago.
  useEffect(() => {
    if (!open) setLastAdded(null);
  }, [open]);

  if (!open) return null;

  const kind = pickerKindFor(requestedKind);

  const requestClose = () => {
    if (dirty) {
      setConfirmCancelOpen(true);
      return;
    }
    closeAddPanel();
    setServerError(null);
  };

  const kindEntry = SUPPORTED_KINDS.find((k) => k.value === kind);
  const submitModel = kindEntry?.submitModel ?? kind ?? '';
  const formModel = submitModel; // ElementForm renders fields from this model's schema.
  // What the kind itself sets (a transformer's tap), then what the model opens
  // with for this case (a battery's rating is the system base).
  const defaultParams = kindEntry?.defaultParams ?? elementDefaults(submitModel, { baseMva });

  const handleSubmit = (params: Record<string, ParamValue>) => {
    if (!sessionId || !submitModel) return;
    setServerError(null);
    // Merge in default params (e.g., Transformer (2W) auto-sets tap=1.05).
    // The user can override by editing the field on the form.
    const finalParams = defaultParams ? { ...defaultParams, ...params } : params;
    addMutation.mutate(
      { sessionId, body: { model: submitModel, params: finalParams } },
      {
        onSuccess: () => {
          // Keep the panel OPEN so the user can add the next element without
          // re-opening it (building a system is many adds in a row). Reset the
          // form via a key bump and clear the dirty flag; the kind is kept so
          // a run of same-kind adds (e.g. 9 buses) is fast. ✕ closes manually.
          setServerError(null);
          setDirty(false);
          setLastAdded(describeAdded(kindEntry?.label ?? submitModel, finalParams));
          setAddedCount((c) => c + 1);
          // The submit button is at the foot of a long form and the line that
          // confirms the add at its head: bring the head back into view.
          if (panelRef.current) panelRef.current.scrollTop = 0;
        },
        onError: (err) => {
          if (err instanceof ProblemDetailsError) {
            // 409 means the session was committed mid-flight — close
            // the panel so the inspector's reset banner takes over.
            if (err.status === 409) {
              closeAddPanel();
              return;
            }
            setServerError(err.detail ?? err.title ?? 'Add rejected');
          } else {
            setServerError(err.message ?? 'Add failed');
          }
        },
      },
    );
  };

  // The name of the bus the panel was opened from, or null once the case has no such bus.
  const seedBusName =
    seedBus === null
      ? null
      : ((topology?.buses ?? []).find((b) => String(b.idx) === seedBus)?.name ?? null);

  type KindEntry = (typeof SUPPORTED_KINDS)[number];
  const groupedKinds = SUPPORTED_KINDS.reduce<Record<string, KindEntry[]>>((acc, k) => {
    (acc[k.group] ??= []).push(k);
    return acc;
  }, {});

  return (
    <>
      <aside
        ref={panelRef}
        role="region"
        aria-label="Add element"
        data-testid="add-element-panel"
        className={cn(
          // ``pointer-events-auto`` opts THIS visible panel into hit-testing.
          // Required because v3 AppShell's dock-overlay wrapper is
          // ``pointer-events-none`` to avoid blocking chassis clicks.
          'pointer-events-auto absolute inset-y-0 right-0 z-30',
          // Compact fixed width so the canvas stays visible while the
          // user adds elements; max-w guards small viewports.
          'w-[420px] max-w-[90vw]',
          'bg-background border-border border-l shadow-xl',
          'flex flex-col gap-3 overflow-auto p-4',
          className,
        )}
      >
        <header className="flex items-center justify-between">
          <h2 className="text-foreground font-semibold">Add element</h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={requestClose}
            aria-label="Close add-element panel"
            data-testid="add-element-close"
          >
            ✕
          </Button>
        </header>

        <div className="flex flex-col gap-1">
          <label htmlFor="add-element-kind" className="text-muted-foreground text-xs font-medium">
            Kind
          </label>
          <select
            id="add-element-kind"
            data-testid="add-element-kind"
            value={kind ?? ''}
            onChange={(e) => {
              setKind(e.target.value || null);
              // What the server refused was a value of the form this replaces.
              setServerError(null);
            }}
            className="bg-background border-border h-8 rounded border px-2 text-sm"
          >
            <option value="" disabled>
              Pick a kind…
            </option>
            {Object.entries(groupedKinds).map(([groupName, items]) => (
              <optgroup key={groupName} label={groupName}>
                {items.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        {kind === 'Bus' && dropCoord ? (
          <div
            data-testid="add-element-drop-coord"
            className={cn(
              'border-border bg-muted/40 text-muted-foreground',
              'rounded-[var(--radius-sm)] border px-2 py-1 text-[10px]',
            )}
          >
            <span className="font-mono">
              Drop position: x={dropCoord.x.toFixed(0)}, y={dropCoord.y.toFixed(0)}
            </span>
          </div>
        ) : null}

        {seedBus !== null && seedBusName !== null ? (
          <div
            data-testid="add-element-seed-bus"
            className={cn(
              'border-border bg-muted/40 text-muted-foreground',
              'rounded-[var(--radius-sm)] border px-2 py-1 text-[11px] leading-snug',
            )}
          >
            Adding on bus{' '}
            <span className="text-foreground font-mono">
              {seedBusName !== seedBus ? `${seedBusName} (idx ${seedBus})` : seedBus}
            </span>
            : a form that has a bus opens with it chosen.
          </div>
        ) : null}

        {lastAdded ? (
          <div
            role="status"
            data-testid="add-element-success"
            className={cn(
              'border-success/30 bg-success/10 text-foreground',
              'rounded-[var(--radius-sm)] border px-2 py-1 text-[11px] leading-snug',
            )}
          >
            Added {lastAdded}. The panel stays open for the next element: pick another Kind above,
            or close the panel when you are done.
          </div>
        ) : null}

        {kind && schema.data && formModel ? (
          <ElementForm
            // A fresh form after each add, and when it is sent to another bus.
            key={`${formModel}-${addedCount}-${seedBus ?? ''}`}
            model={formModel}
            kindHint={kind}
            defaultParams={defaultParams}
            seedBus={seedBus}
            // From a battery or a machine on a bus without a static generator:
            // the PV form on that bus. The panel stays on the bus, so the form
            // that asked comes back with the bus and the new generator chosen.
            onAddGenerator={(bus) => {
              openAddPanelOnBus(bus);
              setKind('PV');
              setServerError(null);
            }}
            saving={addMutation.isPending}
            serverError={serverError}
            onSubmit={handleSubmit}
            onCancel={requestClose}
            onDirtyChange={setDirty}
            onEdit={clearServerError}
          />
        ) : (
          <p className="text-muted-foreground text-xs">
            Pick a kind above to start filling out the form.
          </p>
        )}
      </aside>
      <CancelConfirmDialog
        open={confirmCancelOpen}
        onCancel={() => setConfirmCancelOpen(false)}
        onConfirm={() => {
          setConfirmCancelOpen(false);
          closeAddPanel();
          setServerError(null);
        }}
      />
    </>
  );
}
