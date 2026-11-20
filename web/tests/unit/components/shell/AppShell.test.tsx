import {
  act,
  fireEvent,
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
import { bottomDrawerSizes } from '@/components/shell/drawerSizes';
import { DEFAULT_LAYOUT, LAYOUT_STORAGE_KEY, useLayoutStore } from '@/store/layout';
import { useSldStore } from '@/store/sld';
import { useCommandPaletteStore } from '@/store/commandPalette';
import { useShortcutCheatsheetStore } from '@/store/shortcutCheatsheet';

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
        topBarCenter={<span>center-title</span>}
        topBarRight={<button type="button">Run PF</button>}
      />,
    );

    const banner = screen.getByRole('banner', { name: /top bar/i });
    expect(within(banner).getByText('case-name.raw')).toBeInTheDocument();
    expect(within(banner).getByText('center-title')).toBeInTheDocument();
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

describe('AppShell — full-space results view (v3.1)', () => {
  it('renders the chassis (NOT the results region) when resultsViewActive=false', () => {
    useLayoutStore.setState({ resultsViewActive: false });
    render(
      <AppShell
        canvas={<span>canvas-content</span>}
        rightInspector={<span>inspector-content</span>}
        bottomDrawer={<span>drawer-content</span>}
        resultsView={<span>results-page</span>}
      />,
    );
    // Chassis regions present; results region absent.
    expect(screen.getByTestId('app-shell-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('app-shell-bottom-drawer')).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell-results-view')).not.toBeInTheDocument();
    expect(screen.queryByText('results-page')).not.toBeInTheDocument();
  });

  it('short-circuits to the results region (hiding canvas/inspector/drawer) when active', () => {
    useLayoutStore.setState({ resultsViewActive: true });
    render(
      <AppShell
        canvas={<span>canvas-content</span>}
        rightInspector={<span>inspector-content</span>}
        bottomDrawer={<span>drawer-content</span>}
        resultsView={<span>results-page</span>}
      />,
    );
    // The diagram + inspector + drawer are fully unmounted.
    expect(screen.queryByTestId('app-shell-canvas')).not.toBeInTheDocument();
    expect(screen.queryByTestId('app-shell-right-inspector')).not.toBeInTheDocument();
    expect(screen.queryByTestId('app-shell-bottom-drawer')).not.toBeInTheDocument();
    expect(screen.queryByText('canvas-content')).not.toBeInTheDocument();
    expect(screen.queryByText('inspector-content')).not.toBeInTheDocument();
    expect(screen.queryByText('drawer-content')).not.toBeInTheDocument();
    // The results region + its content are mounted.
    const region = screen.getByTestId('app-shell-results-view');
    expect(region).toBeInTheDocument();
    expect(within(region).getByText('results-page')).toBeInTheDocument();
  });

  it('keeps the TopBar mounted in the results-view branch', () => {
    useLayoutStore.setState({ resultsViewActive: true });
    render(
      <AppShell topBarCenter={<span>center-title</span>} resultsView={<span>results-page</span>} />,
    );
    const banner = screen.getByRole('banner', { name: /top bar/i });
    expect(banner).toBeInTheDocument();
    expect(within(banner).getByText('center-title')).toBeInTheDocument();
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
    // The three groups of panels: outer, right side and top row.
    const groups = document.querySelectorAll('[data-group]');
    expect(groups.length).toBeGreaterThanOrEqual(3);
  });

  /** How much of its group the panel `id` takes, as its flex-grow says it in percent. */
  function share(id: string): number {
    return Number(document.getElementById(id)?.style.flexGrow);
  }

  it('opens the sidebar at the width it was dragged to, kept as version 2 of the library kept it', () => {
    window.localStorage.setItem(
      'react-resizable-panels:tensa:layout-v1:outer',
      JSON.stringify({
        'app-shell-left-sidebar-panel,app-shell-right-side-panel': {
          expandToSizes: {},
          layout: [30, 70],
        },
      }),
    );
    render(<AppShell />);
    expect(share('app-shell-left-sidebar-panel')).toBe(30);
    expect(share('app-shell-right-side-panel')).toBe(70);
  });

  it('opens the drawer at the height the layout store keeps, not one the library kept', () => {
    // Version 2 of the library kept this group too, with the panels in the
    // order of their names: read as version 4 reads it, the drawer would
    // open at the diagram's height.
    window.localStorage.setItem(
      'react-resizable-panels:tensa:layout-v1:right-side',
      JSON.stringify({
        'app-shell-bottom-drawer-panel,app-shell-top-row-panel': {
          expandToSizes: {},
          layout: [80, 20],
        },
      }),
    );
    useLayoutStore.setState({ bottomDrawerHeightPct: 40, bottomDrawerCollapsed: false });
    render(<AppShell />);
    expect(share('app-shell-bottom-drawer-panel')).toBe(40);
    expect(share('app-shell-top-row-panel')).toBe(60);
  });

  it('opens a drawer the store keeps shut at its tab strip', () => {
    useLayoutStore.setState({ bottomDrawerHeightPct: 40, bottomDrawerCollapsed: true });
    render(<AppShell />);
    expect(share('app-shell-bottom-drawer-panel')).toBe(bottomDrawerSizes(0).strip);
  });

  it('is drawn when a layout the library kept is not JSON', () => {
    window.localStorage.setItem('react-resizable-panels:tensa:layout-v1:top-row', 'not-json{');
    window.localStorage.setItem('react-resizable-panels:tensa:layout-v1:outer', 'null');
    render(<AppShell canvas={<span>canvas-content</span>} />);
    expect(screen.getByText('canvas-content')).toBeInTheDocument();
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

/**
 * Gives each panel a size, so that the library lays out its groups as it
 * does in a browser: jsdom lays nothing out, and the library puts off a
 * group it cannot measure, whose panels then show the layout they were
 * given while their handles and dividers do nothing. What a panel reports
 * need not follow its share: the library sizes the panels in percent of
 * what they add up to. The dividers report the same, so that the library,
 * which orders a group's children by where they are and then by their
 * size, finds them in the order they are in the document.
 */
function layOutPanels(): void {
  const size = (element: Element): number =>
    element.hasAttribute('data-panel') || element.hasAttribute('data-separator') ? 500 : 0;
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return size(this);
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return size(this);
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return new DOMRect(0, 0, size(this), size(this));
  });
}

/** How much of its group the panel `id` takes, in percent, as its flex-grow says it. */
function shareOf(id: string): number {
  return Number(document.getElementById(id)?.style.flexGrow);
}

/** Leaves the panels for the results view and comes back to them. */
function throughResultsView(): void {
  act(() => useLayoutStore.getState().setResultsViewActive(true));
  expect(screen.queryByTestId('app-shell-bottom-drawer')).not.toBeInTheDocument();
  act(() => useLayoutStore.getState().setResultsViewActive(false));
}

/** Moves the divider called `name` by one step of the keyboard, `key` an arrow. */
function step(name: string, key: string): void {
  fireEvent.keyDown(screen.getByRole('separator', { name }), { key });
}

describe('AppShell — the panels after the results view', () => {
  it('opens the drawer at the height it was dragged to', () => {
    layOutPanels();
    useLayoutStore.setState({ bottomDrawerHeightPct: 30 });
    render(<AppShell />);
    expect(shareOf('app-shell-bottom-drawer-panel')).toBe(30);
    // Dragged up two steps of the keyboard, which the store keeps.
    step('Resize bottom drawer', 'ArrowUp');
    step('Resize bottom drawer', 'ArrowUp');
    expect(shareOf('app-shell-bottom-drawer-panel')).toBe(40);
    expect(useLayoutStore.getState().bottomDrawerHeightPct).toBe(40);

    throughResultsView();
    expect(shareOf('app-shell-bottom-drawer-panel')).toBe(40);
    expect(useLayoutStore.getState().bottomDrawerHeightPct).toBe(40);
  });

  it('opens a drawer that was opened after the page loaded, and does not shut it again', () => {
    layOutPanels();
    useLayoutStore.setState({ bottomDrawerCollapsed: true, bottomDrawerHeightPct: 45 });
    render(<AppShell />);
    act(() => useLayoutStore.getState().toggleBottomDrawer());
    expect(shareOf('app-shell-bottom-drawer-panel')).toBe(45);

    throughResultsView();
    expect(shareOf('app-shell-bottom-drawer-panel')).toBe(45);
    expect(useLayoutStore.getState().bottomDrawerCollapsed).toBe(false);
    expect(screen.getByTestId('app-shell-bottom-drawer').dataset.collapsed).toBe('false');
  });

  it('opens the drawer at its tab strip when it was shut in the results view', () => {
    layOutPanels();
    render(<AppShell />);
    act(() => useLayoutStore.getState().setResultsViewActive(true));
    act(() => useLayoutStore.getState().toggleBottomDrawer());
    act(() => useLayoutStore.getState().setResultsViewActive(false));
    expect(shareOf('app-shell-bottom-drawer-panel')).toBe(bottomDrawerSizes(0).strip);
    expect(useLayoutStore.getState().bottomDrawerCollapsed).toBe(true);
  });

  it('hides the sidebar and the inspector that were hidden in the results view', () => {
    layOutPanels();
    render(<AppShell leftSidebar={<span>case-nav</span>} />);
    act(() => useLayoutStore.getState().setResultsViewActive(true));
    act(() => {
      useLayoutStore.getState().toggleLeftSidebar();
      useLayoutStore.getState().toggleRightInspector();
    });
    act(() => useLayoutStore.getState().setResultsViewActive(false));
    expect(shareOf('app-shell-right-side-panel')).toBe(100);
    expect(shareOf('app-shell-canvas-panel')).toBe(100);
    expect(screen.getByTestId('app-shell-left-sidebar').dataset.collapsed).toBe('true');
    expect(screen.getByTestId('app-shell-right-inspector').dataset.collapsed).toBe('true');
  });

  it('shows the sidebar and the inspector that were shown in the results view, at their widths', () => {
    layOutPanels();
    useLayoutStore.setState({
      leftSidebarCollapsed: true,
      leftSidebarWidthPct: 30,
      rightInspectorCollapsed: true,
      rightInspectorWidthPct: 35,
    });
    render(<AppShell leftSidebar={<span>case-nav</span>} />);
    act(() => useLayoutStore.getState().setResultsViewActive(true));
    act(() => {
      useLayoutStore.getState().toggleLeftSidebar();
      useLayoutStore.getState().toggleRightInspector();
    });
    act(() => useLayoutStore.getState().setResultsViewActive(false));
    expect(shareOf('app-shell-left-sidebar-panel')).toBe(30);
    expect(shareOf('app-shell-right-inspector-panel')).toBe(35);
    expect(screen.getByText('case-nav')).toBeInTheDocument();
    expect(screen.getByText('Nothing selected')).toBeInTheDocument();
  });
});

describe('AppShell — the width a hidden panel opens to', () => {
  it('keeps the width the sidebar and the inspector were last open at', () => {
    layOutPanels();
    render(<AppShell />);
    step('Resize left sidebar', 'ArrowRight');
    step('Resize canvas and inspector', 'ArrowLeft');
    expect(useLayoutStore.getState().leftSidebarWidthPct).toBe(25);
    expect(useLayoutStore.getState().rightInspectorWidthPct).toBe(30);
    // Hidden, they are no width to come back to.
    act(() => {
      useLayoutStore.getState().toggleLeftSidebar();
      useLayoutStore.getState().toggleRightInspector();
    });
    expect(shareOf('app-shell-right-side-panel')).toBe(100);
    expect(useLayoutStore.getState().leftSidebarWidthPct).toBe(25);
    expect(useLayoutStore.getState().rightInspectorWidthPct).toBe(30);
  });

  it('opens a sidebar and an inspector hidden before a reload at the width they were open at', () => {
    layOutPanels();
    // As the library keeps the layouts of their groups: with each panel shut.
    window.localStorage.setItem(
      'react-resizable-panels:tensa:layout-v1:outer',
      JSON.stringify({ 'app-shell-left-sidebar-panel': 0, 'app-shell-right-side-panel': 100 }),
    );
    window.localStorage.setItem(
      'react-resizable-panels:tensa:layout-v1:top-row',
      JSON.stringify({ 'app-shell-canvas-panel': 100, 'app-shell-right-inspector-panel': 0 }),
    );
    useLayoutStore.setState({
      leftSidebarCollapsed: true,
      leftSidebarWidthPct: 32.5,
      rightInspectorCollapsed: true,
      rightInspectorWidthPct: 27.5,
    });
    render(<AppShell />);
    expect(shareOf('app-shell-right-side-panel')).toBe(100);
    expect(shareOf('app-shell-canvas-panel')).toBe(100);
    act(() => {
      useLayoutStore.getState().toggleLeftSidebar();
      useLayoutStore.getState().toggleRightInspector();
    });
    expect(shareOf('app-shell-left-sidebar-panel')).toBe(32.5);
    expect(shareOf('app-shell-right-inspector-panel')).toBe(27.5);
  });

  it('opens a drawer shut before a reload at the height it was open at', () => {
    layOutPanels();
    useLayoutStore.setState({ bottomDrawerCollapsed: true, bottomDrawerHeightPct: 50 });
    render(<AppShell />);
    expect(shareOf('app-shell-bottom-drawer-panel')).toBe(bottomDrawerSizes(0).strip);
    act(() => useLayoutStore.getState().toggleBottomDrawer());
    expect(shareOf('app-shell-bottom-drawer-panel')).toBe(50);
  });
});

describe('AppShell — dividers between the panels', () => {
  it('can each be reached by the keyboard, and say what they resize and which way', () => {
    render(<AppShell />);
    const dividers = screen.getAllByRole('separator');
    expect(dividers.map((d) => d.getAttribute('aria-label'))).toEqual([
      'Resize left sidebar',
      'Resize canvas and inspector',
      'Resize bottom drawer',
    ]);
    expect(dividers.map((d) => d.getAttribute('aria-orientation'))).toEqual([
      'vertical',
      'vertical',
      'horizontal',
    ]);
    for (const divider of dividers) expect(divider.tabIndex).toBe(0);
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

describe('AppShell — palette and cheatsheet load on first open', () => {
  afterEach(() => {
    useCommandPaletteStore.getState().closePalette();
    useShortcutCheatsheetStore.getState().closeCheatsheet();
  });

  it('mounts neither while their flags are closed', () => {
    render(<AppShell />);
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
    expect(screen.queryByTestId('shortcut-cheatsheet')).not.toBeInTheDocument();
  });

  it('mounts the command palette when it opens', async () => {
    render(<AppShell />);
    act(() => useCommandPaletteStore.getState().openPalette());
    expect(await screen.findByTestId('command-palette')).toBeInTheDocument();
  });

  it('mounts the shortcut cheatsheet when it opens', async () => {
    render(<AppShell />);
    act(() => useShortcutCheatsheetStore.getState().openCheatsheet());
    expect(await screen.findByTestId('shortcut-cheatsheet')).toBeInTheDocument();
  });
});
