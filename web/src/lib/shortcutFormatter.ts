/**
 * shortcutFormatter — turns a `react-hotkeys-hook` key string into the
 * sequence of human-facing tokens we render as `<kbd>` chips.
 *
 * Inputs we have to handle:
 *   "meta+k"       → ["⌘", "K"]   on macOS
 *   "meta+k"       → ["Ctrl", "K"] on non-mac
 *   "meta+enter"   → ["⌘", "Enter"]
 *   "?"            → ["?"]
 *   "g>s"          → ["G", "then", "S"]      (sequence per react-hotkeys-hook)
 *   "g s"          → ["G", "then", "S"]      (legacy-friendly alias)
 *   "meta+slash"   → ["⌘", "/"]
 *   "ctrl+enter"   → ["Ctrl", "Enter"]       (already an explicit ctrl variant)
 *
 * The component registry stores the canonical `react-hotkeys-hook` key
 * string. Many bindings include both a meta and a ctrl alias separated
 * by a comma (e.g., "meta+k, ctrl+k"); we display only the variant
 * that matches the host platform so users don't see two redundant
 * chip groups.
 */

/** True when the host appears to be macOS (best-effort, SSR-safe). */
function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  // `navigator.platform` is deprecated but still the most reliable
  // indicator in jsdom + every browser we target. `userAgent` is the
  // documented fallback.
  const platform = navigator.platform ?? '';
  if (platform.toLowerCase().includes('mac')) return true;
  const ua = navigator.userAgent ?? '';
  return /Mac|iPhone|iPad|iPod/i.test(ua);
}

/** Pretty-print a single key token (post-modifier-split). */
function formatToken(token: string, mac: boolean): string {
  const t = token.trim().toLowerCase();
  switch (t) {
    case 'meta':
    case 'cmd':
    case 'command':
      return mac ? '⌘' : 'Ctrl';
    case 'mod':
      // react-hotkeys-hook's "mod" alias = ⌘ on mac, Ctrl elsewhere.
      return mac ? '⌘' : 'Ctrl';
    case 'ctrl':
    case 'control':
      return 'Ctrl';
    case 'alt':
    case 'option':
      return mac ? '⌥' : 'Alt';
    case 'shift':
      return mac ? '⇧' : 'Shift';
    case 'enter':
    case 'return':
      return 'Enter';
    case 'esc':
    case 'escape':
      return 'Esc';
    case 'space':
    case 'spacebar':
      return 'Space';
    case 'arrowup':
      return '↑';
    case 'arrowdown':
      return '↓';
    case 'arrowleft':
      return '←';
    case 'arrowright':
      return '→';
    case 'tab':
      return 'Tab';
    case 'backspace':
      return 'Backspace';
    case 'delete':
      return 'Del';
    case 'slash':
      return '/';
    case 'period':
    case 'dot':
      return '.';
    case 'comma':
      return ',';
    case 'minus':
    case 'dash':
      return '-';
    case 'equal':
    case 'equals':
      return '=';
    case '?':
      return '?';
    default:
      // Single chars uppercase; multi-char tokens we don't know about
      // pass through as-is so we never lose information.
      if (t.length === 1) return t.toUpperCase();
      return token;
  }
}

/** Pick the best alias for the host platform from a `meta+k, ctrl+k`-style string. */
function pickPlatformAlias(combo: string, mac: boolean): string {
  const aliases = combo
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (aliases.length <= 1) return combo.trim();
  // On mac prefer the alias mentioning "meta"; off-mac prefer "ctrl".
  // Fallback: the first alias.
  if (mac) {
    const m = aliases.find((a) => /\bmeta\b/i.test(a));
    if (m) return m;
  } else {
    const c = aliases.find((a) => /\bctrl\b/i.test(a));
    if (c) return c;
  }
  return aliases[0] ?? combo.trim();
}

/**
 * Format a `useHotkeys` key string into the array of tokens we render.
 *
 * Sequences (separated by `>` per react-hotkeys-hook, or by space as
 * a more readable alias) emit a literal `then` token between steps so
 * the `<kbd>` row visually reads as "G then S".
 *
 * Returns at minimum a single-element array — the empty input is
 * treated as a single empty token (so callers don't have to defend
 * against an empty render).
 */
export function formatShortcut(input: string): string[] {
  const mac = isMacPlatform();
  const picked = pickPlatformAlias(input, mac);
  // Detect sequences: react-hotkeys-hook uses `>`; we ALSO accept a
  // bare space so plan-style notation like "g s" round-trips.
  const sequenceParts = picked.includes('>')
    ? picked.split('>')
    : / /.test(picked.trim()) && !/\+/.test(picked.trim())
      ? picked.trim().split(/\s+/)
      : [picked];

  const out: string[] = [];
  sequenceParts.forEach((part, i) => {
    if (i > 0) out.push('then');
    const combo = part.trim();
    if (combo === '') {
      out.push('');
      return;
    }
    const tokens = combo.split('+').map((t) => formatToken(t, mac));
    out.push(...tokens);
  });
  return out;
}

/**
 * True when the binding is a sequence (e.g., "g>s" / "g s") rather
 * than a single combo. Useful for callers that want to render
 * sequences with extra spacing.
 */
export function isSequenceShortcut(input: string): boolean {
  const picked = pickPlatformAlias(input, isMacPlatform());
  if (picked.includes('>')) return true;
  const trimmed = picked.trim();
  return / /.test(trimmed) && !/\+/.test(trimmed);
}

// Re-exported only for tests — lets us stub/check platform handling
// without touching navigator directly.
export const __test__ = { isMacPlatform };
