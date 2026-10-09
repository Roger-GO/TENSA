import { useEffect, useRef, useState } from 'react';
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
  useRefreshTopology,
  useReloadCase,
  loadOperatingPointIntoStore,
} from '@/api/queries';
import { ProblemDetailsError } from '@/api/client';
import { usePflowRunAction } from '@/lib/usePflowRunAction';
import {
  EDITS_DISCARDED,
  useReloadDiscardsEdits,
  useResetRunAction,
} from '@/lib/useResetRunAction';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { usePflowStore } from '@/store/pflow';
import { disturbanceTime, useDisturbanceStore } from '@/store/disturbance';
import { useLayoutStore } from '@/store/layout';
import { useRunsStore } from '@/store/runs';
import { MAX_TDS_DAE_VARS, useUiStore } from '@/store/ui';
import { RunStream } from '@/streaming/RunStream';
import type { RunStreamError, VarGroup } from '@/streaming/RunStream';
import { buildRunStreamWsUrl } from '@/streaming/wsUrl';
import { useRunReadiness, type RunRoutine } from '@/lib/useRunReadiness';
import { useRequestedRun } from '@/lib/useRequestedRun';
import { reportAbortError } from '@/lib/abortRun';
import { describeError } from '@/lib/describeError';
import { toast } from '@/lib/toast';
import { unitBasesOf } from '@/lib/units';
import { describeScenario } from '@/lib/runLabel';
import { runDaeVars, summariseResults } from '@/lib/tdsControllers';
import { stemOf } from '@/lib/paths';
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
 *   fires ``POST /reload`` and releases the run; back to Idle. The run keeps
 *   its results and stays in History as an earlier run, so a second run can be
 *   compared with it.
 *
 * Error routing (per the v0.2 plan's R8 taxonomy):
 *
 * - WS ``run_not_found`` (close 4404) → non-modal warning toast inviting
 *   the user to Reset and re-run.
 * - WS ``buffer_evicted`` (a resume past the server's buffer) and
 *   ``client_lagged`` (this tab fell behind a live run): both are a resync
 *   that closes the stream, and each gets a non-modal warning toast worded for
 *   its cause, since only one of them is a dropped connection.
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
 * - Disturbances on a System a prior run already committed (the substrate
 *   would 409) → reload the case first, then commit. The topology's
 *   ``committed`` state triggers it up front (a finished TDS run re-reads
 *   the topology for it); a 409 on the commit is the fallback when the
 *   topology still lags the substrate, as it does after a run that ended in
 *   an error.
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

  const reloadDiscardsEdits = useReloadDiscardsEdits();

  const commitDisturbances = useCommitDisturbances();
  const reloadCase = useReloadCase();
  const refreshTopology = useRefreshTopology();
  const abortRun = useAbortRun();
  const resetRun = useResetRunAction({ errorTitle: 'TDS error' });

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
  // hook subscribes to the case + session stores plus the
  // routine-specific prerequisites (sweep-in-progress for any routine,
  // EIG-mutated dae for PF). We pass the active mode so the same
  // button surface reuses the right gate as the user toggles between
  // PF and TDS.
  const readinessRoutine: RunRoutine = mode === 'pf' ? 'pflow' : 'tds';
  const readiness = useRunReadiness(readinessRoutine);
  const disabledReason = readiness.disabledReason;

  // ---- TDS start flow -----------------------------------------------------

  const startTds = async () => {
    if (!sessionId) return;
    setTdsStarting(true);

    // Step 1: commit disturbances if non-empty. The substrate's
    // ``AddDisturbancesRequest`` has ``min_length=1`` so an empty list
    // would 422 — skip the call entirely for free-evolution runs.
    if (disturbances.length > 0) {
      const reportCommitError = (err: unknown) => {
        setTdsStarting(false);
        const detail = describeError(err);
        if (err instanceof ProblemDetailsError) {
          toast.error('TDS error', {
            description:
              err.status === 422
                ? `Disturbance rejected: ${detail}. Fix the failing row and retry.`
                : `Could not commit disturbances: ${detail}`,
          });
        } else {
          toast.error('TDS error', { description: detail });
        }
      };
      const commit = () =>
        commitDisturbances.mutateAsync({
          sessionId,
          disturbances: disturbances.map((d) => d.spec),
        });
      // The substrate refuses disturbances once a prior run has committed
      // setup(), and its recovery is reload-case (re-parse to pre-setup,
      // which drops the committed System). Do it for the user. Without
      // this, the natural "run PF → add fault → run TDS" flow dead-ends.
      const reloadThenCommit = async () => {
        const why = 'A previous run locked the system — reloading to apply the disturbances.';
        if (reloadDiscardsEdits) {
          // This run is of the case as its file has it, which is not what the
          // user was looking at: say so, and how to keep the edits next time.
          toast.warning('Reloading case', {
            description: `${why} ${EDITS_DISCARDED}`,
            duration: 10000,
          });
        } else {
          toast.info('Reloading case', { description: why });
        }
        await reloadCase.mutateAsync(sessionId);
        await commit();
      };
      try {
        if (useCaseStore.getState().topology?.state === 'committed') {
          // The topology already says setup() ran, so the commit would be
          // refused with a 409 (and leave a failed job in the history).
          // Reload first instead of sending a request bound to fail.
          await reloadThenCommit();
        } else {
          try {
            await commit();
          } catch (err) {
            // The topology can lag the substrate (a routine that commits
            // setup() without refreshing it), so a 409 is still possible
            // here. Recover the same way, once.
            if (!(err instanceof ProblemDetailsError && err.status === 409)) throw err;
            await reloadThenCommit();
          }
        }
      } catch (err) {
        reportCommitError(err);
        return;
      }
    }

    // A run that schedules nothing and whose case defines no event of its own
    // (a line trip in the file, or one a bundle or snapshot replayed) has
    // nothing to disturb it. Say so before the user wonders what is wrong, and
    // where the fault goes. With events from the case the run does move, and
    // the sidebar lists them, so there is nothing to warn about.
    if (
      disturbances.length === 0 &&
      (useCaseStore.getState().topology?.events ?? []).length === 0
    ) {
      toast.info('No fault is set', {
        description:
          'Neither the sidebar nor the case schedules a fault, a trip or a parameter change, so nothing disturbs this run. Add a fault under Disturbances in the left sidebar (Project tab) and run again.',
        duration: 8000,
      });
    }

    // Step 2: open the WebSocket. Cleanly tear down any prior stream
    // first (defensive — a stale handle would race the new one).
    streamRef.current?.dispose();
    streamRef.current = null;

    const tf = defaultTf ?? tdsConfig.tf;
    const vars = defaultVars ?? tdsConfig.vars;
    // ``h`` is special: ``null`` from the store means "use the ANDES
    // default step" → omit from the wire payload entirely. The
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
    // The frequency controllers set in the TDS tab go with the run, and so do
    // the variables that show each one at work on its device (the command it
    // received, its current, its state of charge), after the user's own picks.
    const controllers = tdsConfig.controllers;
    const daeVars = runDaeVars(tdsConfig.daeVars, controllers, MAX_TDS_DAE_VARS);
    const tdsArgs = {
      tf,
      vars,
      ...(daeVars.length === 0 ? {} : { daeVars }),
      ...(controllers.length === 0 ? {} : { controllers: controllers.map((c) => c.spec) }),
      ...(h === undefined ? {} : { h }),
      integrator: wireIntegrator,
      ...(tdsConfigOverrides === undefined ? {} : { tdsConfigOverrides }),
    };

    const scenario = describeScenario(disturbances.map((d) => d.spec));
    // When the system is first disturbed, by what is scheduled here or by an
    // event of the case's own: the response metrics offer to start there.
    const eventTimes = [
      ...disturbances.map((d) => disturbanceTime(d.spec)),
      ...(useCaseStore.getState().topology?.events ?? []).map((e) => e.t),
    ].filter((t) => Number.isFinite(t) && t >= 0);
    const disturbedAt = eventTimes.length === 0 ? undefined : Math.min(...eventTimes);
    const casePath = useCaseStore.getState().selection?.primaryPath ?? null;
    const stream = new RunStream({
      sessionId,
      wsUrl: buildRunStreamWsUrl(),
      tdsArgs,
      // The run keeps the case's bases (rated kV, system frequency) so its
      // values stay readable in kV and Hz after another case is loaded.
      bases: unitBasesOf(useCaseStore.getState().topology),
      // What the run does to the system, so the legend and the history can
      // name it ("TDS #3 - fault bus 7") and not show its id.
      ...(scenario === undefined ? {} : { scenario }),
      ...(disturbedAt === undefined ? {} : { disturbedAt }),
      // Which case the run is of, so an export of it says so after another
      // case is opened. A system with no file behind it has no name to keep.
      ...(casePath === null ? {} : { caseName: stemOf(casePath) }),
      maxRateHz: tdsConfig.maxRateHz,
      onStart: () => {
        // ``RunStream`` already populated the runs slice via
        // ``startRun``. What is left is to show the run where it is plotted,
        // so the user does not have to find the Plot tab while it streams.
        // Like the Run menu's commands: a collapsed drawer stays collapsed
        // and gets the unread dot instead.
        setTdsStarting(false);
        const layout = useLayoutStore.getState();
        layout.setActiveBottomDrawerTab('analysis');
        layout.setActiveAnalysisSubTab('plot');
        if (layout.bottomDrawerCollapsed) layout.setDrawerHasUnreadResults(true);
      },
      onDone: (event) => {
        // RunStream marked the run done in the slice; cleanup the stream
        // handle so a stale instance doesn't dangle.
        streamRef.current?.dispose();
        streamRef.current = null;
        // What the run's controllers did: kept beside them in the TDS tab,
        // and said once here, since the plot is what is on screen now. Only
        // while the list is still the one the run was started with.
        if (
          event.controllers !== undefined &&
          useUiStore.getState().tdsConfig.controllers === controllers
        ) {
          useUiStore.getState().setTdsControllerResults(event.controllers);
          toast.info('Frequency control', {
            description: `${summariseResults(event.controllers)} Under ANDES variables, the plot has each device's Pext (the power it was told to add, per unit) and current. The Messages tab says the same in words.`,
            duration: 10000,
          });
        }
        // Surface the post-TDS operating point in the data grid. TDS never
        // writes usePflowStore.lastRun, so without this the Buses grid sits
        // empty after a TDS-only run. Best-effort, read-only.
        //
        // The run committed setup() on the substrate but a stream returns no
        // topology, so the cached one still says pre-setup. Read it again so
        // a run started without a reload in between (one dropped from the
        // history) reloads before it commits instead of being refused. Not
        // at stream_start: the run holds the session until it ends, and a
        // read in the meantime is refused as busy. Nor beside the operating
        // point: that read holds the session too, and nothing retries a
        // refused one, so the topology waits for it.
        void loadOperatingPointIntoStore(sessionId).then(() => refreshTopology(sessionId));
      },
      onError: (err: RunStreamError) => {
        setTdsStarting(false);
        // No topology read here, unlike onDone: a dropped connection leaves
        // the run holding the session. Reset run, or the 409 fallback above,
        // covers a run that failed after committing setup().
        if (err.code === 'run_not_found') {
          toast.warning(
            'Run no longer available on the substrate (it may have been restarted). Reset and re-run.',
          );
        } else if (err.code === 'buffer_evicted') {
          toast.warning(
            'Connection dropped too long; partial buffer retained. Reset and re-run to resume.',
          );
        } else if (err.code === 'client_lagged') {
          // The connection never dropped: this tab read the stream more slowly
          // than the run produced it, and the server stopped sending.
          toast.warning(
            'This tab fell too far behind the run and missed frames, so the plot is incomplete. Reset and re-run for the whole stream.',
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
        reportAbortError(err);
      },
    });
  };

  // ---- reset flow ---------------------------------------------------------

  // The reload, and the toasts that say what became of the run and of the edits
  // (`useResetRunAction`, which the tables' Reset run shares).
  const onReset = resetRun.reset;

  // ---- PF flow ------------------------------------------------------------

  const onClickPf = usePflowRunAction(onReset);

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

  // ---- a run asked for by a command ---------------------------------------

  // "Run power flow (PF)" and "Run time-domain simulation (TDS)" in the Run
  // menu and the palette: the button goes to that mode and the run starts as
  // by a click on it. The command has checked that the routine can run; what
  // only this button knows (a run under way, a finished run that holds the
  // system) is said here.
  useRequestedRun(['pflow', 'tds'], (routine) => {
    if (isPfRunning || isTdsRunning || tdsStarting) {
      toast.info('A run is already in progress', {
        description: 'Wait for it to finish, or stop it with the Run button, and ask again.',
      });
      return;
    }
    if (routine === 'pflow') {
      setManualMode('pf');
      onClickPf();
      return;
    }
    setManualMode('tds');
    if (isTdsTerminal) {
      toast.info('Reset the run first', {
        description:
          'The last time-domain run still holds the system. Reset run, on the Run button, reloads the case so that it can be run again; the results of that run stay in History.',
        duration: 10000,
        action: { label: 'Reset run', onClick: onReset },
      });
      return;
    }
    void startTds();
  });

  // ---- label + state ------------------------------------------------------

  let primaryLabel: string;
  let primaryDisabled = false;
  let primaryShowSpinner = false;
  let primaryTestId = 'run-button';
  let primaryVariant: 'primary' | 'outline' | 'danger' = 'primary';
  let primaryTitle: string | undefined;

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
      primaryTitle =
        "Reload the case so it can be run again. This run's results stay in History, where you can compare them with the next run or delete them. The disturbances stay in the list." +
        (reloadDiscardsEdits
          ? ' The elements you added, changed or deleted since the case was opened do not: the reload reads the case from its file again. Save the system first to keep them.'
          : '');
      primaryDisabled = resetRun.isPending;
    } else if (
      aborting ||
      (isTdsRunning && (abortRun.isPending || (activeRun?.abortedLocally ?? false)))
    ) {
      // An abort sent from elsewhere (Esc) sets ``abortedLocally`` too, so the
      // button says so whichever of them asked.
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
      title={primaryTitle}
      data-testid={primaryTestId}
      aria-describedby={disabledReason ? 'run-button-disabled-reason-text' : undefined}
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
        title="Power flow: solve the steady state of the case"
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
        title="Time-domain simulation: step the case through time, applying the faults set under Disturbances"
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
      {/* The tooltip above only exists while it is open, so the reason is also
          kept in the page as text the button's aria-describedby can reach. */}
      {disabledReason ? (
        <span id="run-button-disabled-reason-text" className="sr-only">
          {disabledReason}
        </span>
      ) : null}
      {inlineRecovery}
      {modeSelector}
    </div>
  );
}
