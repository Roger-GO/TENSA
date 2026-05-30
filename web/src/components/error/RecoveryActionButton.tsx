/**
 * `<RecoveryActionButton>` (v3.1 Phase 3, Unit 7).
 *
 * The single routing primitive for a recovery call-to-action. Switches on
 * `recovery.kind` and fires the corresponding side effect via the EXISTING
 * store / query actions — never inline imperative logic. The button text is
 * the descriptor's `label`.
 *
 * Routing table (`recovery.kind` → side effect):
 *
 * - `reload-case` / `SetupFailed` → `useReloadCase().mutate(sessionId)`.
 * - `run-pflow` / `open-pf` → select the PF run mode (`useRunModeStore`)
 *   AND surface the Analyze panel's PF sub-mode (`useAnalyzeStore`).
 * - `retry` → re-run the failed mutation. The variables live on the
 *   `JobRecord.request_summary` (Unit 6); the caller wires the actual
 *   re-run as the `onRetry` callback (the Activity panel knows which
 *   mutation produced the failed job). With no `onRetry` the button is a
 *   no-op affordance.
 * - `add-measurements` → open the SE measurements affordance
 *   (`useAnalyzeStore().setSubMode('se')` + reveal the analysis drawer).
 * - `load-case` → focus the case picker (reveal the left sidebar where the
 *   workspace file picker lives).
 * - `wait-for-job` / `wait-for-sweep` → focus / open the Activity panel for
 *   the in-flight job (`useLayoutStore`); select the job when its id is
 *   known.
 * - `none` → render nothing (no CTA), same as an absent recovery.
 * - UNKNOWN kind (forward-compat) → render `recovery.label` as PLAIN TEXT
 *   with no side effect.
 *
 * Tokens: the active button is danger-tokened via `<Button variant="danger">`
 * (`bg-danger` / `text-danger-foreground`). NEVER `destructive`.
 */
import { Button } from '@/components/ui/button';
import { useReloadCase } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { useRunModeStore } from '@/store/runMode';
import { useAnalyzeStore } from '@/store/analyze';
import { useLayoutStore } from '@/store/layout';
import { isKnownRecoveryKind, type RecoveryDescriptor } from '@/lib/recovery';

export interface RecoveryActionButtonProps {
  /** The recovery descriptor to route. `null` renders nothing. */
  recovery: RecoveryDescriptor | null;
  /**
   * Re-run callback for the `retry` kind. The Activity panel / calling
   * surface wires this from the failed `JobRecord.request_summary` (Unit 6).
   * Absent → the `retry` button renders but is a no-op.
   */
  onRetry?: () => void;
  /**
   * In-flight job id for the `wait-for-job` / `wait-for-sweep` kinds. When
   * present, activating the recovery selects that job in the Activity panel.
   */
  jobId?: string;
  /** Optional className passthrough for layout. */
  className?: string;
  /** data-testid override; defaults to `recovery-action`. */
  testId?: string;
}

/**
 * Build the side-effect handler + pending flag for a known recovery kind.
 * Subscribes to the minimum store / query slices each kind needs. Returns
 * `null` for `none` (no CTA) — the component renders nothing.
 *
 * All hooks are called unconditionally (React rules-of-hooks); the switch
 * only selects WHICH precomputed handler to return. This keeps the routing
 * declarative: no kind reaches imperatively into another store.
 */
function useRecoveryHandler(
  recovery: RecoveryDescriptor | null,
  onRetry: (() => void) | undefined,
  jobId: string | undefined,
): { onActivate: () => void; pending: boolean } | null {
  const reloadCase = useReloadCase();
  const sessionId = useSessionStore((s) => s.sessionId);
  const setActiveRoutine = useRunModeStore((s) => s.setActiveRoutine);
  const setSubMode = useAnalyzeStore((s) => s.setSubMode);
  const setActiveBottomDrawerTab = useLayoutStore((s) => s.setActiveBottomDrawerTab);
  const setBottomDrawerCollapsed = useLayoutStore((s) => s.setBottomDrawerCollapsed);
  const setLeftSidebarCollapsed = useLayoutStore((s) => s.setLeftSidebarCollapsed);
  const setActivityPanelCollapsed = useLayoutStore((s) => s.setActivityPanelCollapsed);
  const setActivityPanelTab = useLayoutStore((s) => s.setActivityPanelTab);
  const setSelectedJobId = useLayoutStore((s) => s.setSelectedJobId);

  if (recovery === null) return null;
  if (!isKnownRecoveryKind(recovery.kind)) return null;

  switch (recovery.kind) {
    case 'none':
      return null;

    case 'reload-case':
      return {
        onActivate: () => {
          if (sessionId !== null) reloadCase.mutate(sessionId);
        },
        pending: reloadCase.isPending,
      };

    case 'run-pflow':
    case 'open-pf':
      // Select the PF run mode AND surface the Analyze panel's PF sub-mode
      // so the user lands on the prerequisite routine.
      return {
        onActivate: () => {
          setActiveRoutine('pflow');
          setSubMode('pflow');
        },
        pending: false,
      };

    case 'retry':
      return {
        onActivate: () => {
          onRetry?.();
        },
        pending: false,
      };

    case 'add-measurements':
      // Open the SE measurements affordance: switch the Analyze panel to the
      // SE sub-mode and reveal the bottom drawer's analysis tab where the
      // "Generate measurements" control lives.
      return {
        onActivate: () => {
          setSubMode('se');
          setActiveBottomDrawerTab('analysis');
          setBottomDrawerCollapsed(false);
        },
        pending: false,
      };

    case 'load-case':
      // Focus the case picker — reveal the left sidebar where the workspace
      // file picker lives.
      return {
        onActivate: () => {
          setLeftSidebarCollapsed(false);
        },
        pending: false,
      };

    case 'wait-for-job':
    case 'wait-for-sweep':
      // Focus / open the Activity panel for the in-flight job.
      return {
        onActivate: () => {
          setActivityPanelCollapsed(false);
          setActivityPanelTab('active');
          if (jobId !== undefined) setSelectedJobId(jobId);
        },
        pending: false,
      };
  }
}

export function RecoveryActionButton({
  recovery,
  onRetry,
  jobId,
  className,
  testId = 'recovery-action',
}: RecoveryActionButtonProps) {
  const handler = useRecoveryHandler(recovery, onRetry, jobId);

  // `none` and absent recovery render nothing.
  if (recovery === null || recovery.kind === 'none') return null;

  // Forward-compat: a kind this build predates renders the label as PLAIN
  // TEXT with no side effect (no button, no click target).
  if (!isKnownRecoveryKind(recovery.kind) || handler === null) {
    return (
      <span
        data-testid={`${testId}-text`}
        className={className ?? 'text-muted-foreground text-xs'}
      >
        {recovery.label}
      </span>
    );
  }

  return (
    <Button
      type="button"
      variant="danger"
      size="sm"
      className={className}
      onClick={handler.onActivate}
      disabled={handler.pending}
      data-testid={testId}
    >
      {recovery.label}
    </Button>
  );
}
