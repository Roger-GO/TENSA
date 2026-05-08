import { useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from '@/components/shell/AppShell';
import { TokenPasteModal } from '@/components/auth/TokenPasteModal';
import { CaseNav } from '@/components/case/CaseNav';
import { ElementInspector } from '@/components/inspector/ElementInspector';
import { ResultsTable } from '@/components/inspector/ResultsTable';
import { RunButton } from '@/components/pflow/RunButton';
import { HideLabelsToggle } from '@/components/pflow/HideLabelsToggle';
import { ConvergenceErrorPanel } from '@/components/pflow/ConvergenceErrorPanel';
import { RuntimeCrashModal } from '@/components/pflow/RuntimeCrashModal';
import { AddElementButton } from '@/components/elements/AddElementButton';
import { AddElementPanel } from '@/components/elements/AddElementPanel';
import { SaveSystemButton } from '@/components/case/SaveSystemButton';
import { WorkflowToolbar } from '@/components/case/WorkflowToolbar';
import { makeQueryClient, wireGlobalErrorRecovery } from '@/api/queries';
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
      <AppShell
        topBarLeft={
          <>
            <AddElementButton />
            <SaveSystemButton />
            <WorkflowToolbar />
          </>
        }
        topBarCenter={<RunButton />}
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
          </>
        }
        modal={
          <>
            <TokenPasteModal />
            <RuntimeCrashModal />
          </>
        }
      />
    </QueryClientProvider>
  );
}
