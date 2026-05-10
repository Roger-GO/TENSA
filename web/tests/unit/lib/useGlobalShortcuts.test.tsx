/**
 * Tests for `<GlobalShortcuts />` / `useGlobalShortcuts` (Unit 10 of
 * the v2.0 polish plan).
 *
 * Wire-up scenarios:
 *  - A command-with-shortcut registered in the registry has its
 *    `action` invoked when the keypress fires globally.
 *  - The same keypress does NOT fire while focus is on an editable
 *    element (auto-skip via the wrapper's default).
 *  - The cheatsheet store flips when `?` is pressed (edge: this
 *    binding is registered at AppShell, not via the registry — see
 *    the AppShell scenario below).
 *  - Sequence shortcut "g s" fires when both keys arrive within the
 *    1s timeout, and does NOT fire when they arrive too far apart.
 *  - Bindings managed by AppShell (meta+k, ?) are SKIPPED by
 *    `<GlobalShortcuts />` to prevent double-fire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { GlobalShortcuts } from '@/lib/useGlobalShortcuts';
import { useShortcutCheatsheetStore } from '@/store/shortcutCheatsheet';
import { useCommandPaletteStore } from '@/store/commandPalette';
import { useHistoryStore } from '@/store/history';
import { useSnapshotStore } from '@/store/snapshot';
import { useRunModeStore } from '@/store/runMode';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useAnalyzeStore } from '@/store/analyze';
import { useUiStore } from '@/store/ui';
import { useThemeStore } from '@/store/theme';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary, PflowResult } from '@/api/types';

let MOCK_TOPOLOGY: TopologySummary | null = null;
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => MOCK_TOPOLOGY,
  };
});

function emptyTopology(): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
}

function withProviders(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

/**
 * Dispatch a keyboard event the same way `react-hotkeys-hook` listens
 * for one — see the wrapper-level test in `useHotkeys.test.ts` for the
 * rationale (the lib subscribes via `document.addEventListener` and
 * keys off `event.code`).
 */
function pressKey(key: string, code: string, target: EventTarget = document): void {
  const event = new KeyboardEvent('keydown', {
    key,
    code,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
}

beforeEach(() => {
  MOCK_TOPOLOGY = emptyTopology();
  useShortcutCheatsheetStore.setState({ open: false });
  useCommandPaletteStore.setState({ open: false });
  useHistoryStore.getState().reset();
  useSessionStore.setState({
    sessionId: parseSessionId('test-session'),
    recoveryInProgress: false,
    recoveryFailed: false,
    recoveryAttempts: [],
    recoveryStuckSince: null,
  });
  useCaseStore.setState({
    selection: {
      primaryPath: parseWorkspacePath('cases/ieee14.raw'),
      addfiles: [],
    },
    topology: null,
    layoutSidecar: null,
    selectedElement: null,
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDirty: false,
    dragOverrides: {},
    pendingDependents: [],
  });
  useSnapshotStore.getState().reset();
  useRunModeStore.setState({ activeRoutine: 'pflow' });
  // PF converged so EIG / other PF-gated commands surface (keeps the
  // registry stable across tests).
  usePflowStore.setState({
    lastRun: {
      converged: true,
      iterations: 4,
      max_mismatch: 1e-9,
      buses: [],
    } as unknown as PflowResult,
    isRunning: false,
    error: null,
  });
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('<GlobalShortcuts /> — single-key bindings', () => {
  it('opens the run-history drawer when "g h" is pressed', () => {
    render(withProviders(<GlobalShortcuts />));
    expect(useHistoryStore.getState().drawerOpen).toBe(false);
    // Sequence: g, then h within the 1s window.
    pressKey('g', 'KeyG');
    pressKey('h', 'KeyH');
    expect(useHistoryStore.getState().drawerOpen).toBe(true);
  });

  it('opens the snapshot save dialog when "g s" is pressed', () => {
    render(withProviders(<GlobalShortcuts />));
    expect(useSnapshotStore.getState().saveDialogOpen).toBe(false);
    pressKey('g', 'KeyG');
    pressKey('s', 'KeyS');
    expect(useSnapshotStore.getState().saveDialogOpen).toBe(true);
  });

  it('cycles the theme when ⌘D is pressed (Unit 12)', () => {
    useThemeStore.setState({
      themePreference: 'light',
      resolvedTheme: 'light',
      persistFailed: false,
    });
    render(withProviders(<GlobalShortcuts />));
    const event = new KeyboardEvent('keydown', {
      key: 'd',
      code: 'KeyD',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(event);
    });
    expect(useThemeStore.getState().themePreference).toBe('dark');
  });

  it('runs the active routine when ⌘Enter is pressed', () => {
    // The default active routine is `pflow`. After ⌘Enter, the
    // run.active-routine command's `action` calls `handleSelectRoutine`
    // which delegates to the analyze + ui stores for non-pflow
    // routines. Switch to `eig` so the test has an observable side
    // effect.
    const setSubMode = vi.fn();
    const setRightDockPanel = vi.fn();
    const origSetSubMode = useAnalyzeStore.getState().setSubMode;
    const origSetRightDock = useUiStore.getState().setActiveRightDockTopPanel;
    act(() => {
      useAnalyzeStore.setState({ setSubMode });
      useUiStore.setState({ setActiveRightDockTopPanel: setRightDockPanel });
      useRunModeStore.setState({ activeRoutine: 'eig' });
    });
    try {
      render(withProviders(<GlobalShortcuts />));
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        document.dispatchEvent(event);
      });
      expect(setSubMode).toHaveBeenCalledWith('eig');
      expect(setRightDockPanel).toHaveBeenCalledWith('analyze');
    } finally {
      act(() => {
        useAnalyzeStore.setState({ setSubMode: origSetSubMode });
        useUiStore.setState({ setActiveRightDockTopPanel: origSetRightDock });
      });
    }
  });
});

describe('<GlobalShortcuts /> — editable-element auto-skip', () => {
  it('does NOT open the snapshot dialog when "g s" is pressed inside an input', () => {
    render(withProviders(<GlobalShortcuts />));
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    try {
      expect(document.activeElement).toBe(input);
      pressKey('g', 'KeyG', input);
      pressKey('s', 'KeyS', input);
      expect(useSnapshotStore.getState().saveDialogOpen).toBe(false);
    } finally {
      input.remove();
    }
  });
});

describe('<GlobalShortcuts /> — sequence timeout', () => {
  it('"g s" within 500ms fires the snapshot dialog', () => {
    vi.useFakeTimers();
    render(withProviders(<GlobalShortcuts />));
    pressKey('g', 'KeyG');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    pressKey('s', 'KeyS');
    expect(useSnapshotStore.getState().saveDialogOpen).toBe(true);
  });

  it('"g s" with > 1s gap does NOT fire (sequence resets)', () => {
    vi.useFakeTimers();
    render(withProviders(<GlobalShortcuts />));
    pressKey('g', 'KeyG');
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    pressKey('s', 'KeyS');
    expect(useSnapshotStore.getState().saveDialogOpen).toBe(false);
  });
});

describe('<GlobalShortcuts /> — AppShell-managed bindings', () => {
  it('does NOT register `?` (cheatsheet binding lives in AppShell)', () => {
    render(withProviders(<GlobalShortcuts />));
    pressKey('?', 'Slash');
    // Without AppShell mounting its own `useHotkeys('?', ...)`, the
    // cheatsheet should stay closed — confirms `<GlobalShortcuts />`
    // skips the AppShell-managed binding.
    expect(useShortcutCheatsheetStore.getState().open).toBe(false);
  });

  it('does NOT register `meta+k` (palette binding lives in AppShell)', () => {
    render(withProviders(<GlobalShortcuts />));
    const event = new KeyboardEvent('keydown', {
      key: 'k',
      code: 'KeyK',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(event);
    });
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });
});

describe('<GlobalShortcuts /> — v3 Unit 2 view toggles', () => {
  it('⌘B toggles the left sidebar', () => {
    render(withProviders(<GlobalShortcuts />));
    expect(useLayoutStore.getState().leftSidebarCollapsed).toBe(false);
    const event = new KeyboardEvent('keydown', {
      key: 'b',
      code: 'KeyB',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(event);
    });
    expect(useLayoutStore.getState().leftSidebarCollapsed).toBe(true);
  });

  it('⌘J toggles the bottom drawer AND clears the unread bit', () => {
    useLayoutStore.setState({
      drawerHasUnreadResults: true,
      bottomDrawerCollapsed: true,
    });
    render(withProviders(<GlobalShortcuts />));
    const event = new KeyboardEvent('keydown', {
      key: 'j',
      code: 'KeyJ',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(event);
    });
    expect(useLayoutStore.getState().bottomDrawerCollapsed).toBe(false);
    expect(useLayoutStore.getState().drawerHasUnreadResults).toBe(false);
  });

  it('⌘\\ toggles the right inspector', () => {
    render(withProviders(<GlobalShortcuts />));
    expect(useLayoutStore.getState().rightInspectorCollapsed).toBe(false);
    const event = new KeyboardEvent('keydown', {
      key: '\\',
      code: 'Backslash',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(event);
    });
    expect(useLayoutStore.getState().rightInspectorCollapsed).toBe(true);
  });

  it('does NOT fire ⌘B when focus is inside a text input', () => {
    render(withProviders(<GlobalShortcuts />));
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    try {
      expect(document.activeElement).toBe(input);
      const event = new KeyboardEvent('keydown', {
        key: 'b',
        code: 'KeyB',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        input.dispatchEvent(event);
      });
      expect(useLayoutStore.getState().leftSidebarCollapsed).toBe(false);
    } finally {
      input.remove();
    }
  });
});

describe('<GlobalShortcuts /> — render shape', () => {
  it('renders nothing visible (each binder returns null)', () => {
    const { container } = render(withProviders(<GlobalShortcuts />));
    // The fragment + ShortcutBinder children all return null, so no
    // DOM is added.
    expect(container.firstChild).toBeNull();
    // No accidental text leaks.
    expect(screen.queryByText(/shortcut/i)).not.toBeInTheDocument();
  });
});
