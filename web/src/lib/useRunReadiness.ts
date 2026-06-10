/**
 * useRunReadiness — central Run-button gating hook (v2.0 polish, Unit 4).
 *
 * Every "Run X" button in the app (PF, TDS, EIG, CPF, SE, Sweep) needs to
 * answer the same three questions:
 *
 *   1. Is the prerequisite state present? (case loaded, session live,
 *      PF converged when the routine consumes the PF result, ...).
 *   2. If not, *why* — so we can surface a tooltip instead of a silent
 *      grey button (R20 of the v2.0 plan: every disabled control must
 *      explain itself).
 *   3. Is there a one-click recovery path the user can take from the
 *      same surface (e.g. "Reload case" when EIG mutated the dae state)?
 *
 * This hook is the single source of truth for those three answers. All
 * Run buttons consume it and render a Tooltip + optional inline recovery
 * affordance based on the result.
 *
 * Reasons map (per the plan):
 *
 *   - "No case loaded."                                   — case.selection === null
 *   - "Connecting to substrate…"                          — sessionId === null
 *   - "Run PFlow first; <routine> requires a converged
 *      operating point."                                  — EIG/CPF/SE without PF
 *   - "Running EIG initialised the dynamic state; reload
 *      case to re-run PF."                                — PF after EIG
 *      → recoveryHint: { action: 'reload-case' }
 *   - "Sweep <id> in progress (<n>/<total>); wait or
 *      abort."                                            — any routine while sweep is running
 *   - "Generate measurements first."                      — SE without measurement set
 *
 * Plan-divergence: the plan also lists a "Case is dirty; commit edits
 * first" reason. Today there is no real "case dirty" flag wired to any
 * Run button (TDS auto-commits its disturbances on click; PF/EIG/CPF/SE
 * don't consume the disturbance list at all). That reason is left out
 * of the hook for now — when a future unit adds a real "uncommitted
 * topology edits" gate it can land here next to the other reasons.
 */
import type { ReactNode } from 'react';
import type { RecoveryDescriptor } from '@/lib/recovery';
import { useAnalyzeStore } from '@/store/analyze';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useSessionStore } from '@/store/session';
import { useSweepStore } from '@/store/sweep';
import { useRunsStore } from '@/store/runs';

/**
 * The set of routines that own a Run button. Each value matches the
 * ``data-testid`` family of the corresponding button so call-sites and
 * tests can refer to a single string.
 */
export type RunRoutine = 'pflow' | 'tds' | 'eig' | 'cpf' | 'se' | 'sweep';

/**
 * Recovery-action descriptor. The hook returns the descriptor (not
 * pre-rendered JSX) so the consuming component can choose whether to
 * surface it as an inline button, a toast action, or both — and so the
 * hook itself stays free of React-tree dependencies (queries, query
 * client, mutation refs).
 *
 * Unit 7 unifies this with the post-error recovery shape: ``RecoveryAction``
 * is now an alias of the shared ``RecoveryDescriptor`` (``@/lib/recovery``)
 * so readiness preconditions and ``ProblemDetailsError.recovery`` flow
 * through the SAME ``<RecoveryActionButton>`` switch. The readiness producer
 * uses the ``"reload-case"`` kind (clearing the EIG-induced dae mutation so
 * PF can re-run) and the readiness-only ``"open-pf"`` kind (the "Run PFlow
 * first" precondition); both are members of the shared union.
 */
export type RecoveryAction = RecoveryDescriptor;

export interface RunReadiness {
  /** True when the routine can be invoked right now. */
  ready: boolean;
  /**
   * Human-readable reason the routine can't run, or ``null`` when ready.
   * Used as the tooltip text on the disabled button. Wording matches
   * the plan's reasons map verbatim so the same string can be asserted
   * across consuming-component tests.
   */
  disabledReason: string | null;
  /**
   * Optional one-click recovery action descriptor. When present, the
   * consuming component should render an inline CTA (typically below
   * the disabled button) labelled with ``recovery.label`` that fires
   * the matching mutation when activated.
   */
  recovery: RecoveryAction | null;
  /**
   * Reserved for future use: a consumer-supplied recovery JSX node
   * (e.g. a Reload-case button bound to a mutation handle). Kept as
   * ``ReactNode`` so the hook signature matches the plan's contract;
   * today the consumer renders the recovery from ``recovery`` directly.
   */
  recoveryHint: ReactNode | null;
}

/**
 * Display label for a routine — used inside the "Run PFlow first; <X>
 * requires a converged operating point." sentence.
 */
function routineLabel(routine: RunRoutine): string {
  switch (routine) {
    case 'pflow':
      return 'PFlow';
    case 'tds':
      return 'TDS';
    case 'eig':
      return 'EIG';
    case 'cpf':
      return 'CPF';
    case 'se':
      return 'SE';
    case 'sweep':
      return 'Sweep';
  }
}

/** Routines whose result depends on a converged PF operating point. */
const PF_DEPENDENT: ReadonlySet<RunRoutine> = new Set(['eig', 'cpf', 'se']);

/**
 * Routines that require dynamic-model data (controllers / rotor models) to
 * run at all (R18, Unit 24). Time-domain simulation integrates the dynamic
 * DAE and eigenvalue analysis linearises it — neither is defined for a
 * static-only case. CPF and SE are static analyses (continuation power flow
 * and state estimation over the power-flow model), so they are deliberately
 * NOT gated here — gating them would wrongly block valid runs.
 */
const DYNAMIC_REQUIRED: ReadonlySet<RunRoutine> = new Set(['tds', 'eig']);

/**
 * Compute the readiness of a Run button.
 *
 * The hook subscribes to the minimum slice of each store it needs so
 * unrelated state changes don't trigger consumer re-renders. The
 * returned object's ``recovery`` and ``recoveryHint`` fields are
 * derived synchronously — no effects, no mutations — so the same
 * shape is observable from a render-only test (the
 * ``useRunReadiness.test.ts`` suite).
 */
export function useRunReadiness(routine: RunRoutine): RunReadiness {
  const selection = useCaseStore((s) => s.selection);
  const sessionId = useSessionStore((s) => s.sessionId);
  const pflowLastRun = usePflowStore((s) => s.lastRun);
  const eigResult = useAnalyzeStore((s) => s.eigResult);
  const seMeasurementsCount = useAnalyzeStore((s) => s.seMeasurementsCount);
  // A live/just-finished TDS run leaves the model in the dynamic-initialized
  // (dae) state until the user resets — see the post-TDS gate below.
  const activeRunId = useRunsStore((s) => s.activeRunId);
  const activeSweepId = useSweepStore((s) => s.activeSweepId);
  const sweeps = useSweepStore((s) => s.sweeps);
  // Store mirror of the topology query (kept in sync by `setTopology`), so the
  // readiness hook stays a pure store reader — no query side effects.
  const topology = useCaseStore((s) => s.topology);

  // Order matters: the most fundamental gate (no case) shadows every
  // subsequent reason, then session, then routine-specific
  // prerequisites. This mirrors how a user thinks about the workflow
  // — "you can't run anything without a case" is a more useful tooltip
  // than "Run PFlow first" when there's no case in the first place.

  if (selection === null) {
    return ready(false, 'No case loaded.', null);
  }
  if (sessionId === null) {
    return ready(false, 'Connecting to substrate…', null);
  }

  // Sweep-in-progress shadows every other run: the substrate holds a
  // session-scoped lock for the duration of the sweep, so any other
  // POST would 409. Surface the active sweep id + progress so the
  // user knows what they're waiting on.
  if (activeSweepId !== null) {
    const sweep = sweeps[activeSweepId];
    const progress = sweep === undefined ? '' : ` (${sweep.iterations.length}/${sweep.total})`;
    return ready(false, `Sweep ${activeSweepId} in progress${progress}; wait or abort.`, null);
  }

  // Dynamic-content prerequisite (R18): TDS/EIG need dynamic-model data —
  // either a synchronous-machine generator (GENROU/GENCLS), which carries the
  // rotor DAE states, OR a controller (exciter/governor/PSS) on top. A
  // GENCLS-only system IS dynamic, so don't gate it. Only fires once the
  // topology has resolved; while loading, fall through so the button isn't
  // flicker-disabled.
  if (DYNAMIC_REQUIRED.has(routine) && topology !== null) {
    const hasDynamicGenerator = (topology.generators ?? []).some(
      (g) => g.kind === 'GENROU' || g.kind === 'GENCLS',
    );
    const hasController = (topology.controllers ?? []).length > 0;
    if (!hasDynamicGenerator && !hasController) {
      return ready(
        false,
        `${routineLabel(routine)} requires dynamic-model data. Load a .dyr addfile (or add a GENROU/GENCLS generator) to enable.`,
        null,
      );
    }
  }

  // PF after EIG needs a reload — EIG.run() sets ``TDS.initialized=True``
  // on the dae, which makes a subsequent ``PFlow.run`` start from the
  // initialised dynamic state instead of the trim point. The substrate
  // surfaces this by 409-ing the next PF call with a "call /reload"
  // hint; the hook gates the button proactively so the user sees the
  // recovery affordance instead of having to click and read an error.
  if (routine === 'pflow' && eigResult !== null && eigResult.tds_initialized) {
    return ready(false, 'EIG initialised the dynamic state; reload case to re-run PF.', {
      kind: 'reload-case',
      label: 'Reload case',
    });
  }

  // After a TDS run the model is left in the dynamic-initialized (dae) state.
  // PF and the PF-dependent static routines (CPF / EIG / SE) fail against it
  // — the substrate 409s or 500s — so gate them until the user resets the run
  // ("Reset run" = POST /reload restores a clean operating point). TDS itself
  // re-initialises each run, so it is NOT gated. The grid still shows the
  // post-TDS operating point; this only blocks routines that would crash.
  if ((routine === 'pflow' || PF_DEPENDENT.has(routine)) && activeRunId !== null) {
    return ready(
      false,
      `Reset the run first; TDS left the model in a dynamic state, so ${routineLabel(
        routine,
      )} needs a clean operating point.`,
      { kind: 'reload-case', label: 'Reset run' },
    );
  }

  // Routines that consume the PF operating point (EIG / CPF / SE)
  // require a converged PF result first. The substrate would 409 the
  // call otherwise; gate the button so the user sees the prerequisite
  // before clicking.
  if (PF_DEPENDENT.has(routine)) {
    if (pflowLastRun === null || !pflowLastRun.converged) {
      return ready(
        false,
        `Run PFlow first; ${routineLabel(routine)} requires a converged operating point.`,
        { kind: 'open-pf', label: 'Open PF view' },
      );
    }
  }

  // SE has a second prerequisite: a measurement set must exist (the
  // user clicked Generate Measurements). When the count is zero or
  // null, surface that specific reason rather than the generic
  // PF-required one.
  if (routine === 'se') {
    if (seMeasurementsCount === null || seMeasurementsCount === 0) {
      return ready(false, 'Generate measurements first.', null);
    }
  }

  return ready(true, null, null);
}

/** Helper: build the readiness record. */
function ready(
  isReady: boolean,
  reason: string | null,
  recovery: RecoveryAction | null,
): RunReadiness {
  return {
    ready: isReady,
    disabledReason: reason,
    recovery,
    recoveryHint: null,
  };
}
