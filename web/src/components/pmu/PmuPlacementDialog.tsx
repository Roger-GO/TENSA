import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useAddPmu, useDeletePmu, useListPmus, useCurrentTopology } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { usePmuStore } from '@/store/pmu';
import { ProblemDetailsError } from '@/api/client';
import { cn } from '@/lib/cn';

/**
 * PmuPlacementDialog — modal dialog for placing PMUs at user-selected
 * buses. Opened from the "+ Add element" menu's "Add PMU…" entry.
 *
 * Layout:
 *
 *   ┌───────────────────────────────────────────────────────┐
 *   │ Place PMU                                             │
 *   │ Select one or more buses to instrument with PMUs.     │
 *   │                                                       │
 *   │ Currently placed: PMU_1 (bus 5), PMU_2 (bus 9)        │
 *   │   [×] [×]                                             │
 *   │                                                       │
 *   │ Available buses:                                      │
 *   │   ☐ Bus 1 — name1                                     │
 *   │   ☐ Bus 2 — name2                                     │
 *   │   ...                                                 │
 *   │                                                       │
 *   │ Filter time constants (apply to every new placement): │
 *   │   Ta: [0.05] s     Tv: [0.05] s                       │
 *   │                                                       │
 *   │              [Cancel]  [Place 3 PMUs]                 │
 *   └───────────────────────────────────────────────────────┘
 *
 * The "Place" action issues one ``POST /pmu`` per checked bus,
 * sequentially (the substrate is single-threaded per session — issuing
 * them in parallel would interleave at the worker boundary). Failures
 * surface inline; partial success is preserved (the substrate has
 * already accepted the PMUs that succeeded).
 *
 * Reset behaviour: closing the dialog drops the per-session draft
 * (checked buses); the substrate-side placement state is the truth.
 */

export interface PmuPlacementDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

export function PmuPlacementDialog({ open, onOpenChange }: PmuPlacementDialogProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const topology = useCurrentTopology();
  const buses = useMemo(() => topology?.buses ?? [], [topology]);
  // Subscribe to the listPmus query whenever the dialog is open so the
  // placement list stays in sync after add/delete mutations.
  const list = useListPmus();
  const placedPmus = usePmuStore((s) => s.pmus);
  const addMutation = useAddPmu();
  const deleteMutation = useDeletePmu();

  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [Ta, setTa] = useState<string>('0.05');
  const [Tv, setTv] = useState<string>('0.05');
  const [serverError, setServerError] = useState<string | null>(null);

  // Reset draft each time the dialog opens. Stale state from a prior
  // open shouldn't leak into the next session.
  useEffect(() => {
    if (open) {
      setChecked(new Set());
      setTa('0.05');
      setTv('0.05');
      setServerError(null);
      // Trigger a fresh list fetch on open in case the substrate's
      // PMU set drifted (e.g., another tab placed one).
      void list.refetch();
    }
    // ``list`` reference changes on each render; we deliberately
    // exclude it from deps so this only fires on open transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const placedBusIdxes = useMemo(
    () => new Set(placedPmus.map((p) => String(p.params?.bus ?? ''))),
    [placedPmus],
  );

  const toggleBus = (idx: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const taNum = Number.parseFloat(Ta);
  const tvNum = Number.parseFloat(Tv);
  const taValid = Number.isFinite(taNum) && taNum > 0;
  const tvValid = Number.isFinite(tvNum) && tvNum > 0;
  const canPlace =
    sessionId !== null && checked.size > 0 && taValid && tvValid && !addMutation.isPending;

  const handlePlace = async () => {
    if (!sessionId) return;
    setServerError(null);
    // Sequential — the substrate is single-threaded per session, and the
    // user expects deterministic placement order matching click order.
    for (const busIdx of checked) {
      try {
        await addMutation.mutateAsync({
          sessionId,
          body: { bus_idx: busIdx, Ta: taNum, Tv: tvNum },
        });
      } catch (err) {
        if (err instanceof ProblemDetailsError) {
          setServerError(err.detail ?? err.title ?? `Place rejected (${err.status})`);
        } else if (err instanceof Error) {
          setServerError(err.message);
        } else {
          setServerError('Place failed');
        }
        return;
      }
    }
    setChecked(new Set());
    // Stay open so the user can place more / verify the new entries.
    // Caller closes via Cancel.
  };

  const handleDelete = async (idx: string) => {
    if (!sessionId) return;
    setServerError(null);
    try {
      await deleteMutation.mutateAsync({ sessionId, idx });
    } catch (err) {
      if (err instanceof ProblemDetailsError) {
        setServerError(err.detail ?? err.title ?? `Delete rejected (${err.status})`);
      } else if (err instanceof Error) {
        setServerError(err.message);
      } else {
        setServerError('Delete failed');
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="pmu-placement-dialog" className="max-w-lg">
        <DialogTitle>Place PMU</DialogTitle>
        <DialogDescription className="mt-1">
          Select one or more buses to instrument with phasor measurement units. PMUs track bus
          voltage magnitude and angle during TDS; export the trajectories as CSV from the Run
          history after the simulation completes.
        </DialogDescription>

        {/* Currently-placed list */}
        <section className="mt-3" aria-labelledby="pmu-placed-heading">
          <h3 id="pmu-placed-heading" className="text-foreground text-xs font-medium uppercase">
            Currently placed ({placedPmus.length})
          </h3>
          {placedPmus.length === 0 ? (
            <p className="text-muted-foreground mt-1 text-xs">
              No PMUs placed on this session yet.
            </p>
          ) : (
            <ul data-testid="pmu-placed-list" className="mt-1 flex flex-wrap gap-1">
              {placedPmus.map((pmu) => {
                const idxStr = String(pmu.idx);
                const busLabel = String(pmu.params?.bus ?? '?');
                return (
                  <li
                    key={idxStr}
                    className="bg-muted flex items-center gap-1 rounded px-2 py-1 text-xs"
                    data-testid={`pmu-placed-item-${idxStr}`}
                  >
                    <span className="font-mono">{idxStr}</span>
                    <span className="text-muted-foreground">(bus {busLabel})</span>
                    <button
                      type="button"
                      onClick={() => handleDelete(idxStr)}
                      disabled={deleteMutation.isPending}
                      aria-label={`Delete ${idxStr}`}
                      data-testid={`pmu-delete-${idxStr}`}
                      className="text-muted-foreground hover:text-foreground ml-1"
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Bus picker */}
        <section className="mt-3" aria-labelledby="pmu-buses-heading">
          <h3 id="pmu-buses-heading" className="text-foreground text-xs font-medium uppercase">
            Available buses
          </h3>
          {buses.length === 0 ? (
            <p className="text-muted-foreground mt-1 text-xs">Load a case first.</p>
          ) : (
            <div
              className="border-border mt-1 max-h-48 overflow-auto rounded border p-2"
              data-testid="pmu-bus-picker"
            >
              {buses.map((bus) => {
                const idxStr = String(bus.idx);
                const alreadyPlaced = placedBusIdxes.has(idxStr);
                const isChecked = checked.has(idxStr);
                return (
                  <label
                    key={idxStr}
                    className={cn(
                      'flex items-center gap-2 py-0.5 text-xs',
                      alreadyPlaced && 'text-muted-foreground',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleBus(idxStr)}
                      data-testid={`pmu-bus-checkbox-${idxStr}`}
                    />
                    <span className="font-mono">{idxStr}</span>
                    <span className="text-muted-foreground">— {bus.name}</span>
                    {alreadyPlaced && (
                      <span className="text-muted-foreground ml-auto text-[10px] italic">
                        already has PMU
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </section>

        {/* Filter constants */}
        <section className="mt-3 flex gap-3">
          <div className="flex flex-col gap-0.5">
            <label
              htmlFor="pmu-ta-input"
              className="text-muted-foreground text-[10px] font-medium uppercase"
            >
              Ta (angle filter, s)
            </label>
            <input
              id="pmu-ta-input"
              type="number"
              step="0.01"
              min="0.001"
              value={Ta}
              onChange={(e) => setTa(e.target.value)}
              data-testid="pmu-ta-input"
              className={cn(
                'bg-background border-border h-7 w-20 rounded border px-2 text-xs',
                !taValid && 'border-danger',
              )}
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <label
              htmlFor="pmu-tv-input"
              className="text-muted-foreground text-[10px] font-medium uppercase"
            >
              Tv (voltage filter, s)
            </label>
            <input
              id="pmu-tv-input"
              type="number"
              step="0.01"
              min="0.001"
              value={Tv}
              onChange={(e) => setTv(e.target.value)}
              data-testid="pmu-tv-input"
              className={cn(
                'bg-background border-border h-7 w-20 rounded border px-2 text-xs',
                !tvValid && 'border-danger',
              )}
            />
          </div>
        </section>

        {serverError !== null && (
          <p role="alert" data-testid="pmu-server-error" className="text-danger mt-2 text-xs">
            {serverError}
          </p>
        )}

        <DialogFooter className="mt-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            data-testid="pmu-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={handlePlace}
            disabled={!canPlace}
            data-testid="pmu-place-submit"
          >
            {addMutation.isPending
              ? 'Placing…'
              : checked.size === 0
                ? 'Select bus(es)'
                : `Place ${checked.size} PMU${checked.size === 1 ? '' : 's'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
