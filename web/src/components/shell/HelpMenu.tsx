/**
 * HelpMenu: the top bar's "?" button. Its menu opens the keyboard shortcuts,
 * and the two parts of that list that are about the diagram and no key
 * (moving a line by hand, connecting by a drag), each under its own name,
 * since nobody looks for a drag under "Keyboard shortcuts". It
 * links to the API reference this server serves, the API map for agents,
 * ANDES's model docs and the repository, and says which TENSA and ANDES
 * versions the server runs (read from the API, so it is the server's version
 * and not the bundle's).
 *
 * Icon-only so it costs the top bar a button's width and no word: the top bar
 * already scrolls at narrow widths. The About block is part of the menu and not
 * a dialog, since it is a few lines and has nothing to confirm.
 */
import {
  TopBarMenu,
  TopBarMenuItem,
  TopBarMenuLabel,
  TopBarMenuLink,
  TopBarMenuSeparator,
} from './TopBarMenu';
import { useVersionInfo } from '@/api/queries';
import { HELP_LINKS } from '@/lib/helpLinks';
import { SHORTCUTS } from '@/lib/shortcuts';
import { shortcutLabel } from '@/lib/shortcutFormatter';
import { useShortcutCheatsheetStore } from '@/store/shortcutCheatsheet';

/** Question mark in a circle, in the same hand-inlined style as the other top bar glyphs. */
function HelpGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/**
 * The versions the server runs. Mounted with the menu's content, so the
 * request goes out the first time the menu opens, and a failure (an older
 * server without the route, a dropped connection) reads as "unavailable" in
 * the rows rather than as an error toast over a help menu.
 */
function AboutBlock() {
  const { data, isPending, isError } = useVersionInfo();
  const value = (version: string | undefined): string => {
    if (isPending) return '…';
    if (isError || version === undefined) return 'unavailable';
    return version;
  };
  return (
    <div role="group" aria-label="About TENSA" data-testid="help-about" className="px-2 py-1.5">
      <div className="text-xs font-medium">About TENSA</div>
      <dl className="text-muted-foreground mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt>TENSA</dt>
        <dd data-testid="help-about-tensa" className="text-foreground font-mono">
          {value(data?.tensa)}
        </dd>
        <dt>ANDES</dt>
        <dd data-testid="help-about-andes" className="text-foreground font-mono">
          {value(data?.andes)}
        </dd>
      </dl>
    </div>
  );
}

export function HelpMenu() {
  const toggleCheatsheet = useShortcutCheatsheetStore((s) => s.toggleCheatsheet);
  const openCheatsheet = useShortcutCheatsheetStore((s) => s.openCheatsheet);
  return (
    <TopBarMenu label="Help" icon={HelpGlyph} iconOnly alignEnd testId="topbar-menu-help">
      <TopBarMenuItem
        testId="topbar-menu-help-shortcuts"
        shortcut={shortcutLabel(SHORTCUTS.cheatsheet)}
        onClick={toggleCheatsheet}
      >
        Keyboard shortcuts
      </TopBarMenuItem>
      <TopBarMenuItem
        testId="topbar-menu-help-move-line"
        title="How a line of the diagram is picked and moved, with the mouse and with the keys."
        onClick={() => openCheatsheet('diagram')}
      >
        Moving a line by hand
      </TopBarMenuItem>
      <TopBarMenuItem
        testId="topbar-menu-help-connect"
        title="How a component is put on a bus, a line drawn and a device moved to another bus."
        onClick={() => openCheatsheet('connect')}
      >
        Connecting on the diagram
      </TopBarMenuItem>
      <TopBarMenuSeparator />
      <TopBarMenuLabel>Documentation</TopBarMenuLabel>
      {HELP_LINKS.map((link) => (
        <TopBarMenuLink
          key={link.id}
          href={link.href}
          hint={link.hint}
          testId={`topbar-menu-help-link-${link.id}`}
        >
          {link.label}
        </TopBarMenuLink>
      ))}
      <TopBarMenuSeparator />
      <AboutBlock />
    </TopBarMenu>
  );
}
