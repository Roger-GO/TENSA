import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  useAbortRun,
  useCommitDisturbances,
  useResetRun,
  useRunPflow,
} from '@/api/queries';
import { ProblemDetailsError, ServerError } from '@/api/client';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useAuthStore } from '@/store/auth';
import { usePflowStore } from '@/store/pflow';
import { useDisturbanceStore } from '@/store/disturbance';
import { useRunsStore } from '@/store/runs';
import { useUiStore } from '@/store/ui';
import { RunStream } from '@/streaming/RunStream';
import type { RunStreamError, VarGroup } from '@/streaming/RunStream';
import { buildRunStreamWsUrl } from '@/streaming/wsUrl';
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

/** Toast message kinds the button surfaces inline above the dock. */
type Toast =
  | { kind: 'pf-success'; message: string }
  | { kind: 'pf-error'; detail: string; recoverViaReload: boolean }
  | { kind: 'tds-warning'; message: string }
  | { kind: 'tds-error'; detail: string };

const TOAST_AUTO_DISMISS_MS = 4000;

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

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="10"
      height="10"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M4 4 L12 12 M12 4 L4 12" />
    </svg>
  );
}

export function RunButton({
  className,
  defaultVars,
  defaultTf,
  defaultH,
}: RunButtonProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const selection = useCaseStore((s) => s.selection);
  const token = useAuthStore((s) => s.token);
  const isPfRunning = usePflowStore((s) => s.isRunning);
  const disturbances = useDisturbanceStore((s) => s.disturbances);
  // TDS args are owned by ``TdsConfigPanel`` (Unit 8) and live in
  // ``useUiStore``. Props remain as test-only overrides.
  const tdsConfig = useUiStore((s) => s.tdsConfig);

  // Active-run handle (if any) — drives the Reset / Abort label switch.
  const activeRunId = useRunsStore((s) => s.activeRunId);
  const activeRun = useRunsStore((s) =>
    activeRunId === null ? null : s.runs[activeRunId] ?? null,
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

  // Toast slot. One at a time keeps the top-bar uncluttered; new toasts
  // replace the previous one rather than stacking.
  const [toast, setToast] = useState<Toast | null>(null);
  useEffect(() => {
    if (toast === null) return;
    if (toast.kind === 'pf-error' || toast.kind === 'tds-error') return;
    const id = setTimeout(() => setToast(null), TOAST_AUTO_DISMISS_MS);
    return () => clearTimeout(id);
  }, [toast]);

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
    (activeRun.state === 'done' ||
      activeRun.state === 'error' ||
      activeRun.state === 'aborted');
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

  const disabledReason = useMemo<string | null>(() => {
    if (!selection) return 'Load a case first.';
    if (!sessionId) return 'Connecting to substrate…';
    if (!token) return 'Sign in to run.';
    return null;
  }, [selection, sessionId, token]);

  // ---- TDS start flow -----------------------------------------------------

  const startTds = async () => {
    if (!sessionId || !token) return;
    setTdsStarting(true);
    setToast(null);

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
          setToast({
            kind: 'tds-error',
            detail:
              err.status === 422
                ? `Disturbance rejected: ${detail}. Fix the failing row and retry.`
                : `Could not commit disturbances: ${detail}`,
          });
        } else {
          setToast({
            kind: 'tds-error',
            detail: err instanceof Error ? err.message : 'Could not commit disturbances.',
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
    const h = defaultH !== undefined ? defaultH : tdsConfig.h ?? undefined;
    const tdsArgs = h === undefined ? { tf, vars } : { tf, h, vars };

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
          setToast({
            kind: 'tds-warning',
            message:
              'Run no longer available on the substrate (it may have been restarted). Reset and re-run.',
          });
        } else if (err.code === 'buffer_evicted') {
          setToast({
            kind: 'tds-warning',
            message:
              'Connection dropped too long; partial buffer retained. Reset and re-run to resume.',
          });
        } else {
          // protocol_error / worker_error / max_retries — surface as a
          // hard error toast. The runs slice was already marked errored
          // by RunStream, so the NumericalErrorBanner ALSO surfaces.
          setToast({
            kind: 'tds-error',
            detail: `${err.code}: ${err.reason}`,
          });
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
            : err.message ?? 'Abort failed';
        setToast({ kind: 'tds-error', detail: `Could not abort: ${detail}` });
      },
    });
  };

  // ---- reset flow ---------------------------------------------------------

  const onReset = () => {
    if (!sessionId) return;
    setToast(null);
    resetRun.mutate(sessionId, {
      onError: (err) => {
        const detail =
          err instanceof ProblemDetailsError
            ? (err.detail ?? err.title ?? `HTTP ${err.status}`)
            : err.message ?? 'Reset failed';
        setToast({ kind: 'tds-error', detail: `Could not reset: ${detail}` });
      },
    });
  };

  // ---- PF flow ------------------------------------------------------------

  const onClickPf = () => {
    if (!sessionId) return;
    setToast(null);
    runPflow.mutate(sessionId, {
      onSuccess: (data) => {
        if (data.converged) {
          setToast({
            kind: 'pf-success',
            message: `PF converged in ${data.iterations} iterations.`,
          });
        } else {
          // Non-convergence is a 200; ConvergenceErrorPanel reads from
          // the pflow slice and surfaces. No toast.
          setToast(null);
        }
      },
      onError: (err) => {
        if (err instanceof ServerError) {
          // 5xx routes through pflow.error to RuntimeCrashModal already;
          // no inline toast (the modal is the surface).
          return;
        }
        if (err instanceof ProblemDetailsError) {
          const detail = err.detail ?? err.title ?? `HTTP ${err.status}`;
          const recoverViaReload = /reload/i.test(detail);
          setToast({ kind: 'pf-error', detail, recoverViaReload });
        } else {
          setToast({ kind: 'pf-error', detail: err.message ?? 'Run PF failed', recoverViaReload: false });
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

  // ---- toasts -------------------------------------------------------------

  const toastBlock = toast ? (
    <div
      role={toast.kind === 'pf-success' ? 'status' : 'alert'}
      data-testid={
        toast.kind === 'pf-success'
          ? 'pflow-success-toast'
          : toast.kind === 'pf-error'
            ? 'pflow-error-toast'
            : toast.kind === 'tds-warning'
              ? 'tds-warning-toast'
              : 'tds-error-toast'
      }
      className={cn(
        'fixed top-14 right-4 z-50 max-w-md',
        toast.kind === 'pf-success'
          ? 'border-success/30 bg-success/10'
          : toast.kind === 'tds-warning'
            ? 'border-warning/40 bg-warning/10'
            : 'border-destructive/40 bg-destructive/10',
        'text-foreground rounded-[var(--radius-md)] border px-3 py-2 shadow-md',
        'flex flex-col gap-2 text-sm',
      )}
    >
      <div className="flex items-start gap-2">
        <span className="font-medium">
          {toast.kind === 'pf-success'
            ? 'Power flow'
            : toast.kind === 'pf-error'
              ? 'Run PF failed'
              : toast.kind === 'tds-warning'
                ? 'TDS streaming'
                : 'TDS error'}
        </span>
        <button
          type="button"
          onClick={() => setToast(null)}
          aria-label="Dismiss"
          className={cn(
            'text-muted-foreground hover:text-foreground ml-auto',
            'inline-flex h-5 w-5 items-center justify-center rounded',
            'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          )}
        >
          <CloseIcon />
        </button>
      </div>
      <p className="text-foreground text-xs leading-snug">
        {toast.kind === 'pf-success'
          ? toast.message
          : toast.kind === 'tds-warning'
            ? toast.message
            : toast.detail}
      </p>
      {toast.kind === 'pf-error' && toast.recoverViaReload ? (
        <Button
          type="button"
          size="sm"
          variant="primary"
          onClick={onReset}
          disabled={resetRun.isPending}
          className="self-end"
        >
          {resetRun.isPending ? 'Reloading…' : 'Reload case + retry'}
        </Button>
      ) : null}
    </div>
  ) : null;

  // ---- render -------------------------------------------------------------

  const buttonGroup = (
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
      {modeSelector}
    </div>
  );

  return (
    <>
      {buttonGroup}
      {toastBlock}
    </>
  );
}
