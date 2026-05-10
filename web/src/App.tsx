import { useEffect, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from '@/components/shell/AppShell';
import { TokenPasteModal } from '@/components/auth/TokenPasteModal';
import { CaseNav } from '@/components/case/CaseNav';
import { ElementInspector } from '@/components/inspector/ElementInspector';
import { ResultsTable } from '@/components/inspector/ResultsTable';
// v0.2 RunButton replaces the v0.1 PF-only one — handles BOTH PF and TDS,
// branches on a UI mode toggle that defaults to TDS when the disturbance
// editor has any disturbances. The v0.1 RunButton file is kept untouched
// so its tests + paths still pass; this top-level mount just doesn't
// reference it any more.
import { RunButton } from '@/components/tds/RunButton';
import { RunStatusBadge } from '@/components/tds/RunStatusBadge';
import { NumericalErrorBanner } from '@/components/tds/NumericalErrorBanner';
import { AnalyzePanel } from '@/components/analyze/AnalyzePanel';
import { DisturbancePanel } from '@/components/disturbance/DisturbancePanel';
import { TimeSeriesPlot } from '@/components/plots/TimeSeriesPlot';
import { ScrubControl } from '@/components/plots/ScrubControl';
import { VariableTreePicker } from '@/components/plots/VariableTreePicker';
import { PanelPickerTabs } from '@/components/shell/PanelPickerTabs';
import { HideLabelsToggle } from '@/components/pflow/HideLabelsToggle';
import { ConvergenceErrorPanel } from '@/components/pflow/ConvergenceErrorPanel';
import { RuntimeCrashModal } from '@/components/pflow/RuntimeCrashModal';
import { AddElementPanel } from '@/components/elements/AddElementPanel';
import { WorkspaceMenu } from '@/components/shell/WorkspaceMenu';
import { EditMenu } from '@/components/shell/EditMenu';
import { RunMenu } from '@/components/shell/RunMenu';
import { ExportMenu } from '@/components/shell/ExportMenu';
import { makeQueryClient, wireGlobalErrorRecovery } from '@/api/queries';
import { useSessionRecovery } from '@/api/useSessionRecovery';
import { useSldFrameOverlay } from '@/components/sld/overlay';
import { RecoveryBadge } from '@/components/shell/RecoveryBadge';
import { setTokenGetter } from '@/api/client';
import { getAuthToken } from '@/store';
import { useUiStore } from '@/store/ui';
import { useRunsStore } from '@/store/runs';
import { cn } from '@/lib/cn';

// Wire the API client's token-getter to the auth store. This runs once at
// module load (the App.tsx import is the entry point); `getAuthToken`
// reads from the Zustand store via `getState()` so it doesn't need a
// React context.
setTokenGetter(getAuthToken);

/**
 * Root component. Wraps the AppShell with the cross-cutting providers
 * (QueryClientProvider + global 401 cascade) and assembles the unit-9
 * shell composition: top bar with the run-PF + label-toggle controls,
 * left rail with case nav, right dock with inspector + results +
 * convergence-error overlay, and modals (TokenPasteModal +
 * RuntimeCrashModal).
 *
 * Error-surface routing (R8 → R18):
 *
 * - Parse error (load failed) → ParseErrorBanner inside CaseNav.
 * - Solver non-convergence → ConvergenceErrorPanel as dock overlay.
 * - Runtime crash (5xx) → RuntimeCrashModal as the one allowed
 *   non-destructive modal.
 *
 * v0.2 panel router (Unit 8): the right-dock top region cycles between
 * Inspector / DisturbancePanel / TimeSeriesPlot / TdsConfigPanel via the
 * PanelPickerTabs. The active panel is read from ``useUiStore``. The
 * App also runs one smart auto-switch — when a TDS run starts, switch
 * to the Plot panel so the user sees frames stream in.
 */
function AppInner({ children }: { children: React.ReactNode }) {
  // Top-level recovery driver — must live INSIDE QueryClientProvider so
  // ``useCreateSession`` / ``useLoadCase`` can subscribe to the cache.
  // Mounted once for the lifetime of the tab; survives the picker
  // unmount that would otherwise kill the recovery cycle once a case is
  // loaded (v0.1.y Unit 5 bug fix).
  useSessionRecovery();
  // v0.2 Unit 5: SINGLE rAF loop driving the SLD streaming overlay.
  // Mounted once at the App root so all BusNodes share one tick source
  // (avoids N-rAF-loops-for-N-buses at NPCC scale). The hook is a
  // no-op when no run is active.
  useSldFrameOverlay();
  useTdsAutoSwitchToPlot();
  return <>{children}</>;
}

/**
 * One-shot auto-switch: when a fresh TDS run enters ``starting`` /
 * ``streaming``, swap the right-dock top region to the Plot panel so
 * the user sees frames as they arrive. We do NOT auto-switch on
 * terminal states (done / error / aborted) — the user may want to keep
 * looking at the plot OR may have already navigated away to the
 * Inspector to compare values; either choice is fine, and aggressive
 * auto-switching that fights the user is worse than no auto-switching.
 */
function useTdsAutoSwitchToPlot(): void {
  const activeRunId = useRunsStore((s) => s.activeRunId);
  const runState = useRunsStore((s) =>
    activeRunId === null ? null : (s.runs[activeRunId]?.state ?? null),
  );
  const setActive = useUiStore((s) => s.setActiveRightDockTopPanel);
  const active = useUiStore((s) => s.activeRightDockTopPanel);

  useEffect(() => {
    // Auto-switch only on the leading edge of a run + only if the user
    // is currently sitting on a panel that would be locked-out anyway
    // (Disturbance during a run) OR on the Inspector default. If the
    // user is already on Plot or TdsConfig, leave them alone.
    if (runState !== 'starting' && runState !== 'streaming') return;
    if (active === 'inspector' || active === 'disturbance') {
      setActive('plot');
    }
    // Intentionally NOT depending on ``active`` — re-firing on every
    // user-driven panel change would be the "fights the user" failure
    // mode this hook is supposed to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runState, setActive]);
}

/**
 * Right-dock top region content router. Mounts the picker tab strip
 * above the active panel; the tab strip + the panel are part of the
 * same scroll region (the panel itself owns its inner scroll).
 *
 * Each candidate panel is mounted ONLY when active to keep the WebGL /
 * uPlot canvas teardown straightforward. This trades off a slight
 * remount cost on every swap for cleaner lifecycle reasoning — the
 * v0.2 plan accepts this trade in the "Panel-picker" key technical
 * decision.
 */
function RightDockTopPanel() {
  const active = useUiStore((s) => s.activeRightDockTopPanel);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelPickerTabs />
      <div className="flex min-h-0 flex-1 flex-col">
        {active === 'inspector' ? <ElementInspector /> : null}
        {active === 'disturbance' ? <DisturbancePanel /> : null}
        {active === 'plot' ? <PlotPanelContent /> : null}
        {active === 'analyze' ? <AnalyzePanel /> : null}
      </div>
    </div>
  );
}

/**
 * Composite content for the Plot panel: stacked uPlot + scrub control +
 * variable picker. Wraps them so the panel-picker only has to swap one
 * subtree.
 */
function PlotPanelContent() {
  return (
    <div
      data-testid="plot-panel-content"
      className={cn('flex h-full min-h-0 flex-col gap-2 p-2')}
    >
      <div className="min-h-0 flex-1">
        <TimeSeriesPlot />
      </div>
      <ScrubControl />
      <div className="border-border max-h-48 overflow-auto rounded border">
        <VariableTreePicker />
      </div>
    </div>
  );
}

export function App() {
  // The QueryClient is created once per mount via `useState`'s lazy
  // initializer — re-renders preserve the instance, but unmount/remount
  // (e.g., HMR or test isolation) gets a fresh client.
  const [queryClient] = useState(() => {
    const client = makeQueryClient();
    wireGlobalErrorRecovery(client);
    return client;
  });

  return (
    <QueryClientProvider client={queryClient}>
      <AppInner>
        <AppShell
          topBarLeft={
            <>
              <WorkspaceMenu />
              <EditMenu />
              <RunMenu />
            </>
          }
          topBarCenter={
            <div className="flex items-center gap-3">
              <RunButton />
              <RunStatusBadge />
            </div>
          }
          topBarRight={
            <>
              <RecoveryBadge />
              <ExportMenu />
              <HideLabelsToggle />
            </>
          }
          leftRail={<CaseNav />}
          inspector={<RightDockTopPanel />}
          results={<ResultsTable />}
          dockOverlay={
            <>
              <AddElementPanel />
              <ConvergenceErrorPanel />
              <NumericalErrorBanner />
            </>
          }
          modal={
            <>
              <TokenPasteModal />
              <RuntimeCrashModal />
            </>
          }
        />
      </AppInner>
    </QueryClientProvider>
  );
}
