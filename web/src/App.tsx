import { useState } from 'react';
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
import { HideLabelsToggle } from '@/components/pflow/HideLabelsToggle';
import { ConvergenceErrorPanel } from '@/components/pflow/ConvergenceErrorPanel';
import { RuntimeCrashModal } from '@/components/pflow/RuntimeCrashModal';
import { AddElementButton } from '@/components/elements/AddElementButton';
import { AddElementPanel } from '@/components/elements/AddElementPanel';
import { SaveSystemButton } from '@/components/case/SaveSystemButton';
import { WorkflowToolbar } from '@/components/case/WorkflowToolbar';
import { makeQueryClient, wireGlobalErrorRecovery } from '@/api/queries';
import { useSessionRecovery } from '@/api/useSessionRecovery';
import { useSldFrameOverlay } from '@/components/sld/overlay';
import { RecoveryBadge } from '@/components/shell/RecoveryBadge';
import { setTokenGetter } from '@/api/client';
import { getAuthToken } from '@/store';

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
  return <>{children}</>;
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
              <AddElementButton />
              <SaveSystemButton />
              <WorkflowToolbar />
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
              <HideLabelsToggle />
            </>
          }
          leftRail={<CaseNav />}
          inspector={<ElementInspector />}
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
