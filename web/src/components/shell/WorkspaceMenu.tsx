/**
 * WorkspaceMenu — TopBar dropdown that groups every action that
 * mutates or persists the loaded workspace.
 *
 * Unit 9 of the v2.0 polish plan refactored this file to derive its
 * items from the shared command registry (`useCommandRegistry()`).
 * The menu and the ⌘K command palette now read from the same source —
 * adding or renaming an action in `web/src/lib/commands.ts` updates
 * both surfaces simultaneously.
 *
 * What this component still owns:
 *
 * - The local React state for the PMU placement and Profile import
 *   dialogs (whose original button components were
 *   `<PmuPlacementDialog />` + `<ProfileImportDialog />` with
 *   `useState` open/close). The Save System and Bundle Import
 *   dialogs likewise live as local state inside this component now,
 *   triggered via the palette-dialog bridge.
 * - The `subscribePaletteDialog` subscription that lets the palette
 *   open those local-state dialogs without lifting their `useState`
 *   into a Zustand slice.
 *
 * Gating logic lives entirely in the command registry's `when()`
 * predicates — when those return `false`, `useCommandRegistry()`
 * filters the command out, and the menu naturally hides it. The
 * pre-Unit-9 menu rendered disabled items; the registry-driven menu
 * hides them entirely. This matches the palette's behaviour and
 * keeps the topbar tighter when no case is loaded.
 */
import { useEffect, useState } from 'react';
import { TopBarMenu, TopBarMenuItem, TopBarMenuSeparator } from './TopBarMenu';
import { PmuPlacementDialog } from '@/components/pmu/PmuPlacementDialog';
import { ProfileImportDialog } from '@/components/profiles/ProfileImportDialog';
import { SaveSystemButton } from '@/components/case/SaveSystemButton';
import { BundleImportButton } from '@/components/bundle/BundleImportDialog';
import { useCommandRegistry, subscribePaletteDialog } from '@/lib/commands';

/** Map registry id → existing testid suffix (preserves Unit-8 contract). */
const TESTID_BY_ID: Record<string, string> = {
  'workspace.add-element': 'topbar-menu-workspace-add-element',
  'workspace.add-pmu': 'topbar-menu-workspace-add-pmu',
  'workspace.import-profile': 'topbar-menu-workspace-import-profile',
  'workspace.save-system': 'topbar-menu-workspace-save-system',
  'workspace.save-snapshot': 'topbar-menu-workspace-save-snapshot',
  'workspace.load-snapshot': 'topbar-menu-workspace-load-snapshot',
  'workspace.import-bundle': 'topbar-menu-workspace-import-bundle',
  'workspace.report': 'topbar-menu-workspace-report',
};

export function WorkspaceMenu() {
  const commands = useCommandRegistry();
  const workspaceCommands = commands.filter((c) => c.group === 'workspace');

  // Local dialog ownership for the Save-system / Bundle-import /
  // PMU / Profile flows. These dialogs were previously embedded as
  // their own `<Button + Dialog>` components inside this menu; for
  // Unit 9 we keep the Dialog mounted but trigger it via the
  // palette-dialog bridge so both menu items and palette commands
  // route through a single open path.
  const [pmuOpen, setPmuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    return subscribePaletteDialog((key) => {
      if (key === 'pmu') setPmuOpen(true);
      if (key === 'profile') setProfileOpen(true);
    });
  }, []);

  // Menu-item handler. Items invoke the registry's `action`
  // directly; for PMU/profile the action posts to the bridge which
  // we just subscribed to above.
  const handleClick = (id: string) => {
    const cmd = workspaceCommands.find((c) => c.id === id);
    cmd?.action();
  };

  return (
    <>
      <TopBarMenu label="Workspace" testId="topbar-menu-workspace">
        {workspaceCommands.map((cmd, idx) => {
          // SaveSystem and BundleImport were originally embedded as
          // full-width Button components (the menu entry rendered the
          // button itself). We keep that embedding for the click
          // affordance but the registry now declares the canonical
          // command id used everywhere else (palette, tests). Render
          // a separator before the snapshot block + before the
          // import-bundle block to match the visual grouping the
          // pre-Unit-9 menu had.
          const insertSeparatorBefore =
            cmd.id === 'workspace.save-system' || cmd.id === 'workspace.import-bundle';

          if (cmd.id === 'workspace.save-system') {
            return (
              <div key={cmd.id}>
                {insertSeparatorBefore && idx > 0 ? <TopBarMenuSeparator /> : null}
                <div
                  data-testid={TESTID_BY_ID[cmd.id]}
                  className="px-1 [&_button]:w-full [&_button]:justify-start"
                >
                  <SaveSystemButton />
                </div>
              </div>
            );
          }
          if (cmd.id === 'workspace.import-bundle') {
            return (
              <div key={cmd.id}>
                {insertSeparatorBefore && idx > 0 ? <TopBarMenuSeparator /> : null}
                <div
                  data-testid={TESTID_BY_ID[cmd.id]}
                  className="px-1 [&_button]:w-full [&_button]:justify-start"
                >
                  <BundleImportButton />
                </div>
              </div>
            );
          }
          return (
            <TopBarMenuItem
              key={cmd.id}
              testId={TESTID_BY_ID[cmd.id] ?? `topbar-menu-workspace-${cmd.id}`}
              onClick={() => handleClick(cmd.id)}
            >
              {cmd.label}
            </TopBarMenuItem>
          );
        })}
      </TopBarMenu>
      <PmuPlacementDialog open={pmuOpen} onOpenChange={setPmuOpen} />
      <ProfileImportDialog open={profileOpen} onOpenChange={setProfileOpen} />
    </>
  );
}
