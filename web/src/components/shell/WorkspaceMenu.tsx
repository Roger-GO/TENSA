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
 * - The local React state for the PMU placement, Profile import, Save
 *   System and Bundle Import dialogs, which the palette-dialog bridge
 *   opens. The Save System and Bundle Import dialogs are mounted here, not
 *   inside their menu item, because a Radix popover unmounts its content
 *   while closed and the palette (or Ctrl/Cmd+S) has no menu open to click.
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
import { LazyMount } from '@/components/ui/Lazy';
import { lazyNamed } from '@/lib/lazyNamed';
import { SaveSystemDialog } from '@/components/case/SaveSystemDialog';
import { BundleImportDialog } from '@/components/bundle/BundleImportDialog';
import { useCommandRegistry, subscribePaletteDialog } from '@/lib/commands';

// The PMU and profile-import dialogs are separate chunks, fetched the first
// time each opens.
const PmuPlacementDialog = lazyNamed(
  () => import('@/components/pmu/PmuPlacementDialog'),
  'PmuPlacementDialog',
  'overlay',
);
const ProfileImportDialog = lazyNamed(
  () => import('@/components/profiles/ProfileImportDialog'),
  'ProfileImportDialog',
  'overlay',
);

/** Map registry id → existing testid suffix (preserves Unit-8 contract). */
const TESTID_BY_ID: Record<string, string> = {
  'workspace.open-case': 'topbar-menu-workspace-open-case',
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
  const [saveOpen, setSaveOpen] = useState(false);
  const [importBundleOpen, setImportBundleOpen] = useState(false);

  useEffect(() => {
    return subscribePaletteDialog((key) => {
      if (key === 'pmu') setPmuOpen(true);
      if (key === 'profile') setProfileOpen(true);
      if (key === 'save-system') setSaveOpen(true);
      if (key === 'import-bundle') setImportBundleOpen(true);
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
        {/* A flat list, not a Fragment per item: TopBarMenu closes the menu on a
            click by cloning the items that are its direct children. */}
        {workspaceCommands.flatMap((cmd, idx) => {
          // A separator before the save and import-bundle items keeps the visual
          // grouping the pre-Unit-9 menu had.
          const separated =
            idx > 0 && (cmd.id === 'workspace.save-system' || cmd.id === 'workspace.import-bundle');
          return [
            ...(separated ? [<TopBarMenuSeparator key={`${cmd.id}-separator`} />] : []),
            <TopBarMenuItem
              key={cmd.id}
              testId={TESTID_BY_ID[cmd.id] ?? `topbar-menu-workspace-${cmd.id}`}
              title={cmd.description}
              onClick={() => handleClick(cmd.id)}
            >
              {cmd.label}
            </TopBarMenuItem>,
          ];
        })}
      </TopBarMenu>
      <SaveSystemDialog open={saveOpen} onOpenChange={setSaveOpen} />
      <BundleImportDialog open={importBundleOpen} onOpenChange={setImportBundleOpen} />
      <LazyMount when={pmuOpen} onLoadFailed={() => setPmuOpen(false)}>
        <PmuPlacementDialog open={pmuOpen} onOpenChange={setPmuOpen} />
      </LazyMount>
      <LazyMount when={profileOpen} onLoadFailed={() => setProfileOpen(false)}>
        <ProfileImportDialog open={profileOpen} onOpenChange={setProfileOpen} />
      </LazyMount>
    </>
  );
}
