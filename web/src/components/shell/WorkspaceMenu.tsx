/**
 * WorkspaceMenu — TopBar dropdown that groups every action that
 * mutates or persists the loaded workspace (Unit 8 of the v2.0
 * polish plan).
 *
 * Items:
 *
 * - "Add element…"        — opens the Add-element panel (case store)
 * - "Add PMU…"            — opens the PMU placement dialog
 * - "Import profile…"     — opens the TimeSeries profile import dialog
 * - "Save system…"        — opens the Save System dialog
 * - "Save snapshot…"      — opens the snapshot save dialog
 * - "Load snapshot…"      — opens the snapshot load dialog
 * - "Import bundle…"      — opens the reproducibility-bundle import dialog
 * - "Report"              — opens the multi-routine report dialog
 *
 * All gating logic mirrors the source button components verbatim — when
 * those components disable themselves (no topology, committed run, PFlow
 * running, …), the corresponding menu item disables too. The original
 * button components stay on disk so their dedicated unit tests keep
 * passing; this menu just remounts the actions in a grouped surface.
 *
 * Per Unit 8's "DO NOT add new dependencies" constraint, dialogs
 * managed by local state in their wrapper components are mounted with
 * local state here too (PmuPlacementDialog, ProfileImportDialog).
 * Dialogs already lifted to a Zustand slice (snapshot, bundle, report)
 * are opened via store actions; their dialog wrappers live in
 * `<TopBar />` so they stay mounted whether or not this menu is open.
 */
import { useState } from 'react';
import {
  TopBarMenu,
  TopBarMenuItem,
  TopBarMenuSeparator,
} from './TopBarMenu';
import { PmuPlacementDialog } from '@/components/pmu/PmuPlacementDialog';
import { ProfileImportDialog } from '@/components/profiles/ProfileImportDialog';
import { SaveSystemButton } from '@/components/case/SaveSystemButton';
import { BundleImportButton } from '@/components/bundle/BundleImportDialog';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { useCurrentTopology } from '@/api/queries';
import { usePflowStore } from '@/store/pflow';
import { useSnapshotStore } from '@/store/snapshot';
import { useReportDialogStore } from '@/components/reports/ReportDialog';

export function WorkspaceMenu() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const caseSelection = useCaseStore((s) => s.selection);
  const topology = useCurrentTopology();
  const isPfRunning = usePflowStore((s) => s.isRunning);
  const openAddPanel = useCaseStore((s) => s.openAddPanel);
  const openSnapshotSave = useSnapshotStore((s) => s.openSaveDialog);
  const openSnapshotLoad = useSnapshotStore((s) => s.openLoadDialog);
  const openReportDialog = useReportDialogStore((s) => s.openDialog);

  const [pmuOpen, setPmuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const noTopology = topology === null;
  const committed = topology?.state === 'committed';

  // Match the gating semantics of AddElementButton / PmuPlacementButton /
  // ProfileImportButton — disable when no topology, when the run is
  // committed (substrate refuses pre-setup mutations afterwards), and
  // while PF is running.
  const editGateDisabled = noTopology || committed || isPfRunning;

  // Snapshot + report items only need a session + case selection; they
  // operate on the substrate's persisted state, not the in-memory edit
  // graph.
  const sessionScopeDisabled = sessionId === null || caseSelection === null;
  const reportDisabled = sessionId === null;

  return (
    <>
      <TopBarMenu label="Workspace" testId="topbar-menu-workspace">
        <TopBarMenuItem
          testId="topbar-menu-workspace-add-element"
          disabled={editGateDisabled}
          onClick={() => openAddPanel(null)}
        >
          Add element…
        </TopBarMenuItem>
        <TopBarMenuItem
          testId="topbar-menu-workspace-add-pmu"
          disabled={editGateDisabled}
          onClick={() => setPmuOpen(true)}
        >
          Add PMU…
        </TopBarMenuItem>
        <TopBarMenuItem
          testId="topbar-menu-workspace-import-profile"
          disabled={editGateDisabled}
          onClick={() => setProfileOpen(true)}
        >
          Import profile…
        </TopBarMenuItem>

        <TopBarMenuSeparator />

        {/* SaveSystem keeps its dialog co-located in the SaveSystemButton
            component; the easiest way to avoid duplicating that ~150-line
            dialog is to embed the button itself. The wrapper class makes
            it occupy the menu's full width so it visually reads as a
            menu item. */}
        <div className="px-1 [&_button]:w-full [&_button]:justify-start">
          <SaveSystemButton />
        </div>

        <TopBarMenuItem
          testId="topbar-menu-workspace-save-snapshot"
          disabled={sessionScopeDisabled}
          onClick={openSnapshotSave}
        >
          Save snapshot…
        </TopBarMenuItem>
        <TopBarMenuItem
          testId="topbar-menu-workspace-load-snapshot"
          disabled={sessionScopeDisabled}
          onClick={openSnapshotLoad}
        >
          Load snapshot…
        </TopBarMenuItem>

        <TopBarMenuSeparator />

        {/* BundleImportButton keeps its own dialog state — embed it the
            same way as SaveSystem. */}
        <div className="px-1 [&_button]:w-full [&_button]:justify-start">
          <BundleImportButton />
        </div>

        <TopBarMenuItem
          testId="topbar-menu-workspace-report"
          disabled={reportDisabled}
          onClick={() => openReportDialog()}
        >
          Report
        </TopBarMenuItem>
      </TopBarMenu>
      <PmuPlacementDialog open={pmuOpen} onOpenChange={setPmuOpen} />
      <ProfileImportDialog open={profileOpen} onOpenChange={setProfileOpen} />
    </>
  );
}
