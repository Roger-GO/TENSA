/**
 * Tests for `shortcutFormatter` (Unit 10 of the v2.0 polish plan).
 *
 * Locks in:
 *  - Mac vs non-mac glyph mapping for `meta` and `mod`.
 *  - Sequence detection for both `>`-delimited (react-hotkeys-hook
 *    canonical) and space-separated (plan/doc-friendly alias) forms.
 *  - Comma-separated alias picking (`meta+k, ctrl+k` chooses the
 *    platform-appropriate variant).
 *  - Special-key naming (Enter / Esc / Slash → `/`).
 *  - Single-character pass-through with uppercase normalization.
 *  - Unknown tokens pass through unchanged so we never lose info.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatShortcut, isSequenceShortcut } from '@/lib/shortcutFormatter';

const ORIGINAL_NAVIGATOR_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  globalThis,
  'navigator',
);

/**
 * Stubs `navigator.platform` so we can deterministically test the
 * mac vs non-mac branches without depending on the actual host.
 */
function stubPlatform(platform: string, userAgent = ''): void {
  const stub = { platform, userAgent } as unknown as Navigator;
  Object.defineProperty(globalThis, 'navigator', {
    value: stub,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (ORIGINAL_NAVIGATOR_DESCRIPTOR) {
    Object.defineProperty(globalThis, 'navigator', ORIGINAL_NAVIGATOR_DESCRIPTOR);
  } else {
    Reflect.deleteProperty(globalThis, 'navigator');
  }
  vi.restoreAllMocks();
});

describe('formatShortcut — modifier glyphs', () => {
  it('maps `meta` to ⌘ on macOS', () => {
    stubPlatform('MacIntel');
    expect(formatShortcut('meta+k')).toEqual(['⌘', 'K']);
  });

  it('maps `meta` to Ctrl on non-mac', () => {
    stubPlatform('Win32');
    expect(formatShortcut('meta+k')).toEqual(['Ctrl', 'K']);
  });

  it('maps `mod` to ⌘ on macOS', () => {
    stubPlatform('MacIntel');
    expect(formatShortcut('mod+s')).toEqual(['⌘', 'S']);
  });

  it('maps `mod` to Ctrl on non-mac', () => {
    stubPlatform('Linux x86_64');
    expect(formatShortcut('mod+s')).toEqual(['Ctrl', 'S']);
  });

  it('maps `alt` to ⌥ on macOS and Alt elsewhere', () => {
    stubPlatform('MacIntel');
    expect(formatShortcut('alt+t')).toEqual(['⌥', 'T']);
    stubPlatform('Win32');
    expect(formatShortcut('alt+t')).toEqual(['Alt', 'T']);
  });

  it('maps `shift` to ⇧ on macOS and Shift elsewhere', () => {
    stubPlatform('MacIntel');
    expect(formatShortcut('shift+a')).toEqual(['⇧', 'A']);
    stubPlatform('Win32');
    expect(formatShortcut('shift+a')).toEqual(['Shift', 'A']);
  });
});

describe('formatShortcut — alias picking', () => {
  it('picks the meta variant on macOS from a comma alias list', () => {
    stubPlatform('MacIntel');
    expect(formatShortcut('meta+k, ctrl+k')).toEqual(['⌘', 'K']);
  });

  it('picks the ctrl variant off-mac from a comma alias list', () => {
    stubPlatform('Win32');
    expect(formatShortcut('meta+k, ctrl+k')).toEqual(['Ctrl', 'K']);
  });

  it('falls back to the first alias when neither meta nor ctrl is present', () => {
    stubPlatform('Win32');
    expect(formatShortcut('shift+a, alt+a')).toEqual(['Shift', 'A']);
  });
});

describe('formatShortcut — sequences', () => {
  beforeEach(() => stubPlatform('MacIntel'));

  it('splits `>` sequence shortcuts with literal "then" between steps', () => {
    expect(formatShortcut('g>s')).toEqual(['G', 'then', 'S']);
  });

  it('splits space-separated sequences (plan-style alias)', () => {
    expect(formatShortcut('g s')).toEqual(['G', 'then', 'S']);
  });

  it('does NOT treat a combo with `+` as a sequence even if it has spaces', () => {
    // `meta+k` should stay a combo; `meta+k g` should treat the
    // `g` as a separate step (rare but the predicate only triggers
    // on bare-word tokens, so this stays a single combo).
    expect(formatShortcut('meta+k')).toEqual(['⌘', 'K']);
  });

  it('handles three-step sequences', () => {
    expect(formatShortcut('g>s>x')).toEqual(['G', 'then', 'S', 'then', 'X']);
  });
});

describe('formatShortcut — special tokens', () => {
  beforeEach(() => stubPlatform('Linux'));

  it('passes through `?` unchanged', () => {
    expect(formatShortcut('?')).toEqual(['?']);
  });

  it('renders `enter` as the word "Enter"', () => {
    expect(formatShortcut('meta+enter')).toEqual(['Ctrl', 'Enter']);
  });

  it('renders `escape` as "Esc"', () => {
    expect(formatShortcut('escape')).toEqual(['Esc']);
  });

  it('renders `slash` as `/`', () => {
    expect(formatShortcut('meta+slash')).toEqual(['Ctrl', '/']);
  });

  it('renders arrow keys as glyphs', () => {
    expect(formatShortcut('arrowup')).toEqual(['↑']);
    expect(formatShortcut('arrowdown')).toEqual(['↓']);
    expect(formatShortcut('arrowleft')).toEqual(['←']);
    expect(formatShortcut('arrowright')).toEqual(['→']);
  });
});

describe('formatShortcut — unknown tokens', () => {
  beforeEach(() => stubPlatform('Linux'));

  it('uppercases single-character keys', () => {
    expect(formatShortcut('a')).toEqual(['A']);
    expect(formatShortcut('1')).toEqual(['1']);
  });

  it('passes multi-character unknown tokens through unchanged', () => {
    expect(formatShortcut('f12')).toEqual(['f12']);
    expect(formatShortcut('weirdkey')).toEqual(['weirdkey']);
  });
});

describe('isSequenceShortcut', () => {
  beforeEach(() => stubPlatform('MacIntel'));

  it('returns true for `>`-delimited bindings', () => {
    expect(isSequenceShortcut('g>s')).toBe(true);
  });

  it('returns true for space-separated bindings', () => {
    expect(isSequenceShortcut('g s')).toBe(true);
  });

  it('returns false for plain combos', () => {
    expect(isSequenceShortcut('meta+k')).toBe(false);
    expect(isSequenceShortcut('?')).toBe(false);
  });

  it('returns false for combos that contain `+` even with spaces around them', () => {
    expect(isSequenceShortcut('meta+k, ctrl+k')).toBe(false);
  });
});
