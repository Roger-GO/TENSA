/**
 * SweepDialog (Unit 18 of the v2.0 plan).
 *
 * Modal that captures sweep parameters from the user and POSTs to
 * ``/api/sessions/{id}/sweep``. The UI surface is intentionally
 * functional rather than polished — the substrate-side correctness
 * is the primary concern in v2.0.
 *
 * Inputs:
 * - Snapshot picker (from ``useListSnapshots``).
 * - Parameter kind (one of the substrate's allowed `SweepParamKind`s).
 * - Target (disturbance index in the snapshot's recorded log).
 * - Range start / end / steps.
 * - tf (per-iteration sim time).
 *
 * Submitting calls ``useStartSweep`` and on success registers the
 * sweep in the sweep store + opens the SweepStream WS subscription
 * (the WS lifecycle is owned by the SweepProgressPanel which mounts
 * inside the HistoryDrawer once the sweep is active).
 */
import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useStartSweep, useListSnapshots } from '@/api/queries';
import type { SweepParamKind } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { useSweepStore } from '@/store/sweep';
import { useRunReadiness } from '@/lib/useRunReadiness';
import { ProblemDetailsError } from '@/api/client';
import { cn } from '@/lib/cn';

const PARAM_KIND_OPTIONS: ReadonlyArray<{ value: SweepParamKind; label: string }> = [
  { value: 'disturbance.fault.tc', label: 'Fault clearing time (tc)' },
  { value: 'disturbance.fault.tf', label: 'Fault application time (tf)' },
  { value: 'disturbance.fault.xf', label: 'Fault reactance (xf)' },
  { value: 'disturbance.fault.rf', label: 'Fault resistance (rf)' },
  { value: 'disturbance.toggle.t', label: 'Toggle time (t)' },
  { value: 'disturbance.alter.t', label: 'Alter time (t)' },
  { value: 'disturbance.alter.value', label: 'Alter value' },
];

export interface SweepDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SweepDialog({ open, onOpenChange }: SweepDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <SweepDialogInner onClose={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}

function SweepDialogInner({ onClose }: { onClose: () => void }) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const startSweep = useStartSweep();
  const startSweepRecord = useSweepStore((s) => s.startSweep);
  const snapshotsQuery = useListSnapshots();
  // Run-readiness hook (Unit 4 of v2.0 polish) gates the submit button
  // on the same prerequisites as the other Run buttons — most relevant
  // here is "Sweep <id> in progress; wait or abort." which fires when
  // the user opens the dialog while a sweep is already running. The
  // dialog's local validation (snapshot picked, range valid, ...) is
  // ANDed with the readiness state.
  const readiness = useRunReadiness('sweep');

  const [snapshotName, setSnapshotName] = useState<string>('');
  const [parameterKind, setParameterKind] =
    useState<SweepParamKind>('disturbance.fault.tc');
  const [parameterTarget, setParameterTarget] = useState<number>(0);
  const [rangeStart, setRangeStart] = useState<number>(1.05);
  const [rangeEnd, setRangeEnd] = useState<number>(1.5);
  const [rangeSteps, setRangeSteps] = useState<number>(10);
  const [tf, setTf] = useState<number>(2.0);
  const [error, setError] = useState<string | null>(null);

  const snapshots = snapshotsQuery.data?.snapshots ?? [];

  const validation = ((): string | null => {
    if (!snapshotName) return 'Pick a snapshot to sweep against.';
    if (rangeSteps < 2) return 'Steps must be at least 2.';
    if (rangeSteps > 200) return 'Steps capped at 200.';
    if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd))
      return 'Range start and end must be finite numbers.';
    if (rangeStart === rangeEnd) return 'Range start and end must differ.';
    if (tf <= 0) return 'tf must be positive.';
    if (parameterTarget < 0) return 'Target index must be >= 0.';
    return null;
  })();

  const submit = async () => {
    if (sessionId === null || validation !== null) return;
    setError(null);
    try {
      const result = await startSweep.mutateAsync({
        sessionId,
        parameterKind,
        parameterTarget,
        rangeStart,
        rangeEnd,
        rangeSteps,
        tf,
        snapshotName,
      });
      startSweepRecord({
        sweepId: result.sweep_id,
        parameterKind,
        parameterTarget,
        snapshotName,
        total: result.total,
      });
      onClose();
    } catch (err) {
      const detail =
        err instanceof ProblemDetailsError
          ? (err.detail ?? err.title ?? `HTTP ${err.status}`)
          : err instanceof Error
            ? err.message
            : 'unknown error';
      setError(`Sweep start failed: ${detail}`);
    }
  };

  const isPending = startSweep.isPending;

  return (
    <DialogContent data-testid="sweep-dialog">
      <DialogTitle>Start sensitivity sweep</DialogTitle>
      <DialogDescription className="mt-2">
        Iterate one parameter through a range. Each iteration restores the
        named snapshot, applies the parameter override, and runs TDS. Other
        session-scoped operations are paused for the sweep duration.
      </DialogDescription>

      <div className="mt-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-foreground text-xs font-medium">Snapshot</span>
          <select
            data-testid="sweep-dialog-snapshot"
            value={snapshotName}
            disabled={isPending}
            onChange={(e) => setSnapshotName(e.target.value)}
            className={cn(
              'border-border bg-background text-foreground',
              'rounded-[var(--radius-sm)] border px-2 py-1.5 text-sm',
            )}
          >
            <option value="">— pick a snapshot —</option>
            {snapshots.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name} ({s.disturbance_count} disturbances)
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-foreground text-xs font-medium">Parameter</span>
          <select
            data-testid="sweep-dialog-parameter-kind"
            value={parameterKind}
            disabled={isPending}
            onChange={(e) => setParameterKind(e.target.value as SweepParamKind)}
            className={cn(
              'border-border bg-background text-foreground',
              'rounded-[var(--radius-sm)] border px-2 py-1.5 text-sm',
            )}
          >
            {PARAM_KIND_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-foreground text-xs font-medium">
            Target disturbance index
          </span>
          <input
            type="number"
            min={0}
            data-testid="sweep-dialog-target"
            value={parameterTarget}
            disabled={isPending}
            onChange={(e) => setParameterTarget(Number(e.target.value) || 0)}
            className={cn(
              'border-border bg-background text-foreground',
              'rounded-[var(--radius-sm)] border px-2 py-1.5 text-sm',
            )}
          />
        </label>

        <div className="flex gap-2">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-foreground text-xs font-medium">Range start</span>
            <input
              type="number"
              step="any"
              data-testid="sweep-dialog-range-start"
              value={rangeStart}
              disabled={isPending}
              onChange={(e) => setRangeStart(Number(e.target.value))}
              className={cn(
                'border-border bg-background text-foreground',
                'rounded-[var(--radius-sm)] border px-2 py-1.5 text-sm',
              )}
            />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-foreground text-xs font-medium">Range end</span>
            <input
              type="number"
              step="any"
              data-testid="sweep-dialog-range-end"
              value={rangeEnd}
              disabled={isPending}
              onChange={(e) => setRangeEnd(Number(e.target.value))}
              className={cn(
                'border-border bg-background text-foreground',
                'rounded-[var(--radius-sm)] border px-2 py-1.5 text-sm',
              )}
            />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-foreground text-xs font-medium">Steps</span>
            <input
              type="number"
              min={2}
              max={200}
              data-testid="sweep-dialog-range-steps"
              value={rangeSteps}
              disabled={isPending}
              onChange={(e) => setRangeSteps(Number(e.target.value) || 2)}
              className={cn(
                'border-border bg-background text-foreground',
                'rounded-[var(--radius-sm)] border px-2 py-1.5 text-sm',
              )}
            />
          </label>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-foreground text-xs font-medium">
            Per-iteration tf (s)
          </span>
          <input
            type="number"
            step="any"
            min={0.001}
            data-testid="sweep-dialog-tf"
            value={tf}
            disabled={isPending}
            onChange={(e) => setTf(Number(e.target.value))}
            className={cn(
              'border-border bg-background text-foreground',
              'rounded-[var(--radius-sm)] border px-2 py-1.5 text-sm',
            )}
          />
        </label>

        {validation !== null ? (
          <p
            role="alert"
            data-testid="sweep-dialog-validation"
            className="text-destructive text-xs"
          >
            {validation}
          </p>
        ) : null}
        {error !== null ? (
          <div
            role="alert"
            data-testid="sweep-dialog-error"
            className={cn(
              'border-destructive/30 bg-destructive/10 text-foreground',
              'rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs',
            )}
          >
            {error}
          </div>
        ) : null}
      </div>

      <DialogFooter className="mt-4 flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onClose}
          disabled={isPending}
          data-testid="sweep-dialog-cancel"
        >
          Cancel
        </Button>
        <SweepConfirmButton
          isPending={isPending}
          validationError={validation}
          readinessReason={readiness.disabledReason}
          ready={readiness.ready}
          sessionId={sessionId}
          onClick={() => void submit()}
        />
      </DialogFooter>
    </DialogContent>
  );
}

/**
 * Confirm button for the sweep dialog. The submit is gated by three
 * orthogonal concerns:
 *
 *   1. ``isPending`` — the start-sweep mutation is in flight.
 *   2. ``validationError`` — local form validation (snapshot picked,
 *      range valid, ...). Already surfaced inline as a ``role="alert"``
 *      under the form fields, so we don't tooltip-double it.
 *   3. ``readinessReason`` — the cross-cutting Run-readiness gate from
 *      the hook (no case loaded, sweep already in progress, ...). This
 *      one IS surfaced as a tooltip on the disabled button per Unit 4
 *      of the v2.0 polish plan.
 */
function SweepConfirmButton({
  isPending,
  validationError,
  readinessReason,
  ready,
  sessionId,
  onClick,
}: {
  isPending: boolean;
  validationError: string | null;
  readinessReason: string | null;
  ready: boolean;
  sessionId: unknown;
  onClick: () => void;
}) {
  const disabled =
    isPending || sessionId === null || validationError !== null || !ready;

  const button = (
    <Button
      type="button"
      variant="primary"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      data-testid="sweep-dialog-confirm"
    >
      {isPending ? 'Starting…' : 'Start sweep'}
    </Button>
  );

  // Only surface the readiness reason as a tooltip — the validation
  // error is already shown inline as a ``role="alert"``. If both are
  // present (e.g., no case loaded AND no snapshot picked), the
  // readiness reason wins as the tooltip surface; the inline
  // validation alert still renders below the form.
  if (readinessReason !== null) {
    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-block">
              {button}
            </span>
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent data-testid="sweep-dialog-confirm-disabled-reason">
              {readinessReason}
            </TooltipContent>
          </TooltipPortal>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return button;
}
