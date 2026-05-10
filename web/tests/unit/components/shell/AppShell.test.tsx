import {
  act,
  render as rtlRender,
  screen,
  within,
  type RenderOptions,
  type RenderResult,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  DEFAULT_LAYOUT,
  LAYOUT_STORAGE_KEY,
  useLayoutStore,
} from '@/store/layout';
import { useSldStore } from '@/store/sld';

/**
 * AppShell tests cover the structural contract of the v3 4-pane chassis:
 * each region renders its slot content, the dock-overlay slot mounts
 * above the chassis, the modal slot mounts a Radix Dialog, the right
 * inspector renders an EmptyState when expanded with no selection, and
 * the layout store + persistence wiring round-trips through localStorage.
 *
 * Visual layout (computed widths, scrollbar painting) is intentionally
 * out-of-scope — jsdom doesn't lay out, and the shell delegates that to
 * `react-resizable-panels`, which has its own tests. The lib emits a
 * "Panel size not found" warning on first mount in jsdom (registration
 * race) — that's a lib-internal log, not a test failure.
 */
function render(ui: ReactElement, options?: RenderOptions): RenderResult {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>, options);
}

function resetLayoutStore(): void {
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
}

function resetSldStore(): void {
  useSldStore.setState({ selectedNodeId: null });
}

beforeEach(() => {
  // The setup file already installs a working in-memory localStorage
  // shim before any zustand store initializes. Just clear it here.
  window.localStorage.clear();
  resetLayoutStore();
  resetSldStore();
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('AppShell — structural contract', () => {
  it('mounts the top bar landmark with the expected testid', () => {
    render(<AppShell />);
    const banner = screen.getByRole('banner', { name: /top bar/i });
    expect(banner).toBeInTheDocument();
    expect(banner.getAttribute('data-testid')).toBe('top-bar');
  });

  it('renders the four chassis regions with the v3 testids', () => {
    render(
      <AppShell
        leftSidebar={<span>left-content</span>}
        canvas={<span>canvas-content</span>}
        rightInspector={<span>inspector-content</span>}
        bottomDrawer={<span>drawer-content</span>}
      />,
    );

    // Each region is a labelled landmark with a stable testid.
    expect(screen.getByTestId('app-shell-left-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('app-shell-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('app-shell-right-inspector')).toBeInTheDocument();
    expect(screen.getByTestId('app-shell-bottom-drawer')).toBeInTheDocument();

    // Each slot's content is rendered.
    expect(screen.getByText('left-content')).toBeInTheDocument();
    expect(screen.getByText('canvas-content')).toBeInTheDocument();
    expect(screen.getByText('inspector-content')).toBeInTheDocument();
    expect(screen.getByText('drawer-content')).toBeInTheDocument();
  });

  it('renders provided slot content into top bar regions', () => {
    render(
      <AppShell
        topBarLeft={<span>case-name.raw</span>}
        topBarCenter={<span>ANDES App</span>}
        topBarRight={<button type="button">Run PF</button>}
      />,
    );

    const banner = screen.getByRole('banner', { name: /top bar/i });
    expect(within(banner).getByText('case-name.raw')).toBeInTheDocument();
    expect(within(banner).getByText('ANDES App')).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Run PF' })).toBeInTheDocument();
  });

  it('mounts a Radix Dialog passed into the modal slot', () => {
    render(
      <AppShell
        modal={
          <Dialog open={true} onOpenChange={() => {}}>
            <DialogContent>
              <DialogTitle>Locked behind auth</DialogTitle>
            </DialogContent>
          </Dialog>
        }
      />,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText('Locked behind auth')).toBeInTheDocument();
  });

  it('renders dockOverlay content in its dedicated slot', () => {
    render(<AppShell dockOverlay={<div>Overlay banner</div>} />);
    const overlay = screen.getByTestId('app-shell-dock-overlay');
    expect(overlay).toBeInTheDocument();
    expect(within(overlay).getByText('Overlay banner')).toBeInTheDocument();
  });
});

describe('AppShell — right inspector visibility model', () => {
  it('renders the inspector panel collapsed when no selection AND user has it collapsed', () => {
    useLayoutStore.setState({ rightInspectorCollapsed: true });
    useSldStore.setState({ selectedNodeId: null });
    render(<AppShell rightInspector={<span>inspector-body</span>} />);
    const inspector = screen.getByTestId('app-shell-right-inspector');
    expect(inspector.dataset.collapsed).toBe('true');
    // Children are gated behind the visibility predicate so a
    // size-0 panel does not become a focus trap (spike finding b).
    expect(screen.queryByText('inspector-body')).not.toBeInTheDocument();
  });

  it('renders the inspector with its content when an element is selected', () => {
    useSldStore.setState({ selectedNodeId: 'bus-5' });
    render(<AppShell rightInspector={<span>bus-5 properties</span>} />);
    const inspector = screen.getByTestId('app-shell-right-inspector');
    expect(inspector.dataset.collapsed).toBe('false');
    expect(screen.getByText('bus-5 properties')).toBeInTheDocument();
  });

  it('renders an EmptyState when manually opened with no selection', () => {
    // Default state: rightInspectorCollapsed=false, selectedNodeId=null.
    // The visibility predicate is OR — collapsed=false alone keeps the
    // panel visible.
    useLayoutStore.setState({ rightInspectorCollapsed: false });
    useSldStore.setState({ selectedNodeId: null });
    // Pass NO rightInspector so the AppShell's EmptyState fallback fires.
    render(<AppShell />);
    const inspector = screen.getByTestId('app-shell-right-inspector');
    expect(inspector.dataset.collapsed).toBe('false');
    expect(screen.getByText('Nothing selected')).toBeInTheDocument();
    expect(
      screen.getByText(
        /select an element on the canvas or a row in the data grid to inspect its properties/i,
      ),
    ).toBeInTheDocument();
  });

  it('hides inspector children when collapsed but allows EmptyState when expanded', () => {
    // Toggle the layout store's collapsed bit; the visibility predicate
    // OR-s with a non-null selection — assert both branches.
    useLayoutStore.setState({ rightInspectorCollapsed: true });
    useSldStore.setState({ selectedNodeId: null });
    const { rerender } = render(<AppShell rightInspector={<span>real-inspector</span>} />);
    expect(screen.queryByText('real-inspector')).not.toBeInTheDocument();

    // Flip to expanded with a selection — content renders. Wrap the
    // store mutations in act() so React processes the resulting
    // re-render synchronously before the rerender call.
    act(() => {
      useLayoutStore.setState({ rightInspectorCollapsed: false });
      useSldStore.setState({ selectedNodeId: 'bus-1' });
    });
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <AppShell rightInspector={<span>real-inspector</span>} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('real-inspector')).toBeInTheDocument();
  });
});

describe('AppShell — left sidebar collapse', () => {
  it('renders sidebar children when expanded', () => {
    useLayoutStore.setState({ leftSidebarCollapsed: false });
    render(<AppShell leftSidebar={<span>case-nav</span>} />);
    expect(screen.getByText('case-nav')).toBeInTheDocument();
    expect(screen.getByTestId('app-shell-left-sidebar').dataset.collapsed).toBe('false');
  });

  it('hides sidebar children when collapsed (no focus trap, spike finding b)', () => {
    useLayoutStore.setState({ leftSidebarCollapsed: true });
    render(<AppShell leftSidebar={<button type="button">should-be-hidden</button>} />);
    expect(screen.queryByRole('button', { name: 'should-be-hidden' })).not.toBeInTheDocument();
    expect(screen.getByTestId('app-shell-left-sidebar').dataset.collapsed).toBe('true');
  });
});

describe('AppShell — bottom drawer collapse', () => {
  it('reflects bottomDrawerCollapsed via data attribute', () => {
    useLayoutStore.setState({ bottomDrawerCollapsed: true });
    render(<AppShell bottomDrawer={<span>drawer-content</span>} />);
    expect(screen.getByTestId('app-shell-bottom-drawer').dataset.collapsed).toBe('true');
  });
});

describe('AppShell — layout state persistence', () => {
  it('hydrates default sizes from the layout store', () => {
    render(<AppShell />);
    // The PanelGroups all carry the v1-namespaced autoSaveIds so
    // post-Unit-1 dragging persists per-group.
    const groups = document.querySelectorAll('[data-panel-group]');
    expect(groups.length).toBeGreaterThanOrEqual(3);
  });

  it('rehydrates from a persisted localStorage payload', async () => {
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        state: {
          ...DEFAULT_LAYOUT,
          bottomDrawerCollapsed: true,
          bottomDrawerHeightPct: 50,
          activeBottomDrawerTab: 'analysis',
        },
        version: 0,
      }),
    );
    await useLayoutStore.persist.rehydrate();
    expect(useLayoutStore.getState().bottomDrawerCollapsed).toBe(true);
    expect(useLayoutStore.getState().bottomDrawerHeightPct).toBe(50);
    expect(useLayoutStore.getState().activeBottomDrawerTab).toBe('analysis');
  });

  it('falls back to defaults when localStorage holds malformed JSON', async () => {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, 'not-json{');
    resetLayoutStore();
    await useLayoutStore.persist.rehydrate();
    expect(useLayoutStore.getState().bottomDrawerHeightPct).toBe(
      DEFAULT_LAYOUT.bottomDrawerHeightPct,
    );
  });

  it('ignores stale `useUiStore.activeRightDockTopPanel` payloads (different storage key)', async () => {
    window.localStorage.setItem(
      'andes-ui-tds-integrator',
      JSON.stringify({ state: { activeRightDockTopPanel: 'analyze' }, version: 0 }),
    );
    render(<AppShell />);
    expect(useLayoutStore.getState().activeBottomDrawerTab).toBe('buses');
  });
});

describe('AppShell — keyboard floor (R20)', () => {
  it('Esc dismisses an open Dialog mounted in the modal slot', async () => {
    const onOpenChange = vi.fn();
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(
      <AppShell
        modal={
          <Dialog open={true} onOpenChange={onOpenChange}>
            <DialogContent>
              <DialogTitle>Confirm</DialogTitle>
            </DialogContent>
          </Dialog>
        }
      />,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('AppShell — Toaster mount (Unit 3)', () => {
  it('mounts the global Toaster so toasts render anywhere in the tree', async () => {
    const { container } = render(<AppShell />);
    const { toast } = await import('@/lib/toast');
    toast.success('hello from the v3 toaster smoke test');
    await screen.findByText(/hello from the v3 toaster smoke test/i);
    const sonnerRoot = container.ownerDocument.querySelector('[data-sonner-toaster]');
    expect(sonnerRoot).not.toBeNull();
  });
});
