/**
 * ExportMenu — TopBar dropdown grouping the workspace-wide export
 * actions.
 *
 * Unit 9 of the v2.0 polish plan refactored this file to derive its
 * items from the shared command registry (`useMenuCommands()`).
 * Both the menu and the ⌘K palette read the same registry.
 *
 * Export bundle and Save snapshot open their dialogs; Export HTML report
 * saves a file straight away (`lib/saveHtmlReport.ts`). Reports, which opens
 * the dialog with ANDES's plain-text reports, is a Workspace command and is
 * listed here as well, under the HTML report: a report is something to take
 * out of the app, and this is the menu a first-time user opens to find one.
 *
 * Note on naming: there's an existing `<ExportMenu />` at
 * `components/export/ExportMenu.tsx` which is the per-panel
 * (chart/table/SLD) export trigger. This one lives under
 * `components/shell/` and is the TopBar-level one.
 */
import { TopBarMenu, TopBarMenuItem, TopBarMenuSeparator } from './TopBarMenu';
import { useMenuCommands } from '@/lib/commands';

const TESTID_BY_ID: Record<string, string> = {
  'export.bundle': 'topbar-menu-export-bundle',
  'export.snapshot': 'topbar-menu-export-snapshot',
  'export.html-report': 'topbar-menu-export-html-report',
  'workspace.report': 'topbar-menu-export-reports',
};

/** The items a rule is drawn above: each starts a group of its own. */
const SEPARATED: ReadonlySet<string> = new Set(['export.snapshot', 'export.html-report']);

export function ExportMenu() {
  // The menu's own list: a command that cannot run yet but says why (the HTML
  // report before there is a result) is kept, greyed out, with its reason.
  const commands = useMenuCommands();
  const exportCommands = commands.filter((c) => c.group === 'export');
  const reports = commands.find((c) => c.id === 'workspace.report');
  if (reports !== undefined) exportCommands.push(reports);

  return (
    <TopBarMenu label="Export" testId="topbar-menu-export" alignEnd>
      {/* A flat list, not a wrapper per item: TopBarMenu closes the menu on a
          click by cloning the items that are its direct children. */}
      {exportCommands.flatMap((cmd, idx) => [
        ...(SEPARATED.has(cmd.id) && idx > 0
          ? [<TopBarMenuSeparator key={`${cmd.id}-separator`} />]
          : []),
        <TopBarMenuItem
          key={cmd.id}
          testId={TESTID_BY_ID[cmd.id] ?? `topbar-menu-export-${cmd.id}`}
          title={cmd.description}
          unavailableReason={cmd.unavailable ?? undefined}
          onClick={cmd.action}
        >
          {cmd.label}
        </TopBarMenuItem>,
      ])}
      {exportCommands.length === 0 ? (
        <div className="text-muted-foreground px-2 py-1.5 text-xs">No exports available.</div>
      ) : null}
    </TopBarMenu>
  );
}
