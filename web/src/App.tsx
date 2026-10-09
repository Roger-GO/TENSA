import { Suspense, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from '@/components/shell/AppShell';
import { LeftSidebar } from '@/components/shell/LeftSidebar';
// v0.2 RunButton replaces the v0.1 PF-only one — handles BOTH PF and TDS,
// branches on a UI mode toggle that defaults to TDS when the disturbance
// editor has any disturbances.
import { RunButton } from '@/components/tds/RunButton';
import { RunStatusBadge } from '@/components/tds/RunStatusBadge';
import { HideLabelsToggle } from '@/components/pflow/HideLabelsToggle';
import { UnitsToggle } from '@/components/shell/UnitsToggle';
import { INLINE_FROM_NARROW } from '@/components/shell/topBarLayout';
import { WorkspaceMenu } from '@/components/shell/WorkspaceMenu';
import { EditMenu } from '@/components/shell/EditMenu';
import { RunMenu } from '@/components/shell/RunMenu';
import { ExportMenu } from '@/components/shell/ExportMenu';
import { SldLayoutSkeleton } from '@/components/sld/SldLayoutSkeleton';
import { BottomDrawer } from '@/components/shell/BottomDrawer';
import { ResultsView } from '@/components/shell/ResultsView';
import { EmptyState, FolderIcon } from '@/components/ui/EmptyState';
import { KeptResultsNote } from '@/components/history/KeptResultsNote';
import { makeQueryClient, wireGlobalErrorRecovery } from '@/api/queries';
import { useSessionRecovery } from '@/api/useSessionRecovery';
import { useSessionHeartbeat } from '@/api/useSessionHeartbeat';
import { useReopenAfterReload } from '@/api/useReopenAfterReload';
import { ResetRunHost } from '@/components/shell/ResetRunHost';
import { useSessionRelease } from '@/api/useSessionRelease';
import { useSessionMessagesSync } from '@/api/useSessionMessages';
import { useUnsavedWorkGuard } from '@/lib/useUnsavedWorkGuard';
import { useSyncTopologyMirror } from '@/lib/useSyncTopologyMirror';
import { useAddComponent } from '@/lib/useAddComponent';
import { useJobEventsStream } from '@/streaming/useJobEventsStream';
import { useSldFrameOverlay } from '@/components/sld/overlay';
import { RecoveryBadge } from '@/components/shell/RecoveryBadge';
import { JobAnnouncer } from '@/components/shell/JobAnnouncer';
import { WorkspaceDropTarget } from '@/components/shell/WorkspaceDropTarget';
// Imported for its side effect: the store entrypoint wires the cross-slice
// cascade (a case change clears the previous case's PF and analysis results).
import '@/store';
import { useCaseStore } from '@/store/case';
import { useReloadedCaseStore } from '@/store/reloadedCase';
import { startResultsPersistence } from '@/store/resultsPersistence';
import { useSnapshotStore } from '@/store/snapshot';
import { ComponentDropZone } from '@/components/sld/ComponentDropZone';
import { LazyMount, LoadingPanel } from '@/components/ui/Lazy';
import { lazyNamed } from '@/lib/lazyNamed';

// Code split out of the first load: the diagram (React Flow and the layout
// code) is fetched when a case is first shown, the Inspector when it is first
// opened (the shell mounts it for a selection, or when it is toggled on), the
// Add element panel when an element is first added, and the snapshot dialogs
// when one is first opened.
const SldCanvas = lazyNamed(() => import('@/components/sld/SldCanvas'), 'SldCanvas');
const RightInspector = lazyNamed(
  () => import('@/components/inspector/RightInspector'),
  'RightInspector',
);
const AddElementPanel = lazyNamed(
  () => import('@/components/elements/AddElementPanel'),
  'AddElementPanel',
  'overlay',
);
const SaveSnapshotDialog = lazyNamed(
  () => import('@/components/snapshot/SaveSnapshotDialog'),
  'SaveSnapshotDialog',
  'overlay',
);
const LoadSnapshotDialog = lazyNamed(
  () => import('@/components/snapshot/LoadSnapshotDialog'),
  'LoadSnapshotDialog',
  'overlay',
);
// What a run that failed is answered with. Each draws nothing until a run of
// the open case has failed, so they are fetched once a case is open and not
// with the first screen.
const ConvergenceErrorPanel = lazyNamed(
  () => import('@/components/pflow/ConvergenceErrorPanel'),
  'ConvergenceErrorPanel',
  'overlay',
);
const NumericalErrorBanner = lazyNamed(
  () => import('@/components/tds/NumericalErrorBanner'),
  'NumericalErrorBanner',
  'overlay',
);
const RuntimeCrashModal = lazyNamed(
  () => import('@/components/pflow/RuntimeCrashModal'),
  'RuntimeCrashModal',
  'overlay',
);

/**
 * Root component. Wraps the AppShell with the cross-cutting providers
 * (QueryClientProvider + global error recovery) and assembles the v3 IDE
 * layout slot composition: top bar with grouped menus + Run controls;
 * left sidebar with case nav (Unit 3 will replace with the unified case
 * + library + saved sidebar); canvas with SldCanvas; right inspector +
 * bottom drawer placeholders (Units 7-14 will populate); dock overlay
 * for AddElementPanel + transient banners; modal for runtime crash.
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
function AppInner({ children }: { children: React.ReactNode }) {
  // Top-level recovery driver — must live INSIDE QueryClientProvider so
  // ``useCreateSession`` / ``useLoadCase`` can subscribe to the cache.
  // Mounted once for the lifetime of the tab; survives the picker
  // unmount that would otherwise kill the recovery cycle once a case is
  // loaded (v0.1.y Unit 5 bug fix).
  useSessionRecovery();
  // After a reload of the page: open the case the tab had open again, with
  // the edits it kept.
  useReopenAfterReload();
  // Check in with the substrate every 30 s so an idle tab keeps its session
  // (and a lost one is noticed before the user's next click).
  useSessionHeartbeat();
  // Give the session back when the tab is closed or reloaded, so reloads do not
  // fill the substrate's session cap with sessions no tab has.
  useSessionRelease();
  // Ask before the tab is closed or reloaded with edits, a build or run results
  // that nothing has saved.
  useUnsavedWorkGuard();
  // Put back the finished runs and the power flows the browser kept from the
  // last visit, and keep the ones made from now on.
  useEffect(() => {
    const persistence = startResultsPersistence();
    return () => persistence.stop();
  }, []);
  // v3.1 Unit 11: own the per-session JobStream here (the mount Unit 6
  // deferred). One WS per active session feeds canonical job events into
  // ``useJobsStore`` REGARDLESS of whether the Activity panel is open, so
  // the TopBar in-flight chip + the panel history stay live. Disposes on
  // session change / unmount.
  useJobEventsStream();
  // What ANDES says while a command runs: read from the server's log whenever a job
  // starts or ends (and while one is in flight) into ``useMessagesStore``, so the
  // Messages tab and its count are current whether or not the tab is open.
  useSessionMessagesSync();
  // Keep the case-store topology mirror in sync with the topology query so the
  // dynamic-content badge + run-readiness gate (Unit 24) reflect the loaded
  // case even when the query is served from cache.
  useSyncTopologyMirror();
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
      {/* Reset run for the places that say a run has fixed the system and have
          no component of their own to make the request from. */}
      <ResetRunHost />
      {/* Case files dropped anywhere on the window are added to the workspace. */}
      <WorkspaceDropTarget />
    </>
  );
}

/**
 * Default ``canvas`` slot content depends on whether a case is loaded:
 *
 * - no case → EmptyState ("No case loaded"), wrapped in a
 *   ComponentDropZone — directs the user to the left sidebar AND accepts
 *   a row dragged from the Components palette, which spins up a blank system and
 *   places a draft of that kind on its diagram (the build-from-scratch entry the
 *   sidebar advertises but which previously did nothing on drop). After a reload the
 *   case the tab had open is opened again (``useReopenAfterReload``), and the slot says
 *   so while that is under way.
 * - case loaded → SldCanvas (which itself shows the layout-skeleton
 *   while ELK runs and the canvas once positions are known).
 */
function CanvasSlot() {
  const caseSelection = useCaseStore((s) => s.selection);
  const loadingPath = useCaseStore((s) => s.loadingPath);
  // After a reload: the case the tab had open, while it is being opened again.
  const reopening = useReloadedCaseStore((s) => s.closed);
  const { place: placeComponent } = useAddComponent();
  const [dropError, setDropError] = useState<string | null>(null);

  if (caseSelection !== null) {
    // The skeleton is the one SldCanvas itself shows while ELK lays the graph
    // out, so the canvas does not flash a second placeholder as its chunk
    // arrives.
    return (
      <Suspense fallback={<SldLayoutSkeleton />}>
        <SldCanvas />
      </Suspense>
    );
  }

  // Drop = "start a blank system with this element on its diagram": as a draft,
  // which is what a row dropped on a diagram is. The palette says why when a row
  // cannot be dragged.
  const handleDropComponent = (kind: string) => {
    setDropError(null);
    placeComponent(kind, setDropError);
  };

  return (
    <ComponentDropZone
      onDropComponent={handleDropComponent}
      className="h-full w-full"
      data-testid="no-case-drop-zone"
    >
      {loadingPath !== null ? (
        // ``selection`` is only set once a load lands, and the first load of a
        // case generates code for its models, so say that it is in progress.
        <EmptyState
          icon={<FolderIcon />}
          title={`Loading ${loadingPath}…`}
          description={
            reopening !== null
              ? 'The page was reloaded: the case it had open is opened again, with the edits made to it.'
              : 'Opening the case. The first load of a case can take a while.'
          }
          emptyStateKey="app-shell-case-loading"
          aria-busy="true"
        />
      ) : reopening !== null ? (
        // A system built from scratch has no file to load: it is built again.
        <EmptyState
          icon={<FolderIcon />}
          title="Opening your system again…"
          description="The page was reloaded: the system you were building is put back, element by element."
          emptyStateKey="app-shell-case-reopening"
          aria-busy="true"
        />
      ) : (
        <EmptyState
          icon={<FolderIcon />}
          title="No case loaded"
          description={
            dropError ??
            'Pick a case file in the Project tab of the left sidebar, drop one anywhere in this window, or click or drag a component from its Components tab to start a blank system.'
          }
          emptyStateKey="app-shell-no-case"
        >
          {/* What the browser kept from before a reload, which needs no case. */}
          <KeptResultsNote />
        </EmptyState>
      )}
    </ComponentDropZone>
  );
}

/**
 * The surfaces that answer a failed run (a power flow that did not converge,
 * a time-domain run that stopped, a server error). Each reads the stores and
 * draws nothing until a run has failed, which takes a case to run on: they
 * are mounted, and their code fetched, once a case is open.
 */
function RunErrorSurfaces({ children }: { children: ReactNode }) {
  const caseOpen = useCaseStore((s) => s.selection !== null);
  return <LazyMount when={caseOpen}>{children}</LazyMount>;
}

/**
 * The snapshot save/load dialogs. Each is store-driven (``saveDialogOpen`` /
 * ``loadDialogOpen``) and self-gates to nothing while closed, so it is only
 * fetched and mounted once its flag has been set.
 */
function SnapshotDialogs() {
  const saveOpen = useSnapshotStore((s) => s.saveDialogOpen);
  const loadOpen = useSnapshotStore((s) => s.loadDialogOpen);
  const closeDialogs = useSnapshotStore((s) => s.closeDialogs);
  return (
    <>
      <LazyMount when={saveOpen} onLoadFailed={closeDialogs}>
        <SaveSnapshotDialog />
      </LazyMount>
      <LazyMount when={loadOpen} onLoadFailed={closeDialogs}>
        <LoadSnapshotDialog />
      </LazyMount>
    </>
  );
}

/**
 * The Add element panel, which draws nothing while it is closed, so it is
 * fetched and mounted once something has opened it.
 */
function AddElementDock() {
  const open = useCaseStore((s) => s.addPanelOpen);
  const closeAddPanel = useCaseStore((s) => s.closeAddPanel);
  return (
    <LazyMount when={open} onLoadFailed={closeAddPanel}>
      <AddElementPanel />
    </LazyMount>
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
              <HideLabelsToggle className={INLINE_FROM_NARROW} />
              <UnitsToggle className={INLINE_FROM_NARROW} />
            </>
          }
          leftSidebar={<LeftSidebar />}
          canvas={<CanvasSlot />}
          rightInspector={
            <Suspense fallback={<LoadingPanel />}>
              <RightInspector />
            </Suspense>
          }
          bottomDrawer={<BottomDrawer />}
          resultsView={<ResultsView />}
          dockOverlay={
            <>
              <AddElementDock />
              <RunErrorSurfaces>
                <ConvergenceErrorPanel />
                <NumericalErrorBanner />
              </RunErrorSurfaces>
            </>
          }
          modal={
            <>
              <RunErrorSurfaces>
                <RuntimeCrashModal />
              </RunErrorSurfaces>
              {/* Snapshot save/load dialogs are store-driven (saveDialogOpen /
                  loadDialogOpen) and self-gate to null when closed. They were
                  previously mounted only inside SnapshotMenu, which a v3
                  refactor stopped rendering — so the Workspace menu's "Save
                  snapshot…" / "Load snapshot…" flipped the store flag but
                  nothing rendered (and Sweep, which needs a snapshot, was
                  unreachable). Mount them at the app root so the actions work. */}
              <SnapshotDialogs />
            </>
          }
        />
      </AppInner>
    </QueryClientProvider>
  );
}
