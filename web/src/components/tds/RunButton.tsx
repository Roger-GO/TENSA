import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useAbortRun, useCommitDisturbances, useResetRun, useRunPflow } from '@/api/queries';
import { ProblemDetailsError, ServerError } from '@/api/client';
import { useSessionStore } from '@/store/session';
import { useAuthStore } from '@/store/auth';
import { usePflowStore } from '@/store/pflow';
import { useDisturbanceStore } from '@/store/disturbance';
import { useRunsStore } from '@/store/runs';
import { useUiStore } from '@/store/ui';
import { RunStream } from '@/streaming/RunStream';
import type { RunStreamError, VarGroup } from '@/streaming/RunStream';
import { buildRunStreamWsUrl } from '@/streaming/wsUrl';
import { useRunReadiness, type RunRoutine } from '@/lib/useRunReadiness';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';

/**
 * RunButton (v0.2). The top-bar primary action that consolidates v0.1's
 * PF-only ``Run`` into a PF-or-TDS controller.
 *
 * Mode selection (auto + manual):
 *
 * - Default mode is ``"tds"`` when the local disturbance editor has at
 *   least one disturbance (the user has expressed intent to run a
 *   transient simulation); ``"pf"`` otherwise.
 * - A small segmented control to the right of the button lets the user
 *   override the auto pick. Manual selection sticks until a state change
 *   (case load / reset) wipes it.
 *
 * State machine:
 *
 * - **Idle**: button enabled, label is "Run TDS" / "Run PF". Disabled if
 *   no case is loaded or no session is active (mirrors v0.1's behaviour
 *   so the same disabled-tooltip cause story applies).
 * - **Running (TDS)**: label is "Streaming…" with a spinner; the button
 *   becomes a single-shot abort affordance — clicking ``POST /abort``
 *   asks the substrate to halt, and the WS keeps streaming until the
 *   terminal ``done`` arrives. After the click the label becomes
 *   "Aborting…" + disabled until ``done``.
 * - **Running (PF)**: label is "Running PF…" + disabled (the PF wrapper
 *   has no abort path; mirrors v0.1).
 * - **Done / Error / Aborted (TDS)**: label flips to "Reset run". Click
 *   fires ``POST /reload`` and clears the run buffer; back to Idle.
 *
 * Error routing (per the v0.2 plan's R8 taxonomy):
 *
 * - WS ``auth_failed`` (close 4401) → cascade-clears the auth token
 *   (``useAuthStore.clearToken``) which re-opens ``TokenPasteModal`` via
 *   the existing v0.1 path — no new modal owned here.
 * - WS ``run_not_found`` (close 4404) → non-modal warning toast inviting
 *   the user to Reset and re-run.
 * - WS ``buffer_evicted`` (resync) → non-modal warning toast.
 * - WS ``protocol_error`` / ``worker_error`` → handled via the runs
 *   slice's ``markRunError`` path (already wired by ``RunStream``); the
 *   runtime-crash modal opens via the existing PF surface when the call
 *   came through the HTTP path.
 * - TDS ``done`` with ``converged === false`` AND ``abortedLocally !==
 *   true`` → ``NumericalErrorBanner`` (mounted in ``App.tsx``'s
 *   ``dockOverlay`` slot); this component does nothing extra here.
 * - TDS ``done`` with ``abortedLocally === true`` → run state flips to
 *   ``"aborted"`` (handled below) so the badge shows "Aborted at t=X".
 * - HTTP commit-disturbances 422 → routed via ``DisturbancePanel`` per-row
 *   error (the disturbance slice carries the error keyed by index); the
 *   button surfaces a compact toast pointing the user at the panel.
 *
 * The component is intentionally chunky — it owns the start-flow
 * orchestration (commit → open WS → wire callbacks → cleanup on unmount)
 * because there's no useful smaller boundary that doesn't either leak
 * mutation handles or fragment the lifecycle across components.
 */

export type RunMode = 'pf' | 'tds';

export interface RunButtonProps {
  className?: string;
  /**
   * Override the default ``vars`` set forwarded to ``start_tds``. When
   * unset, the value comes from ``useUiStore.tdsConfig.vars`` (the
   * TdsConfigPanel form — Unit 8). Tests pass an explicit value to
   * bypass the store coupling.
   */
  defaultVars?: readonly VarGroup[];
  /** Override the default final sim time. When unset, uses TdsConfigPanel's value. */
  defaultTf?: number;
  /**
   * Override the default fixed step (seconds). When unset, uses
   * TdsConfigPanel's value (which itself defaults to ``null`` →
   * substrate-adaptive).
   */
  defaultH?: number;
}

function Spinner() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="animate-spin"
    >
      <path d="M8 1.5 A6.5 6.5 0 1 1 1.5 8" />
    </svg>
  );
}

export function RunButton({ className, defaultVars, defaultTf, defaultH }: RunButtonProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const token = useAuthStore((s) => s.token);
  const isPfRunning = usePflowStore((s) => s.isRunning);
  const disturbances = useDisturbanceStore((s) => s.disturbances);
  // TDS args are owned by ``TdsConfigPanel`` (Unit 8) and live in
  // ``useUiStore``. Props remain as test-only overrides.
  const tdsConfig = useUiStore((s) => s.tdsConfig);
  // Unit 16: integrator preset + adaptive tolerance overrides. The
  // ``-auto`` / ``-manual`` suffix is a UI-side distinction; both wire
  // up to ``integrator: "qndf"`` and forward the overrides. Manual mode
  // exposes the inputs in TdsConfigPanel; Auto uses the same defaults.
  const tdsIntegrator = useUiStore((s) => s.tdsIntegrator);
  const tdsToleranceOverrides = useUiStore((s) => s.tdsToleranceOverrides);
  // Unit 14: free-form ``tds_config_overrides`` dict from the TDS
  // Advanced key-value editor. Empty by default → no overrides forwarded.
  const tdsConfigOverridesCustom = useUiStore((s) => s.tdsConfigOverrides);

  // Active-run handle (if any) — drives the Reset / Abort label switch.
  const activeRunId = useRunsStore((s) => s.activeRunId);
  const activeRun = useRunsStore((s) =>
    activeRunId === null ? null : (s.runs[activeRunId] ?? null),
  );

  const runPflow = useRunPflow();
  const commitDisturbances = useCommitDisturbances();
  const abortRun = useAbortRun();
  const resetRun = useResetRun();

  // Mode = "auto" derived from disturbances + a manual override that
  // sticks until the user changes it again. Using ``null`` to mean
  // "follow the auto rule" lets a user toggle back to "auto" by clicking
  // the same mode they're on (we just clear the override).
  const [manualMode, setManualMode] = useState<RunMode | null>(null);
  const autoMode: RunMode = disturbances.length > 0 ? 'tds' : 'pf';
  const mode: RunMode = manualMode ?? autoMode;

  // Toasts route through the global surface (Unit 3 of the v2.0 polish
  // plan: see `@/lib/toast` + `<Toaster />` mounted in AppShell). The
  // previous local-state toast slot has been retired — sonner stacks
  // multiple toasts and survives this component's unmount.

  // Active RunStream handle. Lives in a ref so renders don't re-create
  // it; cleaned up on unmount + on terminal events.
  const streamRef = useRef<RunStream | null>(null);
  // Track in-flight TDS attempts so the disabled state is correct between
  // "user clicked Run TDS" and "stream_start landed". Without this, the
  // button would briefly re-enable while the WS is still in handshake.
  const [tdsStarting, setTdsStarting] = useState(false);
  // Once the user clicks Abort we lock the button to "Aborting…" until
  // the WS emits the terminal ``done``. Tracked locally because the runs
  // slice's ``abortedLocally`` flag flips on HTTP success — independent
  // of when the substrate actually exits.
  const [aborting, setAborting] = useState(false);

  // Cleanup the stream on unmount so a navigation-away mid-run doesn't
  // leave a dangling WS. Idempotent — RunStream.dispose() guards against
  // double-call.
  useEffect(() => {
    return () => {
      streamRef.current?.dispose();
      streamRef.current = null;
    };
  }, []);

  const isTdsTerminal =
    activeRun !== null &&
    (activeRun.state === 'done' || activeRun.state === 'error' || activeRun.state === 'aborted');
  const isTdsRunning =
    activeRun !== null &&
    !isTdsTerminal &&
    (activeRun.state === 'starting' || activeRun.state === 'streaming');

  // Reset the local "aborting" flag once the WS has emitted the terminal
  // ``done`` (the run state flips to ``aborted`` / ``done`` / ``error``).
  useEffect(() => {
    if (isTdsTerminal && aborting) setAborting(false);
  }, [isTdsTerminal, aborting]);

  // When the WS done arrives with ``abortedLocally === true``, flip the
  // run state from ``done`` to ``aborted`` so the badge + banner can read
  // the right surface from a single field. RunStream emits ``done`` in
  // both cases (the wire format has no aborted flag).
  useEffect(() => {
    if (activeRun === null) return;
    if (
      activeRun.state === 'done' &&
      activeRun.abortedLocally &&
      activeRun.tCurrent < activeRun.tf
    ) {
      useRunsStore.getState().markRunAborted(activeRun.runId);
    }
  }, [activeRun]);

  // The Run-readiness hook (Unit 4 of the v2.0 polish plan) is the
  // single source of truth for "why is this Run button disabled". The
  // hook subscribes to the case + session + auth stores plus the
  // routine-specific prerequisites (sweep-in-progress for any routine,
  // EIG-mutated dae for PF). We pass the active mode so the same
  // button surface reuses the right gate as the user toggles between
  // PF and TDS.
  const readinessRoutine: RunRoutine = mode === 'pf' ? 'pflow' : 'tds';
  const readiness = useRunReadiness(readinessRoutine);
  const disabledReason = readiness.disabledReason;

  // ---- TDS start flow -----------------------------------------------------

  const startTds = async () => {
    if (!sessionId || !token) return;
    setTdsStarting(true);

    // Step 1: commit disturbances if non-empty. The substrate's
    // ``AddDisturbancesRequest`` has ``min_length=1`` so an empty list
    // would 422 — skip the call entirely for free-evolution runs.
    if (disturbances.length > 0) {
      try {
        await commitDisturbances.mutateAsync({
          sessionId,
          disturbances: disturbances.map((d) => d.spec),
        });
      } catch (err) {
        setTdsStarting(false);
        if (err instanceof ProblemDetailsError) {
          const detail = err.detail ?? err.title ?? `HTTP ${err.status}`;
          toast.error('TDS error', {
            description:
              err.status === 422
                ? `Disturbance rejected: ${detail}. Fix the failing row and retry.`
                : `Could not commit disturbances: ${detail}`,
          });
        } else {
          toast.error('TDS error', {
            description: err instanceof Error ? err.message : 'Could not commit disturbances.',
          });
        }
        return;
      }
    }

    // Step 2: open the WebSocket. Cleanly tear down any prior stream
    // first (defensive — a stale handle would race the new one).
    streamRef.current?.dispose();
    streamRef.current = null;

    const tf = defaultTf ?? tdsConfig.tf;
    const vars = defaultVars ?? tdsConfig.vars;
    // ``h`` is special: ``null`` from the store means "let substrate
    // pick adaptively" → omit from the wire payload entirely. The
    // ``defaultH`` prop overrides only when explicitly set.
    const h = defaultH !== undefined ? defaultH : (tdsConfig.h ?? undefined);
    // Unit 16: derive wire-side integrator + override payload from the
    // UI-side preset. ``trapezoidal`` ships only the integrator key;
    // both QNDF presets (Auto / Manual) ship the overrides too — the
    // user's last-edited Manual values are preserved in the store and
    // re-used in Auto mode (the inputs are hidden but the values stick).
    const wireIntegrator: 'trapezoidal' | 'qndf' =
      tdsIntegrator === 'trapezoidal' ? 'trapezoidal' : 'qndf';
    // Base overrides: the structured rtol/atol/max_step preset (QNDF
    // modes only). Unit 14 then merges the free-form editor dict on top
    // (the editor wins on key collisions). An empty editor + trapezoidal
    // integrator → ``undefined`` so the wire stays minimal and behaviour
    // is unchanged for the default path.
    const baseOverrides: Record<string, number> | undefined =
      tdsIntegrator === 'trapezoidal'
        ? undefined
        : {
            rtol: tdsToleranceOverrides.rtol,
            atol: tdsToleranceOverrides.atol,
            max_step: tdsToleranceOverrides.maxStep,
          };
    const hasCustomOverrides = Object.keys(tdsConfigOverridesCustom).length > 0;
    const tdsConfigOverrides =
      baseOverrides === undefined && !hasCustomOverrides
        ? undefined
        : { ...(baseOverrides ?? {}), ...tdsConfigOverridesCustom };
    const tdsArgs = {
      tf,
      vars,
      ...(h === undefined ? {} : { h }),
      integrator: wireIntegrator,
      ...(tdsConfigOverrides === undefined ? {} : { tdsConfigOverrides }),
    };

    const stream = new RunStream({
      sessionId,
      token,
      wsUrl: buildRunStreamWsUrl(),
      tdsArgs,
      maxRateHz: tdsConfig.maxRateHz,
      onStart: () => {
        // ``RunStream`` already populated the runs slice via
        // ``startRun`` — no extra work here. Kept as a hook so a future
        // analytics tap has a place to land.
        setTdsStarting(false);
      },
      onDone: () => {
        // RunStream marked the run done in the slice; cleanup the stream
        // handle so a stale instance doesn't dangle.
        streamRef.current?.dispose();
        streamRef.current = null;
      },
      onError: (err: RunStreamError) => {
        setTdsStarting(false);
        if (err.code === 'auth_failed') {
          // Token is stale; cascade-clears reopens TokenPasteModal via
          // the v0.1 path. No need to surface a separate toast.
          useAuthStore.getState().clearToken();
        } else if (err.code === 'run_not_found') {
          toast.warning(
            'Run no longer available on the substrate (it may have been restarted). Reset and re-run.',
          );
        } else if (err.code === 'buffer_evicted') {
          toast.warning(
            'Connection dropped too long; partial buffer retained. Reset and re-run to resume.',
          );
        } else {
          // protocol_error / worker_error / max_retries — surface as a
          // hard error toast. The runs slice was already marked errored
          // by RunStream, so the NumericalErrorBanner ALSO surfaces.
          toast.error('TDS error', { description: `${err.code}: ${err.reason}` });
        }
        streamRef.current?.dispose();
        streamRef.current = null;
      },
    });
    streamRef.current = stream;
    stream.start();
  };

  // ---- abort flow ---------------------------------------------------------

  const onAbort = () => {
    if (!sessionId) return;
    if (activeRun === null) return;
    setAborting(true);
    abortRun.mutate(sessionId, {
      onError: (err) => {
        setAborting(false);
        const detail =
          err instanceof ProblemDetailsError
            ? (err.detail ?? err.title ?? `HTTP ${err.status}`)
            : (err.message ?? 'Abort failed');
        toast.error('TDS error', { description: `Could not abort: ${detail}` });
      },
    });
  };

  // ---- reset flow ---------------------------------------------------------

  const onReset = () => {
    if (!sessionId) return;
    resetRun.mutate(sessionId, {
      onError: (err) => {
        const detail =
          err instanceof ProblemDetailsError
            ? (err.detail ?? err.title ?? `HTTP ${err.status}`)
            : (err.message ?? 'Reset failed');
        toast.error('TDS error', { description: `Could not reset: ${detail}` });
      },
    });
  };

  // ---- PF flow ------------------------------------------------------------

  const onClickPf = () => {
    if (!sessionId) return;
    runPflow.mutate(sessionId, {
      onSuccess: (data) => {
        if (data.converged) {
          toast.success(`PF converged in ${data.iterations} iterations.`);
        }
        // Non-convergence is a 200; ConvergenceErrorPanel reads from
        // the pflow slice and surfaces. No toast.
      },
      onError: (err) => {
        if (err instanceof ServerError) {
          // 5xx routes through pflow.error to RuntimeCrashModal already;
          // no toast (the modal is the surface).
          return;
        }
        if (err instanceof ProblemDetailsError) {
          const detail = err.detail ?? err.title ?? `HTTP ${err.status}`;
          const recoverViaReload = /reload/i.test(detail);
          if (recoverViaReload) {
            toast.error('Run PF failed', {
              description: detail,
              action: { label: 'Reload case + retry', onClick: onReset },
            });
          } else {
            toast.error('Run PF failed', { description: detail });
          }
        } else {
          toast.error('Run PF failed', {
            description: err.message ?? 'Run PF failed',
          });
        }
      },
    });
  };

  // ---- click dispatcher ---------------------------------------------------

  const onClickPrimary = () => {
    if (mode === 'pf') {
      onClickPf();
      return;
    }
    // TDS branch.
    if (isTdsTerminal) {
      onReset();
      return;
    }
    if (isTdsRunning) {
      onAbort();
      return;
    }
    void startTds();
  };

  // ---- label + state ------------------------------------------------------

  let primaryLabel: string;
  let primaryDisabled = false;
  let primaryShowSpinner = false;
  let primaryTestId = 'run-button';
  let primaryVariant: 'primary' | 'outline' | 'danger' = 'primary';

  if (mode === 'pf') {
    primaryTestId = 'run-pflow-button';
    if (isPfRunning) {
      primaryLabel = 'Running PF…';
      primaryDisabled = true;
      primaryShowSpinner = true;
    } else {
      primaryLabel = 'Run PF';
    }
  } else {
    primaryTestId = 'run-tds-button';
    if (isTdsTerminal) {
      primaryLabel = 'Reset run';
      primaryVariant = 'outline';
      primaryDisabled = resetRun.isPending;
    } else if (aborting || (isTdsRunning && abortRun.isPending)) {
      primaryLabel = 'Aborting…';
      primaryDisabled = true;
      primaryShowSpinner = true;
    } else if (isTdsRunning) {
      primaryLabel = 'Abort';
      primaryVariant = 'danger';
    } else if (tdsStarting || commitDisturbances.isPending) {
      primaryLabel = 'Streaming…';
      primaryDisabled = true;
      primaryShowSpinner = true;
    } else {
      primaryLabel = 'Run TDS';
    }
  }

  const allDisabled = primaryDisabled || disabledReason !== null;

  const primaryButton = (
    <Button
      type="button"
      variant={primaryVariant}
      size="md"
      disabled={allDisabled}
      onClick={onClickPrimary}
      data-testid={primaryTestId}
      aria-describedby={disabledReason ? 'run-button-disabled-reason' : undefined}
      className={cn('min-w-[120px]', className)}
    >
      {primaryShowSpinner ? (
        <>
          <Spinner />
          <span>{primaryLabel}</span>
        </>
      ) : (
        <span>{primaryLabel}</span>
      )}
    </Button>
  );

  // ---- mode selector ------------------------------------------------------

  const modeSelector = (
    <div
      role="radiogroup"
      aria-label="Run mode"
      data-testid="run-mode-selector"
      className={cn(
        'inline-flex overflow-hidden rounded-[var(--radius-md)]',
        'border-border border text-xs',
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'pf'}
        data-testid="run-mode-pf"
        // Disable mode-switching while a run is active so a mid-flight
        // change can't strand the TDS state.
        disabled={isPfRunning || isTdsRunning || tdsStarting}
        onClick={() => setManualMode('pf')}
        className={cn(
          'px-2 py-0.5 transition-colors',
          mode === 'pf'
            ? 'bg-primary/15 text-foreground'
            : 'text-muted-foreground hover:text-foreground',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        PF
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'tds'}
        data-testid="run-mode-tds"
        disabled={isPfRunning || isTdsRunning || tdsStarting}
        onClick={() => setManualMode('tds')}
        className={cn(
          'px-2 py-0.5 transition-colors',
          'border-border border-l',
          mode === 'tds'
            ? 'bg-primary/15 text-foreground'
            : 'text-muted-foreground hover:text-foreground',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        TDS
      </button>
    </div>
  );

  // ---- inline recovery affordance ----------------------------------------

  // The Run-readiness hook surfaces a recovery descriptor when one is
  // available (today: ``reload-case`` for PF after an EIG run). Reuse
  // the existing reset-run mutation handle — both wire to the same
  // ``POST /sessions/{id}/reload`` endpoint, so the user gets a clean
  // re-parse + cleared dae.
  const inlineRecovery =
    readiness.recovery?.kind === 'reload-case' ? (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onReset}
        disabled={resetRun.isPending}
        data-testid="run-button-recovery-reload"
      >
        {resetRun.isPending ? 'Reloading…' : readiness.recovery.label}
      </Button>
    ) : null;

  // ---- render -------------------------------------------------------------

  return (
    <div className="flex items-center gap-2">
      {disabledReason ? (
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="inline-block">
                {primaryButton}
              </span>
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent id="run-button-disabled-reason">{disabledReason}</TooltipContent>
            </TooltipPortal>
          </Tooltip>
        </TooltipProvider>
      ) : (
        primaryButton
      )}
      {inlineRecovery}
      {modeSelector}
    </div>
  );
}
