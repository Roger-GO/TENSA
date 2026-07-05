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
  cleanup,
  render as rtlRender,
  screen,
  within,
  type RenderResult,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { TopBar } from '@/components/shell/TopBar';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';

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
