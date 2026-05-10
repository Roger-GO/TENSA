/**
 * ExportMenu — TopBar dropdown grouping the workspace-wide export
 * actions.
 *
 * Unit 9 of the v2.0 polish plan refactored this file to derive its
 * items from the shared command registry (`useCommandRegistry()`).
 * Both the menu and the ⌘K palette read the same registry.
 *
 * Note on naming: there's an existing `<ExportMenu />` at
 * `components/export/ExportMenu.tsx` which is the per-panel
 * (chart/table/SLD) export trigger. This one lives under
 * `components/shell/` and is the TopBar-level one.
 */
import { TopBarMenu, TopBarMenuItem, TopBarMenuSeparator } from './TopBarMenu';
import { useCommandRegistry } from '@/lib/commands';

const TESTID_BY_ID: Record<string, string> = {
  'export.bundle': 'topbar-menu-export-bundle',
  'export.snapshot': 'topbar-menu-export-snapshot',
};

export function ExportMenu() {
  const commands = useCommandRegistry();
  const exportCommands = commands.filter((c) => c.group === 'export');

  return (
    <TopBarMenu label="Export" testId="topbar-menu-export" alignEnd>
      {exportCommands.map((cmd, idx) => (
        <div key={cmd.id}>
          {/* Separator between bundle and snapshot to match the
              pre-Unit-9 visual grouping. */}
          {cmd.id === 'export.snapshot' && idx > 0 ? <TopBarMenuSeparator /> : null}
          <TopBarMenuItem
            testId={TESTID_BY_ID[cmd.id] ?? `topbar-menu-export-${cmd.id}`}
            onClick={cmd.action}
          >
            {cmd.label}
          </TopBarMenuItem>
        </div>
      ))}
      {exportCommands.length === 0 ? (
        <div className="text-muted-foreground px-2 py-1.5 text-xs">No exports available.</div>
      ) : null}
    </TopBarMenu>
  );
}
