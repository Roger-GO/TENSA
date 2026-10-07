/**
 * ShortcutCheatsheet — global ?-launched modal listing every command
 * that has a keyboard binding (Unit 10 of the v2.0 polish plan).
 *
 * The list is derived from `useCommandRegistry()` — the same source of
 * truth that wires the actual hotkeys via `useGlobalShortcuts`. There
 * is no manual table of bindings to keep in sync; if the registry
 * gains a new command with a `shortcut`, the cheatsheet picks it up
 * on the next render.
 *
 * Layout: rows grouped by `command.group`, ordered per
 * `COMMAND_GROUP_ORDER`. Each row renders the command label on the
 * left and the shortcut as a sequence of `<kbd>` chips on the right.
 *
 * After the commands comes what the diagram answers to that is no
 * command and has no entry in the registry (`DIAGRAM_GESTURES`): how a
 * line is moved by hand, with the mouse and with the keys. Nothing on
 * the diagram shows it until a line is clicked, so it is listed here.
 *
 * Close: Escape (Radix default), backdrop click. The `?` hotkey that
 * opens the cheatsheet is registered at AppShell, not here.
 */
import * as DialogPrimitive from '@radix-ui/react-dialog';

import { cn } from '@/lib/cn';
import {
  COMMAND_GROUP_ORDER,
  useCommandRegistry,
  type Command as CommandDef,
  type CommandGroup,
} from '@/lib/commands';
import { formatShortcut } from '@/lib/shortcutFormatter';
import { useShortcutCheatsheetStore } from '@/store/shortcutCheatsheet';

/** Heading text rendered above each group section. */
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
 * How a line of the diagram is moved by hand: what is done, and with what.
 * A row is a gesture of the pointer, a key, or both.
 */
const DIAGRAM_GESTURES: readonly { id: string; label: string; keys: readonly string[] }[] = [
  {
    id: 'pick',
    label: 'Pick a line, a transformer or a device connector, to move its route by hand',
    keys: ['Click'],
  },
  { id: 'slide', label: 'Slide a run of the picked line', keys: ['Drag', 'or', '← → ↑ ↓'] },
  {
    id: 'bend',
    label: 'Move a bend (the square handles)',
    keys: ['Drag', 'or', '← → ↑ ↓'],
  },
  {
    id: 'alone',
    label: 'Move a bend alone, leaving its runs at an angle',
    keys: ['Alt', 'or', 'Shift', 'Drag'],
  },
  {
    id: 'add',
    label: 'Add a bend to a run',
    keys: ['Double-click', 'or', 'Enter'],
  },
  {
    id: 'pull',
    label: 'Pull a new bend out of a run (the round + handles)',
    keys: ['Drag'],
  },
  {
    id: 'remove',
    label: 'Remove a bend',
    keys: ['Double-click', 'or', 'Delete'],
  },
  { id: 'steps', label: 'Bigger steps with the arrow keys', keys: ['Shift'] },
  { id: 'done', label: 'Let go of the line', keys: ['Esc'] },
];

export function ShortcutCheatsheet() {
  const open = useShortcutCheatsheetStore((s) => s.open);
  const closeCheatsheet = useShortcutCheatsheetStore((s) => s.closeCheatsheet);
  const commands = useCommandRegistry();

  // Only commands that declare a shortcut get a row — a command
  // without a binding has nothing useful to show on a "keyboard
  // shortcuts" surface.
  const grouped = bucketByGroup(
    commands.filter((c) => typeof c.shortcut === 'string' && c.shortcut.length > 0),
  );

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) closeCheatsheet();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-testid="shortcut-cheatsheet-overlay"
          className={cn(
            'fixed inset-0 z-50',
            'bg-background/80 backdrop-blur-sm',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
          )}
        />
        <DialogPrimitive.Content
          data-testid="shortcut-cheatsheet"
          aria-label="Keyboard shortcuts"
          className={cn(
            'fixed top-[10vh] left-1/2 z-50 w-full max-w-2xl -translate-x-1/2',
            'bg-popover text-popover-foreground',
            'border-border rounded-[var(--radius-lg)] border shadow-lg',
            'duration-[var(--duration-base)] ease-[var(--ease-out-spring)]',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
            'data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95',
            'focus:outline-none',
          )}
        >
          <div className="border-border flex items-center justify-between border-b px-4 py-3">
            <DialogPrimitive.Title className="text-base font-semibold tracking-tight">
              Keyboard shortcuts
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <span>Press</span>
              <kbd
                className={cn(
                  'inline-flex h-5 min-w-[1.5rem] items-center justify-center px-1.5',
                  'rounded border font-mono text-[10px]',
                  'border-border bg-muted text-foreground',
                )}
              >
                Esc
              </kbd>
              <span>to close</span>
            </DialogPrimitive.Description>
          </div>

          <div
            className="flex max-h-[70vh] flex-col gap-4 overflow-auto p-4"
            data-testid="shortcut-cheatsheet-list"
          >
            {COMMAND_GROUP_ORDER.map((group) => {
              const items = grouped[group];
              if (!items || items.length === 0) return null;
              return (
                <section
                  key={group}
                  data-testid={`shortcut-cheatsheet-group-${group}`}
                  className="flex flex-col gap-1"
                >
                  <h3 className="text-muted-foreground px-1 text-[10px] font-medium tracking-wide uppercase">
                    {GROUP_HEADINGS[group]}
                  </h3>
                  <ul className="flex flex-col">
                    {items.map((cmd) => (
                      <li
                        key={cmd.id}
                        data-testid={`shortcut-cheatsheet-row-${cmd.id}`}
                        className={cn(
                          'flex items-center justify-between gap-3',
                          'rounded-[var(--radius-sm)] px-2 py-1.5',
                          'hover:bg-muted/40',
                        )}
                      >
                        <span className="text-sm">{cmd.label}</span>
                        <ShortcutChips binding={cmd.shortcut as string} />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            <section
              data-testid="shortcut-cheatsheet-group-diagram"
              className="flex flex-col gap-1"
            >
              <h3 className="text-muted-foreground px-1 text-[10px] font-medium tracking-wide uppercase">
                Diagram: moving a line by hand
              </h3>
              <ul className="flex flex-col">
                {DIAGRAM_GESTURES.map((gesture) => (
                  <li
                    key={gesture.id}
                    data-testid={`shortcut-cheatsheet-gesture-${gesture.id}`}
                    className={cn(
                      'flex items-center justify-between gap-3',
                      'rounded-[var(--radius-sm)] px-2 py-1.5',
                      'hover:bg-muted/40',
                    )}
                  >
                    <span className="text-sm">{gesture.label}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {gesture.keys.map((key, i) =>
                        key === 'or' ? (
                          <span key={i} className="text-muted-foreground/80 text-[11px]">
                            or
                          </span>
                        ) : (
                          <kbd
                            key={i}
                            className={cn(
                              'inline-flex h-5 min-w-[1.5rem] items-center justify-center px-1.5',
                              'rounded border font-mono text-[10px] whitespace-nowrap',
                              'border-border bg-muted text-foreground',
                            )}
                          >
                            {key}
                          </kbd>
                        ),
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground px-2 text-xs leading-snug">
                A line you moved is left as it is by Tidy diagram. Reset route, on the bar above the
                diagram while the line is picked, gives it back to the automatic routing, and Reset
                manual routes in the Arrange menu does so for all of them.
              </p>
            </section>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Render a binding (e.g. "meta+k, ctrl+k", "g>s", "?") as a row of
 * `<kbd>` chips with literal "then" text inserted between sequence
 * steps for readability.
 */
function ShortcutChips({ binding }: { binding: string }) {
  const tokens = formatShortcut(binding);
  return (
    <span className="flex items-center gap-1" data-testid="shortcut-chips">
      {tokens.map((tok, idx) =>
        tok === 'then' ? (
          <span key={idx} className="text-muted-foreground/80 text-[11px]">
            then
          </span>
        ) : (
          <kbd
            key={idx}
            className={cn(
              'inline-flex h-5 min-w-[1.5rem] items-center justify-center px-1.5',
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
