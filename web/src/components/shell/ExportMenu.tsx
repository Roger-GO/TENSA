/**
 * ExportMenu — TopBar dropdown grouping the workspace-wide export
 * actions (Unit 8 of the v2.0 polish plan).
 *
 * Items:
 *
 * - "Export bundle…"  — opens the BundleExportDialog (the
 *                       reproducibility ``.zip`` flow from Unit 3).
 * - "Save snapshot…"  — duplicate of the WorkspaceMenu entry; placed
 *                       here too because users browsing the Export
 *                       menu reasonably expect to find "save the run
 *                       state for later" alongside the bundle export.
 *
 * Note on naming: there's an existing ``ExportMenu`` at
 * ``components/export/ExportMenu.tsx`` which is the per-panel
 * (chart/table/SLD) export trigger. This one lives under
 * ``components/shell/`` and is the TopBar-level one. The two share a
 * name only because the file location disambiguates; both are
 * conventional within their respective surfaces.
 *
 * Per-routine CSV exports (PMU CSV, time-series CSV) are NOT routed
 * through this menu — those panels have their own ``<ExportMenu />``
 * trigger (CSV / PNG / MAT). Mirroring them at the topbar would
 * either ship as no-op placeholders (the user has no panel context to
 * choose what to export) or duplicate the per-panel state machinery.
 * The TopBar export menu sticks to workspace-scoped artefacts.
 */
import {
  TopBarMenu,
  TopBarMenuItem,
  TopBarMenuSeparator,
} from './TopBarMenu';
import { useBundleStore } from '@/store/bundle';
import { useSnapshotStore } from '@/store/snapshot';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';

export function ExportMenu() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const caseSelection = useCaseStore((s) => s.selection);
  const openBundleDialog = useBundleStore((s) => s.openDialog);
  const openSnapshotSave = useSnapshotStore((s) => s.openSaveDialog);

  const sessionScopeDisabled = sessionId === null || caseSelection === null;

  return (
    <TopBarMenu label="Export" testId="topbar-menu-export" alignEnd>
      <TopBarMenuItem
        testId="topbar-menu-export-bundle"
        disabled={sessionScopeDisabled}
        onClick={openBundleDialog}
      >
        Export bundle…
      </TopBarMenuItem>
      <TopBarMenuSeparator />
      <TopBarMenuItem
        testId="topbar-menu-export-snapshot"
        disabled={sessionScopeDisabled}
        onClick={openSnapshotSave}
      >
        Save snapshot…
      </TopBarMenuItem>
    </TopBarMenu>
  );
}
