/**
 * Tests for `<TopBar />` after the Unit 8 grouped-menus refactor.
 *
 * The TopBar's contract is now:
 *
 * - Three slot regions (left / center / right) keyed on `data-slot`
 *   AND test-friendly `data-testid` keys (`top-bar-{left,center,right}`).
 * - The right slot is *augmented* by the TopBar with the dark-mode
 *   placeholder + History toggle so they always anchor at the rightmost
 *   edge regardless of what the App injects.
 * - The TopBar mounts the dialog wrappers for the global-store-driven
 *   flows (BundleExportDialog, ReportDialog, HistoryDrawer) so they
 *   stay open across menu open/close cycles.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  act,
  cleanup,
  render as rtlRender,
  screen,
  within,
  type RenderResult,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { TopBar } from '@/components/shell/TopBar';
import {
  INLINE_FROM_MEDIUM,
  INLINE_FROM_WIDE,
  MORE_BELOW_WIDE,
} from '@/components/shell/topBarLayout';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';
import { useBundleStore } from '@/store/bundle';
import { useHistoryStore } from '@/store/history';
import { useReportDialogStore } from '@/store/reportDialog';

function render(ui: ReactElement): RenderResult {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
  useBundleStore.getState().closeDialog();
  useReportDialogStore.getState().closeDialog();
  useHistoryStore.getState().closeDrawer();
});

describe('<TopBar /> — structural contract', () => {
  it('renders three slot regions in left/center/right order with testids', () => {
    render(<TopBar left={<span>L</span>} center={<span>C</span>} right={<span>R</span>} />);
    const banner = screen.getByTestId('top-bar');
    const slots = banner.querySelectorAll('[data-slot]');
    expect(slots).toHaveLength(3);
    expect(slots[0]?.getAttribute('data-slot')).toBe('left');
    expect(slots[1]?.getAttribute('data-slot')).toBe('center');
    expect(slots[2]?.getAttribute('data-slot')).toBe('right');
    expect(within(slots[0] as HTMLElement).getByText('L')).toBeInTheDocument();
    expect(within(slots[1] as HTMLElement).getByText('C')).toBeInTheDocument();
    expect(within(slots[2] as HTMLElement).getByText('R')).toBeInTheDocument();
  });

  it('exposes per-slot testids so callers can scope queries cleanly', () => {
    render(<TopBar />);
    expect(screen.getByTestId('top-bar')).toBeInTheDocument();
    expect(screen.getByTestId('top-bar-left')).toBeInTheDocument();
    expect(screen.getByTestId('top-bar-center')).toBeInTheDocument();
    expect(screen.getByTestId('top-bar-right')).toBeInTheDocument();
  });

  it('renders empty slot regions when no content is provided', () => {
    render(<TopBar />);
    const banner = screen.getByTestId('top-bar');
    const slots = banner.querySelectorAll('[data-slot]');
    expect(slots).toHaveLength(3);
  });

  it('forwards className for caller-side overrides', () => {
    render(<TopBar className="custom-top-bar" />);
    expect(screen.getByTestId('top-bar').className).toMatch(/custom-top-bar/);
  });
});

describe('<TopBar /> — brand block', () => {
  it('renders the logo mark + "TENSA" wordmark before the left slot', () => {
    render(<TopBar left={<span>L</span>} />);
    const banner = screen.getByTestId('top-bar');
    const brand = screen.getByTestId('app-brand');
    expect(banner.contains(brand)).toBe(true);
    // wordmark text
    expect(within(brand).getByText('TENSA')).toBeInTheDocument();
    // inline SVG mark (decorative, hidden from a11y tree)
    expect(brand.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    // brand is structural: it sits BEFORE the left slot, not inside it
    const left = screen.getByTestId('top-bar-left');
    expect(left.contains(brand)).toBe(false);
    const children = Array.from(banner.children);
    expect(children.indexOf(brand)).toBeLessThan(children.indexOf(left));
  });
});

describe('<TopBar /> — auto-mounted right-slot anchors', () => {
  it('renders the theme toggle at the rightmost edge', () => {
    render(<TopBar />);
    const toggle = screen.getByTestId('theme-toggle');
    expect(toggle).toBeInTheDocument();
    expect(toggle).toBeEnabled();
    // Living in the right slot keeps it anchored to the right edge.
    expect(screen.getByTestId('top-bar-right').contains(toggle)).toBe(true);
  });

  it('renders the history drawer toggle in the right slot', () => {
    render(<TopBar />);
    const toggle = screen.getByTestId('history-drawer-toggle');
    expect(screen.getByTestId('top-bar-right').contains(toggle)).toBe(true);
  });

  it('renders the Help menu at the far right, after the history toggle', () => {
    render(<TopBar />);
    const right = screen.getByTestId('top-bar-right');
    const help = screen.getByTestId('topbar-menu-help-trigger');
    const history = screen.getByTestId('history-drawer-toggle');
    expect(right.contains(help)).toBe(true);
    expect(history.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(help).toHaveAccessibleName('Help');
  });

  it('right-slot caller content renders BEFORE the auto-mounted anchors', () => {
    render(<TopBar right={<button data-testid="caller-right">x</button>} />);
    const right = screen.getByTestId('top-bar-right');
    const caller = screen.getByTestId('caller-right');
    const toggle = screen.getByTestId('theme-toggle');
    const callerIdx = Array.from(right.children).indexOf(caller);
    const toggleIdx = Array.from(right.children).indexOf(toggle);
    expect(callerIdx).toBeGreaterThanOrEqual(0);
    expect(toggleIdx).toBeGreaterThan(callerIdx);
  });
});

describe('<TopBar /> — narrow windows', () => {
  // jsdom applies no CSS, so these read the classes that hide each control; the
  // widths themselves are checked in a real browser (tests/e2e/top-bar-fit.spec.ts).
  const dividers = () => screen.getAllByTestId('top-bar-divider');

  it('hides Search, Theme and History below the wide width, where the More menu takes them', () => {
    render(<TopBar />);
    for (const id of ['command-palette-hint', 'theme-toggle', 'history-drawer-toggle']) {
      expect(screen.getByTestId(id).className).toContain(INLINE_FROM_WIDE);
    }
    expect(screen.getByTestId('topbar-menu-more-trigger').className).toContain(MORE_BELOW_WIDE);
  });

  it('hides the four pane toggles below the medium width', () => {
    render(<TopBar />);
    for (const id of [
      'top-bar-toggle-sidebar',
      'top-bar-toggle-inspector',
      'top-bar-toggle-drawer',
      'top-bar-toggle-results-view',
    ]) {
      expect(screen.getByTestId(id).className).toContain(INLINE_FROM_MEDIUM);
    }
  });

  it('hides each divider with the group it sets off, so none is left standing alone', () => {
    render(<TopBar />);
    const classes = dividers().map((d) => d.className);
    expect(classes.filter((c) => c.includes(INLINE_FROM_MEDIUM))).toHaveLength(1);
    expect(classes.filter((c) => c.includes(INLINE_FROM_WIDE))).toHaveLength(2);
    expect(classes.filter((c) => c.includes(MORE_BELOW_WIDE))).toHaveLength(1);
  });

  it('keeps Help outside the menu, after it, so it is on screen at every width', () => {
    render(<TopBar />);
    const more = screen.getByTestId('topbar-menu-more-trigger');
    const help = screen.getByTestId('topbar-menu-help-trigger');
    expect(more.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(help.className).not.toMatch(/(max|min)-\[/);
  });
});

describe('<TopBar /> search hint', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const stubPlatform = (platform: string) =>
    Object.defineProperty(globalThis, 'navigator', {
      value: { platform, userAgent: '' } as unknown as Navigator,
      configurable: true,
      writable: true,
    });
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
  });

  it('names the palette key of the platform: Ctrl+K elsewhere, ⌘K on macOS', () => {
    stubPlatform('Linux x86_64');
    render(<TopBar />);
    expect(screen.getByTestId('command-palette-hint')).toHaveTextContent('Ctrl+K');
    cleanup();
    stubPlatform('MacIntel');
    render(<TopBar />);
    expect(screen.getByTestId('command-palette-hint')).toHaveTextContent('⌘K');
  });
});

describe('<TopBar /> — v3 Unit 2 pane toggles', () => {
  it('mounts the sidebar / inspector / drawer toggles in the right cluster', () => {
    render(<TopBar />);
    const right = screen.getByTestId('top-bar-right');
    const sidebar = screen.getByTestId('top-bar-toggle-sidebar');
    const inspector = screen.getByTestId('top-bar-toggle-inspector');
    const drawer = screen.getByTestId('top-bar-toggle-drawer');
    expect(right.contains(sidebar)).toBe(true);
    expect(right.contains(inspector)).toBe(true);
    expect(right.contains(drawer)).toBe(true);
  });

  it('orders pane toggles sidebar → inspector → drawer', () => {
    render(<TopBar />);
    const right = screen.getByTestId('top-bar-right');
    const sidebarIdx = Array.from(right.children).indexOf(
      screen.getByTestId('top-bar-toggle-sidebar'),
    );
    const inspectorIdx = Array.from(right.children).indexOf(
      screen.getByTestId('top-bar-toggle-inspector'),
    );
    const drawerIdx = Array.from(right.children).indexOf(
      screen.getByTestId('top-bar-toggle-drawer'),
    );
    expect(sidebarIdx).toBeGreaterThanOrEqual(0);
    expect(inspectorIdx).toBeGreaterThan(sidebarIdx);
    expect(drawerIdx).toBeGreaterThan(inspectorIdx);
  });

  it('places pane toggles AFTER caller right-slot content but BEFORE the theme toggle', () => {
    render(<TopBar right={<button data-testid="caller-right">x</button>} />);
    const right = screen.getByTestId('top-bar-right');
    const indexOf = (testid: string) =>
      Array.from(right.children).indexOf(screen.getByTestId(testid));
    const callerIdx = indexOf('caller-right');
    const sidebarIdx = indexOf('top-bar-toggle-sidebar');
    const drawerIdx = indexOf('top-bar-toggle-drawer');
    const themeIdx = indexOf('theme-toggle');
    expect(sidebarIdx).toBeGreaterThan(callerIdx);
    expect(drawerIdx).toBeLessThan(themeIdx);
  });

  it('drawer toggle surfaces the unread dot when drawerHasUnreadResults is set', () => {
    useLayoutStore.setState({ drawerHasUnreadResults: true });
    render(<TopBar />);
    expect(screen.getByTestId('top-bar-toggle-drawer-unread-dot')).toBeInTheDocument();
  });
});

describe('<TopBar /> — store-driven dialogs load on first open', () => {
  it('mounts none of them while their flags are closed', () => {
    render(<TopBar />);
    expect(screen.queryByTestId('bundle-export-dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('report-dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('history-drawer')).not.toBeInTheDocument();
  });

  it('mounts the bundle export dialog when its flag opens', async () => {
    render(<TopBar />);
    act(() => useBundleStore.getState().openDialog());
    expect(await screen.findByTestId('bundle-export-dialog')).toBeInTheDocument();
  });

  it('mounts the report dialog when its flag opens', async () => {
    render(<TopBar />);
    act(() => useReportDialogStore.getState().openDialog('pflow'));
    expect(await screen.findByTestId('report-dialog')).toBeInTheDocument();
  });

  it('mounts the history drawer when its flag opens', async () => {
    render(<TopBar />);
    act(() => useHistoryStore.getState().openDrawer());
    expect(await screen.findByTestId('history-drawer')).toBeInTheDocument();
  });
});
