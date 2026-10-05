/**
 * TopBarMoreMenu: the "..." button at the right end of the top bar, which holds the
 * controls that no longer fit inline once the window is narrower than
 * `topBarLayout.ts` says. It is not there on a window wide enough for them.
 *
 * Its items are commands of the shared registry, run through the same `action` as the
 * inline control and the palette, and each names the key it is bound to. The inline
 * controls it stands in for are hidden by CSS, so each item is the only copy on screen.
 */
import { TopBarMenu, TopBarMenuItem } from './TopBarMenu';
import { MORE_BELOW_MEDIUM, MORE_BELOW_NARROW, MORE_BELOW_WIDE } from './topBarLayout';
import { useCommandRegistry } from '@/lib/commands';
import { shortcutLabel } from '@/lib/shortcutFormatter';
import { useCaseStore } from '@/store/case';
import { useRunsStore } from '@/store/runs';
import { useSessionStore } from '@/store/session';
import { useUiStore } from '@/store/ui';
import { useUnitsStore } from '@/store/units';

/** Three dots in a row, in the hand-inlined style of the other top bar glyphs. */
function MoreGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" className={className}>
      <circle cx="5" cy="12" r="1.75" />
      <circle cx="12" cy="12" r="1.75" />
      <circle cx="19" cy="12" r="1.75" />
    </svg>
  );
}

/**
 * The commands in the menu, in order. `pane` marks the ones that stand in for a pane
 * toggle, which stays inline down to a narrower window than Search, Theme and History.
 * The Labels and Units toggles come after them, as items that show their state.
 */
const MORE_ITEMS: ReadonlyArray<{ id: string; pane?: true }> = [
  { id: 'help.command-palette' },
  { id: 'navigation.history' },
  { id: 'help.dark-mode' },
  { id: 'view.toggleLeftSidebar', pane: true },
  { id: 'view.toggleRightInspector', pane: true },
  { id: 'view.toggleBottomDrawer', pane: true },
  { id: 'view.toggle-results-view', pane: true },
];

export function TopBarMoreMenu() {
  const commands = useCommandRegistry();
  // History is off until a case is loaded or there are runs to list (the ones
  // kept from before a reload), as its inline button is.
  const sessionId = useSessionStore((s) => s.sessionId);
  const caseSelection = useCaseStore((s) => s.selection);
  const hasRuns = useRunsStore((s) => Object.keys(s.runs).length > 0);
  const historyOn = (sessionId !== null && caseSelection !== null) || hasRuns;
  // The two display toggles that stand in the bar below the narrowest width.
  const hideLabels = useUiStore((s) => s.hideLabels);
  const toggleHideLabels = useUiStore((s) => s.toggleHideLabels);
  const unitMode = useUnitsStore((s) => s.mode);
  const setUnitMode = useUnitsStore((s) => s.setMode);

  // A flat list, not a Fragment per item: TopBarMenu closes the menu on a click by
  // cloning the items that are its direct children.
  const items = MORE_ITEMS.flatMap(({ id, pane }) => {
    const cmd = commands.find((c) => c.id === id);
    if (cmd === undefined) return [];
    return [
      <TopBarMenuItem
        key={id}
        testId={`topbar-menu-more-${id}`}
        title={cmd.description}
        shortcut={cmd.shortcut ? shortcutLabel(cmd.shortcut) : undefined}
        disabled={id === 'navigation.history' && !historyOn}
        className={pane ? MORE_BELOW_MEDIUM : undefined}
        onClick={() => cmd.action()}
      >
        {cmd.label}
      </TopBarMenuItem>,
    ];
  });

  items.push(
    <TopBarMenuItem
      key="hide-labels"
      testId="topbar-menu-more-hide-labels"
      checked={hideLabels}
      title="Hide the voltage, angle and flow labels on the diagram. The limit colours stay."
      className={MORE_BELOW_NARROW}
      onClick={toggleHideLabels}
    >
      Hide labels
    </TopBarMenuItem>,
    <TopBarMenuItem
      key="actual-units"
      testId="topbar-menu-more-actual-units"
      checked={unitMode === 'actual'}
      title="Read bus voltage in kV and generator speed in Hz, where the case gives their bases, instead of per unit."
      className={MORE_BELOW_NARROW}
      onClick={() => setUnitMode(unitMode === 'actual' ? 'pu' : 'actual')}
    >
      Actual units
    </TopBarMenuItem>,
  );

  return (
    <TopBarMenu
      label="More"
      icon={MoreGlyph}
      iconOnly
      alignEnd
      testId="topbar-menu-more"
      triggerClassName={MORE_BELOW_WIDE}
    >
      {items}
    </TopBarMenu>
  );
}
