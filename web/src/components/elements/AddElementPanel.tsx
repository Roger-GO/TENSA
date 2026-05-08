import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAddElement, useTopologySchema } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { ProblemDetailsError } from '@/api/client';
import type { ParamValue } from '@/api/types';
import { cn } from '@/lib/cn';
import { ElementForm } from './ElementForm';
import { CancelConfirmDialog } from './CancelConfirmDialog';

/**
 * AddElementPanel — slide-over from the right edge of the right dock,
 * occupying ~70% of dock width. The Inspector remains visible at the
 * left ~30% so the user can reference the currently-selected element
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
 *     201 → topology re-fetch → close
 *     422 → inline error, panel stays open
 *     409 → close + caller surfaces reset banner
 */

const SUPPORTED_KINDS = [
  // Network
  { value: 'Bus', label: 'Bus', group: 'Network' },
  { value: 'Line', label: 'Line', group: 'Network' },
  // Generators
  { value: 'PV', label: 'PV generator', group: 'Generators' },
  { value: 'Slack', label: 'Slack generator', group: 'Generators' },
  { value: 'GENROU', label: 'GENROU (synchronous)', group: 'Generators' },
  { value: 'GENCLS', label: 'GENCLS (classic)', group: 'Generators' },
  // Loads
  { value: 'PQ', label: 'PQ load', group: 'Loads' },
  { value: 'ZIP', label: 'ZIP load', group: 'Loads' },
  // Shunts
  { value: 'Shunt', label: 'Shunt', group: 'Shunts' },
];

export interface AddElementPanelProps {
  className?: string;
}

export function AddElementPanel({ className }: AddElementPanelProps) {
  const open = useCaseStore((s) => s.addPanelOpen);
  const kind = useCaseStore((s) => s.addPanelKind);
  const dirty = useCaseStore((s) => s.addPanelDirty);
  const setKind = useCaseStore((s) => s.setAddPanelKind);
  const closeAddPanel = useCaseStore((s) => s.closeAddPanel);
  const setDirty = useCaseStore((s) => s.setAddPanelDirty);
  const sessionId = useSessionStore((s) => s.sessionId);
  const addMutation = useAddElement();
  const schema = useTopologySchema();
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);

  if (!open) return null;

  const requestClose = () => {
    if (dirty) {
      setConfirmCancelOpen(true);
      return;
    }
    closeAddPanel();
    setServerError(null);
  };

  const handleSubmit = (params: Record<string, ParamValue>) => {
    if (!sessionId || !kind) return;
    setServerError(null);
    addMutation.mutate(
      { sessionId, body: { model: kind, params } },
      {
        onSuccess: () => {
          // Wait for the topology re-fetch the mutation triggered;
          // closing immediately would flash the empty-state. The
          // mutation's onSuccess invalidates the topology query, and
          // React Query refetches in the background — the panel can
          // close as soon as we know the add succeeded.
          closeAddPanel();
          setServerError(null);
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

  const groupedKinds = SUPPORTED_KINDS.reduce<Record<string, typeof SUPPORTED_KINDS>>((acc, k) => {
    (acc[k.group] ??= []).push(k);
    return acc;
  }, {});

  return (
    <>
      <aside
        role="region"
        aria-label="Add element"
        data-testid="add-element-panel"
        className={cn(
          'absolute inset-y-0 right-0 z-30',
          // ~70% of the dock width via inline style — the dock itself is
          // resizable, so a percentage on the panel keeps the inspector
          // visible behind at the left ~30%.
          'w-[70%]',
          'bg-background border-border border-l shadow-xl',
          'flex flex-col gap-3 p-4 overflow-auto',
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
          <label
            htmlFor="add-element-kind"
            className="text-muted-foreground text-xs font-medium"
          >
            Kind
          </label>
          <select
            id="add-element-kind"
            data-testid="add-element-kind"
            value={kind ?? ''}
            onChange={(e) => setKind(e.target.value || null)}
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

        {kind && schema.data ? (
          <ElementForm
            model={kind}
            saving={addMutation.isPending}
            serverError={serverError}
            onSubmit={handleSubmit}
            onCancel={requestClose}
            onDirtyChange={setDirty}
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
