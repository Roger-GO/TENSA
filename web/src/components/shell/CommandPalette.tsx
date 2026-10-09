/**
 * CommandPalette — global ⌘K-launched search palette (Unit 9 of the
 * v2.0 polish plan).
 *
 * Linear-style overlay: a Radix Dialog hosts cmdk's `<Command>`
 * primitive; an input row sits at the top, a grouped list of every
 * active command from `useCommandRegistry()` sits below. Typing
 * filters via cmdk's built-in fuzzy matcher (with synonym keywords
 * forwarded per command), arrow keys move selection, Enter activates,
 * Escape / backdrop-click closes.
 *
 * Why Radix Dialog (rather than a bare div + portal):
 *
 * - Focus trap inside the palette.
 * - Outside-click-to-close + Escape-to-close.
 * - `aria-modal` + label wiring for screen readers.
 *
 * Where the focus goes when it closes is the palette's own (`focusOnClose`).
 * Radix hands the focus of a dialog back to its trigger, and the palette
 * has none (it is opened by a key, a button of the top bar or a command), so
 * every command and every Escape left the focus on `<body>`: the next Tab
 * started from the top of the page, and a screen reader lost its place. On
 * close the focus goes to what the command points at (`Command.focusAfter`,
 * the tab a sidebar command opened), else back to what had it when the
 * palette opened, else to the palette's button in the top bar, or to the
 * More menu that holds it in a narrower window. What a command itself opened
 * (a dialog, a form with the cursor in it) keeps the focus, and when such a
 * dialog closes the focus goes where it would have gone without it: the
 * dialog would hand it back to the palette, which is gone by then.
 *
 * Per AGENTS.md "When in doubt, ask whether the action is destructive
 * — palette = navigation, but is full-screen and benefits from focus
 * trap." Same reasoning the snapshot dialogs use.
 *
 * The component itself is unconditional in the React tree (mounted
 * once at AppShell), but the heavy `<Command>` body only renders when
 * the dialog is open — cmdk does its own filter bookkeeping on every
 * render, and there's no point paying for it while closed.
 */
import { useCallback, useRef } from 'react';
import { Command as CmdkCommand } from 'cmdk';
import * as DialogPrimitive from '@radix-ui/react-dialog';

import { cn } from '@/lib/cn';
import {
  COMMAND_GROUP_ORDER,
  useCommandRegistry,
  type Command as CommandDef,
  type CommandGroup,
} from '@/lib/commands';
import { formatShortcut } from '@/lib/shortcutFormatter';
import { useCommandPaletteStore } from '@/store/commandPalette';
import { OpenCasePage } from './OpenCasePage';

/** Heading text rendered above each group section in the palette. */
const GROUP_HEADINGS: Record<CommandGroup, string> = {
  workspace: 'Workspace',
  edit: 'Edit',
  run: 'Run',
  export: 'Export',
  view: 'View',
  navigation: 'Navigation',
  help: 'Help',
};

/**
 * Call `then` once the dialog `dialog` has left the page, if the focus has
 * fallen to `<body>` by then: a dialog that a command opened hands the focus
 * back to what had it as it opened, which was the palette.
 */
function whenGone(dialog: Element, then: () => void): void {
  const observer = new MutationObserver(() => {
    if (dialog.isConnected) return;
    observer.disconnect();
    // After the dialog's own hand-back, which Radix makes a tick later.
    window.setTimeout(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) then();
    }, 0);
  });
  // A dialog is drawn in a portal, a child of the body.
  observer.observe(document.body, { childList: true });
  if (dialog.parentNode !== null && dialog.parentNode !== document.body) {
    observer.observe(dialog.parentNode, { childList: true });
  }
}

export function CommandPalette() {
  const open = useCommandPaletteStore((s) => s.open);
  const page = useCommandPaletteStore((s) => s.page);
  const closePalette = useCommandPaletteStore((s) => s.closePalette);
  const commands = useCommandRegistry();

  // What had the keyboard focus when the palette opened, and the command it
  // ran, for where the focus goes when it closes.
  const openerRef = useRef<HTMLElement | null>(null);
  const ranRef = useRef<CommandDef | null>(null);
  const focusOnClose = useCallback((event: Event) => {
    // Not Radix's own answer, which is the trigger the palette does not have.
    event.preventDefault();
    const [ran, opener] = [ranRef.current, openerRef.current];
    ranRef.current = null;
    openerRef.current = null;
    // The first of these that takes the focus. One that is not shown cannot:
    // the palette's own button is in the More menu of a narrower top bar.
    const back = () => {
      for (const target of [
        ran?.focusAfter?.() ?? null,
        opener !== null && opener.isConnected ? opener : null,
        document.querySelector<HTMLElement>('[data-testid="command-palette-hint"]'),
        document.querySelector<HTMLElement>('[data-testid="topbar-menu-more-trigger"]'),
      ]) {
        if (target === null) continue;
        target.focus();
        if (document.activeElement === target) return;
      }
    };
    // Something the command opened has the focus, or is about to take it.
    const active = document.activeElement;
    const palette = event.target instanceof Node ? event.target : null;
    const taken =
      active instanceof HTMLElement &&
      active !== document.body &&
      active.isConnected &&
      !(palette?.contains(active) ?? false);
    if (taken) {
      const dialog = active.closest('[role="dialog"], [role="alertdialog"]');
      if (dialog !== null) whenGone(dialog, back);
      return;
    }
    if (document.querySelector('[role="dialog"][data-state="open"]') !== null) return;
    back();
  }, []);

  const handleSelect = useCallback(
    (command: CommandDef) => {
      // Run the action FIRST, then close. The action may itself open
      // another dialog (e.g., snapshot save) — closing the palette
      // first would race against the new dialog's mount inside the
      // same focus-trap teardown cycle on some browsers. A command that
      // moves the palette to another of its pages (Open case) leaves it open.
      ranRef.current = command;
      try {
        command.action();
      } finally {
        if (!command.keepPaletteOpen) closePalette();
      }
    },
    [closePalette],
  );

  // Bucket commands by group, preserving the registry's intra-group
  // order. Groups with zero active commands are skipped — cmdk would
  // hide an empty group anyway, but skipping at this layer keeps the
  // DOM smaller and the `Command.Empty` story clean.
  const grouped = bucketByGroup(commands);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) closePalette();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-testid="command-palette-overlay"
          className={cn(
            'fixed inset-0 z-50',
            'bg-background/80 backdrop-blur-sm',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
          )}
        />
        <DialogPrimitive.Content
          data-testid="command-palette"
          aria-label="Command palette"
          onOpenAutoFocus={() => {
            // Before the focus moves into the palette: what has it now.
            const active = document.activeElement;
            openerRef.current =
              active instanceof HTMLElement && active !== document.body ? active : null;
            ranRef.current = null;
          }}
          onCloseAutoFocus={focusOnClose}
          className={cn(
            // Pinned near the top so it doesn't fight the user's focal
            // line when typing — Linear's palette sits at ~15vh which
            // reads better than centred for a search surface.
            'fixed top-[15vh] left-1/2 z-50 w-full max-w-xl -translate-x-1/2',
            'bg-popover text-popover-foreground',
            'border-border rounded-[var(--radius-lg)] border shadow-lg',
            'duration-[var(--duration-base)] ease-[var(--ease-out-spring)]',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
            'data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95',
            'focus:outline-none',
          )}
        >
          {/* Visually-hidden title for the Dialog's a11y contract.
              Radix complains in dev if a Dialog has no `<DialogTitle>`. */}
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Search and run any application command.
          </DialogPrimitive.Description>

          {open && page === 'open-case' ? <OpenCasePage /> : null}
          {open && page === 'commands' ? (
            <CmdkCommand label="Command palette" loop className="flex max-h-[60vh] flex-col">
              <div className="border-border border-b">
                <CmdkCommand.Input
                  data-testid="command-palette-input"
                  placeholder="Search commands…"
                  className={cn(
                    'w-full bg-transparent px-3.5 py-3.5 text-sm',
                    'placeholder:text-muted-foreground/70',
                    'focus:outline-none',
                  )}
                />
              </div>

              <CmdkCommand.List className="flex-1 overflow-auto p-1">
                <CmdkCommand.Empty
                  data-testid="command-palette-empty"
                  className="text-muted-foreground px-3 py-6 text-center text-sm"
                >
                  No commands match.
                </CmdkCommand.Empty>

                {COMMAND_GROUP_ORDER.map((group) => {
                  const items = grouped[group];
                  if (!items || items.length === 0) return null;
                  return (
                    <CmdkCommand.Group
                      key={group}
                      heading={GROUP_HEADINGS[group]}
                      className={cn(
                        // cmdk renders the heading via `[cmdk-group-heading]`
                        // — target it for token-driven styling.
                        '[&_[cmdk-group-heading]]:text-muted-foreground',
                        '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1',
                        '[&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium',
                        '[&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:uppercase',
                      )}
                    >
                      {items.map((cmd) => (
                        <CmdkCommand.Item
                          key={cmd.id}
                          // `value` is what cmdk fuzzy-matches against. We
                          // include the id (for stable lookup) AND the
                          // label (so a short search string can hit the
                          // visible text). Synonyms come in via `keywords`.
                          value={`${cmd.id} ${cmd.label}`}
                          keywords={cmd.keywords}
                          onSelect={() => handleSelect(cmd)}
                          title={cmd.description}
                          data-testid={`command-palette-item-${cmd.id}`}
                          className={cn(
                            'flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-sm',
                            // cmdk uses `data-selected="true"` on the
                            // active item; reuse the menu's hover token.
                            'data-[selected=true]:bg-muted aria-selected:bg-muted',
                            'outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]',
                          )}
                        >
                          {cmd.icon ? (
                            <span
                              aria-hidden="true"
                              className="flex h-4 w-4 shrink-0 items-center justify-center"
                            >
                              {cmd.icon}
                            </span>
                          ) : (
                            <span aria-hidden="true" className="h-4 w-4 shrink-0" />
                          )}
                          <span className="flex-1 truncate">{cmd.label}</span>
                          {cmd.shortcut ? <PaletteShortcutHint binding={cmd.shortcut} /> : null}
                        </CmdkCommand.Item>
                      ))}
                    </CmdkCommand.Group>
                  );
                })}
              </CmdkCommand.List>
            </CmdkCommand>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Right-aligned shortcut hint for a palette row. Mirrors the
 * cheatsheet's chip style at smaller weight so the palette row keeps
 * its compact line height. Sequence shortcuts (e.g., "g s") render the
 * literal "then" between steps.
 */
function PaletteShortcutHint({ binding }: { binding: string }) {
  const tokens = formatShortcut(binding);
  return (
    <span className="ml-2 flex items-center gap-1">
      {tokens.map((tok, idx) =>
        tok === 'then' ? (
          <span key={idx} className="text-muted-foreground/80 text-[10px]">
            then
          </span>
        ) : (
          <kbd
            key={idx}
            className={cn(
              'inline-flex h-4 min-w-[1.25rem] items-center justify-center px-1',
              'rounded border font-mono text-[10px]',
              'border-border bg-muted text-foreground',
            )}
          >
            {tok}
          </kbd>
        ),
      )}
    </span>
  );
}

function bucketByGroup(commands: readonly CommandDef[]): Record<CommandGroup, CommandDef[]> {
  const out: Record<CommandGroup, CommandDef[]> = {
    workspace: [],
    edit: [],
    run: [],
    export: [],
    view: [],
    navigation: [],
    help: [],
  };
  for (const cmd of commands) {
    out[cmd.group].push(cmd);
  }
  return out;
}
