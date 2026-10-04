/**
 * useGlobalShortcuts / GlobalShortcuts — central registrar that mounts
 * every command with a `shortcut` field as a global keybinding (Unit 10
 * of the v2.0 polish plan).
 *
 * The component registry (`useCommandRegistry()`) is the single source
 * of truth: any command that declares `shortcut` here gets a working
 * keybinding without the AppShell having to know about it.
 *
 * Mount EXACTLY ONCE — at AppShell. Mounting twice would register
 * each binding twice and the user would see duplicate fires per
 * keypress.
 *
 * Sequences: react-hotkeys-hook supports sequences natively via the
 * `>`-delimited key syntax (configured by `sequenceSplitKey`, default
 * `>`). We pass `sequenceTimeoutMs: 1000` so "g s" resets if the second
 * key arrives more than a second later — matches the plan's "1s
 * timeout" target.
 *
 * Editable-element handling: every binding inherits the project-wide
 * `enableOnFormTags: false` default from `@/lib/useHotkeys`, so a user
 * typing into the snapshot-name input (or any other text field) won't
 * trigger a global shortcut. The single exception is ⌘K (the command
 * palette), which is registered separately at AppShell with an
 * explicit `enableOnFormTags: ['INPUT', 'TEXTAREA']` opt-in.
 *
 * Already-handled keys: a binding does not fire for a keydown something else
 * has already used (`event.defaultPrevented`). That is what keeps Esc, which
 * closes every dialog, menu and popover, from also aborting a run when it was
 * pressed to close one: Radix dismisses a layer on Esc and prevents the event's
 * default when it does, before this listener sees it.
 *
 * Browser keys: Ctrl/Cmd+S (Save Page) and Ctrl/Cmd+O (Open File) are keys the
 * browser acts on unless the page swallows them. They are bound here whether or
 * not their command is available, so a press with no case loaded does not fall
 * through to a file dialog the app has nothing to do with. They are swallowed from
 * any focused element too: a text field, or a control the lib takes for one (a
 * Radix toggle, a slider, a menu entry).
 *
 * Why a component (rather than a pure hook): React's rules-of-hooks
 * forbid calling `useHotkeys` inside a `.map()` body. We work around
 * that by rendering one `<ShortcutBinder />` per active command — each
 * binder calls `useHotkeys` exactly once, and React's reconciler
 * mounts/unmounts binders cleanly when commands' `when()` gates flip.
 * The `useGlobalShortcuts()` alias is exported so callers that prefer
 * hook-shaped naming can opt in; both forms produce identical output.
 */
import type { ReactElement } from 'react';

import { useCommandRegistry } from '@/lib/commands';
import type { Command } from '@/lib/commands';
import { SHORTCUTS } from '@/lib/shortcuts';
import { toast } from '@/lib/toast';
import { useHotkeys } from '@/lib/useHotkeys';
import type { Options } from '@/lib/useHotkeys';

/** Stable options object — passed to every binding. */
const SHORTCUT_OPTS: Options = {
  // Sequence support: 1s window between successive keys before the
  // matcher resets. Mirrors Linear / Raycast feel.
  sequenceTimeoutMs: 1000,
  // Override per-binding when the binding wants to fire from inside
  // a form tag (the palette's ⌘K registration does this directly,
  // not through this hook).
  enableOnFormTags: false,
  enableOnContentEditable: false,
  preventDefault: true,
  // Checked before the lib prevents the default itself, so it only sees what
  // another listener (a Radix layer closing on Esc) did.
  ignoreEventWhen: (event) => event.defaultPrevented,
};

/**
 * Options for the browser keys: swallowed from inside a text field and from any
 * focused control. `true`, not a list of tag names, because the lib counts a
 * target with an interactive ARIA role (radio, slider, menuitem, option, ...) as a
 * form tag too, and skips the event without preventing its default: a list of
 * tags would let Save Page through once focus sits on a Radix toggle, the scrub
 * strip or an open menu.
 */
const BROWSER_KEY_OPTS: Options = {
  enableOnFormTags: true,
  enableOnContentEditable: false,
  preventDefault: true,
};

/**
 * The browser keys and what each does. The registry lists the command only
 * while it is available; `unavailable` is what a press says when it is not.
 * `allowInPalette` lets a press run from inside the open command palette, for
 * the key whose command works on the palette itself.
 */
const BROWSER_KEYS: ReadonlyArray<{
  binding: string;
  commandId: string;
  unavailable: string;
  allowInPalette: boolean;
}> = [
  {
    binding: SHORTCUTS.save,
    commandId: 'workspace.save',
    unavailable: 'Nothing to save yet. Load a case or build a system first.',
    allowInPalette: false,
  },
  {
    binding: SHORTCUTS.openCase,
    commandId: 'workspace.open-case',
    unavailable: 'Cannot open a case right now: there is no session. Try again in a moment.',
    allowInPalette: true,
  },
];

/**
 * Bindings managed directly at AppShell (so they can opt into
 * `enableOnFormTags` overrides that this generic hook can't apply
 * uniformly). `<GlobalShortcuts />` skips these so the same combo
 * doesn't fire two callbacks per keypress.
 *
 * Keep this list in sync with the `useHotkeys(...)` calls inside
 * `AppShell.tsx`.
 */
const APPSHELL_MANAGED_BINDINGS: ReadonlySet<string> = new Set<string>([
  SHORTCUTS.commandPalette,
  SHORTCUTS.cheatsheet,
  // Bound by `BrowserKeyBinder` below, which runs them with or without the command.
  ...BROWSER_KEYS.map((k) => k.binding),
]);

/**
 * Bridge component: each command-with-shortcut gets one of these,
 * which calls `useHotkeys` once per render.
 */
function ShortcutBinder({ binding, action }: { binding: string; action: () => void }) {
  useHotkeys(
    // react-hotkeys-hook's matcher takes the comma-aliased combo
    // string verbatim (e.g., "meta+k, ctrl+k") and registers each
    // alias internally, so we do not pre-split here.
    binding,
    (event) => {
      // Defensive preventDefault — `?` on Firefox triggers the
      // quick-find toolbar otherwise; ⌘K on Safari focuses the
      // location bar.
      event.preventDefault();
      action();
    },
    SHORTCUT_OPTS,
    [binding, action],
  );
  return null;
}

/** Any open dialog, and any but the command palette. */
const ANY_DIALOG = '[role="dialog"]';
const DIALOG_BUT_PALETTE = '[role="dialog"]:not([data-testid="command-palette"])';

/**
 * Binds a browser key (see the header). It always swallows the key; it runs
 * `command` when there is one, and says why not otherwise. A press that starts in
 * a dialog is only swallowed, so the key never stacks one dialog on another. The
 * command palette counts as a dialog too, except for a key with `allowInPalette`:
 * Ctrl/Cmd+O there switches the palette to Open case.
 */
function BrowserKeyBinder({
  binding,
  command,
  unavailable,
  allowInPalette,
}: {
  binding: string;
  command: Command | undefined;
  unavailable: string;
  allowInPalette: boolean;
}) {
  useHotkeys(
    binding,
    (event) => {
      const target = event.target;
      const dialog = allowInPalette ? DIALOG_BUT_PALETTE : ANY_DIALOG;
      if (target instanceof Element && target.closest(dialog) !== null) return;
      if (command) command.action();
      else toast.info(unavailable);
    },
    BROWSER_KEY_OPTS,
    [binding, command, allowInPalette],
  );
  return null;
}

/**
 * Hook + component dual. Reads the registry and renders one
 * `<ShortcutBinder />` per command-with-shortcut. The convention in
 * this codebase is to call this from JSX as `<GlobalShortcuts />` so
 * its identity is clearly "rendered child" rather than "side-effect
 * hook"; the `useGlobalShortcuts` filename keeps the plan's hook
 * naming intact.
 */
export function GlobalShortcuts(): ReactElement {
  const commands = useCommandRegistry();
  const bound = commands.filter(
    (c) =>
      typeof c.shortcut === 'string' &&
      c.shortcut.length > 0 &&
      // Skip bindings AppShell registers itself with bespoke options.
      !APPSHELL_MANAGED_BINDINGS.has(c.shortcut),
  );
  return (
    <>
      {bound.map((cmd) => (
        <ShortcutBinder key={cmd.id} binding={cmd.shortcut as string} action={cmd.action} />
      ))}
      {BROWSER_KEYS.map((key) => (
        <BrowserKeyBinder
          key={key.commandId}
          binding={key.binding}
          command={commands.find((c) => c.id === key.commandId)}
          unavailable={key.unavailable}
          allowInPalette={key.allowInPalette}
        />
      ))}
    </>
  );
}
