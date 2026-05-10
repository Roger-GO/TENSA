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
};

/**
 * Bindings managed directly at AppShell (so they can opt into
 * `enableOnFormTags` overrides that this generic hook can't apply
 * uniformly). `<GlobalShortcuts />` skips these so the same combo
 * doesn't fire two callbacks per keypress.
 *
 * Keep this list in sync with the `useHotkeys(...)` calls inside
 * `AppShell.tsx`.
 */
const APPSHELL_MANAGED_BINDINGS: ReadonlySet<string> = new Set<string>(['meta+k, ctrl+k', '?']);

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
    </>
  );
}
