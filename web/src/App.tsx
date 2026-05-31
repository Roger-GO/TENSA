import { useEffect, useRef, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from '@/components/shell/AppShell';
import { TokenPasteModal } from '@/components/auth/TokenPasteModal';
import { LeftSidebar } from '@/components/shell/LeftSidebar';
// v0.2 RunButton replaces the v0.1 PF-only one — handles BOTH PF and TDS,
// branches on a UI mode toggle that defaults to TDS when the disturbance
// editor has any disturbances.
import { RunButton } from '@/components/tds/RunButton';
import { RunStatusBadge } from '@/components/tds/RunStatusBadge';
import { NumericalErrorBanner } from '@/components/tds/NumericalErrorBanner';
import { ConvergenceErrorPanel } from '@/components/pflow/ConvergenceErrorPanel';
import { RuntimeCrashModal } from '@/components/pflow/RuntimeCrashModal';
import { AddElementPanel } from '@/components/elements/AddElementPanel';
import { HideLabelsToggle } from '@/components/pflow/HideLabelsToggle';
import { WorkspaceMenu } from '@/components/shell/WorkspaceMenu';
import { EditMenu } from '@/components/shell/EditMenu';
import { RunMenu } from '@/components/shell/RunMenu';
import { ExportMenu } from '@/components/shell/ExportMenu';
import { SldCanvas } from '@/components/sld/SldCanvas';
import { RightInspector } from '@/components/inspector/RightInspector';
import { BottomDrawer } from '@/components/shell/BottomDrawer';
import { ResultsView } from '@/components/shell/ResultsView';
import { EmptyState, FolderIcon } from '@/components/ui/EmptyState';
import {
  makeQueryClient,
  wireGlobalErrorRecovery,
  useCurrentTopology,
  useBlankSystem,
} from '@/api/queries';
import { useSessionRecovery } from '@/api/useSessionRecovery';
import { useJobEventsStream } from '@/streaming/useJobEventsStream';
import { useSldFrameOverlay } from '@/components/sld/overlay';
import { RecoveryBadge } from '@/components/shell/RecoveryBadge';
import { JobAnnouncer } from '@/components/shell/JobAnnouncer';
import { setTokenGetter, ProblemDetailsError } from '@/api/client';
import { getAuthToken } from '@/store';
import { useAuthStore } from '@/store/auth';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { ComponentDropZone } from '@/components/sld/ComponentDropZone';
import { SaveSnapshotDialog } from '@/components/snapshot/SaveSnapshotDialog';
import { LoadSnapshotDialog } from '@/components/snapshot/LoadSnapshotDialog';

// Wire the API client's token-getter to the auth store. This runs once at
// module load (the App.tsx import is the entry point); `getAuthToken`
// reads from the Zustand store via `getState()` so it doesn't need a
// React context.
setTokenGetter(getAuthToken);

/**
 * Root component. Wraps the AppShell with the cross-cutting providers
 * (QueryClientProvider + global 401 cascade) and assembles the v3 IDE
 * layout slot composition: top bar with grouped menus + Run controls;
 * left sidebar with case nav (Unit 3 will replace with the unified case
 * + library + saved sidebar); canvas with SldCanvas; right inspector +
 * bottom drawer placeholders (Units 7-14 will populate); dock overlay
 * for AddElementPanel + transient banners; modals for token-paste +
 * runtime crash.
 *
 * v3 Unit 1: this is the chassis-only commit. The right inspector and
 * bottom drawer slots intentionally render placeholder content — Units
 * 7+11+12+14 wire their real content. The chassis state (collapse,
 * sizes, active tabs) is fully driven by ``useLayoutStore`` so later
 * units can flip toggles via the existing store actions.
 *
 * Error-surface routing (R8 → R18):
 *
 * - Parse error (load failed) → ProblemDetailsErrorSurface (banner) inside CaseNav.
 * - Solver non-convergence → ConvergenceErrorPanel as dock overlay.
 * - Runtime crash (5xx) → RuntimeCrashModal as the one allowed
 *   non-destructive modal.
 */
/**
 * Dev-mode no-auth detection. When no token is present at boot, probe the
 * substrate once: a 200 means it was started with `serve --no-auth`, so the
 * token gate is skipped (the API client sends no header and the no-auth
 * backend accepts it); a 401 leaves the TokenPasteModal to handle auth. The
 * probe is one-shot (StrictMode-safe via a ref) and never aborts — it's an
 * idempotent GET. `authProbeDone` keeps the modal hidden until this resolves
 * so a no-auth backend never flashes the paste modal.
 */
function useNoAuthProbe(): void {
  const setAuthDisabled = useAuthStore((s) => s.setAuthDisabled);
  const markAuthProbeDone = useAuthStore((s) => s.markAuthProbeDone);
  const probedRef = useRef(false);
  useEffect(() => {
    if (probedRef.current) return;
    probedRef.current = true;
    if (getAuthToken() !== null) {
      markAuthProbeDone();
      return;
    }
    void (async () => {
      try {
        const res = await fetch('/api/sessions');
        if (res.status === 200) setAuthDisabled();
      } catch {
        // Substrate unreachable — leave the TokenPasteModal to surface it.
      } finally {
        markAuthProbeDone();
      }
    })();
  }, [setAuthDisabled, markAuthProbeDone]);
}

/**
 * Mirror the topology query into the case store on every change. The store
 * holds a synchronous `topology` mirror that non-query consumers read (the
 * dynamic-content badge + the run-readiness dynamic gate, Unit 24). The plain
 * topology query is often served from the TanStack cache (seeded by the load
 * mutation), so its `queryFn` doesn't re-run to set the mirror — this effect
 * keeps the mirror faithful to `useCurrentTopology()` whether the data came
 * from a fetch or the cache. Mounted once at the app root.
 */
function useSyncTopologyMirror(): void {
  const topology = useCurrentTopology();
  const setTopology = useCaseStore((s) => s.setTopology);
  useEffect(() => {
    if (topology !== null) setTopology(topology);
  }, [topology, setTopology]);
}

function AppInner({ children }: { children: React.ReactNode }) {
  // Top-level recovery driver — must live INSIDE QueryClientProvider so
  // ``useCreateSession`` / ``useLoadCase`` can subscribe to the cache.
  // Mounted once for the lifetime of the tab; survives the picker
  // unmount that would otherwise kill the recovery cycle once a case is
  // loaded (v0.1.y Unit 5 bug fix).
  useSessionRecovery();
  // v3.1 Unit 11: own the per-session JobStream here (the mount Unit 6
  // deferred). One WS per active session feeds canonical job events into
  // ``useJobsStore`` REGARDLESS of whether the Activity panel is open, so
  // the TopBar in-flight chip + the panel history stay live. Disposes on
  // session change / token loss / unmount.
  useJobEventsStream();
  // Keep the case-store topology mirror in sync with the topology query so the
  // dynamic-content badge + run-readiness gate (Unit 24) reflect the loaded
  // case even when the query is served from cache.
  useSyncTopologyMirror();
  // Dev-mode: detect a `serve --no-auth` substrate so the token gate is
  // skipped without a paste modal (no-op against an auth-on substrate).
  useNoAuthProbe();
  // v0.2 Unit 5: SINGLE rAF loop driving the SLD streaming overlay.
  // Mounted once at the App root so all BusNodes share one tick source
  // (avoids N-rAF-loops-for-N-buses at NPCC scale). The hook is a
  // no-op when no run is active.
  useSldFrameOverlay();
  return (
    <>
      {children}
      {/* a11y: announce background job outcomes (done/failed/cancelled) to
          assistive tech regardless of whether the Activity panel is open. */}
      <JobAnnouncer />
    </>
  );
}

/**
 * Default ``canvas`` slot content depends on whether a case is loaded:
 *
 * - no case → EmptyState ("No case loaded"), wrapped in a
 *   ComponentDropZone — directs the user to the left sidebar AND accepts
 *   a dragged Component Library tile, which spins up a blank system and
 *   opens that kind's add form (the build-from-scratch entry the sidebar
 *   advertises but which previously did nothing on drop).
 * - case loaded → SldCanvas (which itself shows the layout-skeleton
 *   while ELK runs and the canvas once positions are known).
 */
function CanvasSlot() {
  const caseSelection = useCaseStore((s) => s.selection);
  const sessionId = useSessionStore((s) => s.sessionId);
  const setCase = useCaseStore((s) => s.setCase);
  const openAddPanel = useCaseStore((s) => s.openAddPanel);
  const blank = useBlankSystem();
  const [dropError, setDropError] = useState<string | null>(null);

  if (caseSelection !== null) {
    return <SldCanvas />;
  }

  // Drop = "start a blank system seeded with this element". Mirrors
  // NewSystemButton's blank flow, then opens the dropped kind's form.
  const handleDropComponent = (kind: string) => {
    if (!sessionId || blank.isPending) return;
    setDropError(null);
    blank.mutate(sessionId, {
      onSuccess: () => {
        setCase({ primaryPath: null, addfiles: [], blank: true });
        openAddPanel(kind);
      },
      onError: (err) => {
        if (err instanceof ProblemDetailsError && err.status === 409) {
          setDropError('A system is already loaded; discard it first or open a fresh tab.');
        } else if (err instanceof Error) {
          setDropError(err.message);
        }
      },
    });
  };

  return (
    <ComponentDropZone
      onDropComponent={handleDropComponent}
      className="h-full w-full"
      data-testid="no-case-drop-zone"
    >
      <EmptyState
        icon={<FolderIcon />}
        title="No case loaded"
        description={
          dropError ??
          'Pick a case file from the left sidebar — or drag a component here to start a blank system.'
        }
        emptyStateKey="app-shell-no-case"
      />
    </ComponentDropZone>
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
          leftSidebar={<LeftSidebar />}
          canvas={<CanvasSlot />}
          rightInspector={<RightInspector />}
          bottomDrawer={<BottomDrawer />}
          resultsView={<ResultsView />}
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
              {/* Snapshot save/load dialogs are store-driven (saveDialogOpen /
                  loadDialogOpen) and self-gate to null when closed. They were
                  previously mounted only inside SnapshotMenu, which a v3
                  refactor stopped rendering — so the Workspace menu's "Save
                  snapshot…" / "Load snapshot…" flipped the store flag but
                  nothing rendered (and Sweep, which needs a snapshot, was
                  unreachable). Mount them at the app root so the actions work. */}
              <SaveSnapshotDialog />
              <LoadSnapshotDialog />
            </>
          }
        />
      </AppInner>
    </QueryClientProvider>
  );
}
