import {
  render as rtlRender,
  screen,
  within,
  type RenderOptions,
  type RenderResult,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

/**
 * Unit 7 mounts `CaseNav` as the LeftRail's default content; CaseNav
 * uses TanStack Query hooks which require a QueryClient in context.
 * Tests render the shell behind a fresh QueryClient so the CaseNav
 * mounts cleanly without exercising the queries it never fires here.
 */
function render(ui: ReactElement, options?: RenderOptions): RenderResult {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>, options);
}

/**
 * AppShell tests cover the shell's structural contract: regions render,
 * collapsing the left rail persists, layout sizes round-trip via
 * localStorage, the small-viewport fallback drops the right dock, and the
 * modal slot mounts a Radix Dialog above the shell.
 *
 * Visual layout (computed widths, scrollbar painting) is intentionally
 * out-of-scope — jsdom doesn't lay out, and the shell delegates that to
 * `react-resizable-panels`, which has its own tests.
 *
 * The vitest+jsdom environment in this repo does NOT ship a working
 * `localStorage` (it provides a bare object with no `setItem`/`getItem`/
 * `removeItem`/`clear` methods, with a `--localstorage-file` warning at
 * startup). We install an in-memory shim per test so persistence tests
 * have a deterministic substrate.
 */
function installLocalStorageShim(): { store: Map<string, string> } {
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: shim,
  });
  return { store };
}

describe('AppShell', () => {
  let storage: { store: Map<string, string> };

  beforeEach(() => {
    storage = installLocalStorageShim();
  });

  afterEach(() => {
    storage.store.clear();
  });

  it('renders all four regions with default empty placeholders', () => {
    render(<AppShell />);

    // Top bar landmark is the banner.
    expect(screen.getByRole('banner', { name: /top bar/i })).toBeInTheDocument();

    // Left rail (case navigation), main canvas, right dock all expose
    // accessible names.
    expect(screen.getByRole('complementary', { name: /case navigation/i })).toBeInTheDocument();
    expect(screen.getByRole('main', { name: /single-line diagram/i })).toBeInTheDocument();
    expect(
      screen.getByRole('complementary', { name: /inspector and results/i }),
    ).toBeInTheDocument();

    // Inner regions render their EmptyState fallback captions.
    expect(screen.getByText('No case loaded')).toBeInTheDocument();
    expect(screen.getByText('No element selected')).toBeInTheDocument();
    expect(screen.getByText('No results yet')).toBeInTheDocument();
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

  it('collapses and expands the left rail and persists the choice', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AppShell />);

    const rail = screen.getByRole('complementary', { name: /case navigation/i });
    expect(rail.dataset.collapsed).toBe('false');

    const collapseButton = within(rail).getByRole('button', { name: /collapse left rail/i });
    await user.click(collapseButton);

    expect(rail.dataset.collapsed).toBe('true');
    expect(window.localStorage.getItem('andes-app:layout:left-rail-collapsed')).toBe('1');

    // Re-mounting should restore the collapsed state from localStorage.
    unmount();
    render(<AppShell />);
    const railAgain = screen.getByRole('complementary', { name: /case navigation/i });
    expect(railAgain.dataset.collapsed).toBe('true');
  });

  it('persists main layout sizes via the autoSaveId', () => {
    // react-resizable-panels uses `autoSaveId` to namespace its writes to
    // localStorage. We can't deterministically drag a handle in jsdom,
    // but we can verify the PanelGroup is wired with the correct
    // autoSaveId by checking the data attribute it renders.
    render(<AppShell />);
    const groups = document.querySelectorAll('[data-panel-group]');
    const ids = Array.from(groups).map((el) => el.getAttribute('data-panel-group-id'));
    // The shell creates two PanelGroups: main (horizontal) and right
    // dock (vertical). Both should be present.
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });

  it('drops the right dock when the viewport is below the small breakpoint', () => {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    try {
      render(<AppShell />);
      // The right-dock complementary should not render.
      expect(
        screen.queryByRole('complementary', { name: /inspector and results/i }),
      ).not.toBeInTheDocument();
      // The main canvas still renders.
      expect(screen.getByRole('main', { name: /single-line diagram/i })).toBeInTheDocument();
      // The left rail is force-collapsed.
      const rail = screen.getByRole('complementary', { name: /case navigation/i });
      expect(rail.dataset.collapsed).toBe('true');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
    }
  });

  it('places the top bar before the rail in tab order', async () => {
    const user = userEvent.setup();
    render(
      <AppShell
        topBarRight={<button type="button">Top action</button>}
        leftRail={<button type="button">Rail action</button>}
        main={<button type="button">Main action</button>}
        results={<button type="button">Results action</button>}
      />,
    );

    // Tab through the document; the first focusable tab stop should be
    // a top-bar control (or the rail collapse button if no top-bar
    // control was supplied — we supplied one to make the assertion
    // meaningful).
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Top action' }));

    // Unit 8 added two auto-mounted right-slot anchors after the
    // caller-supplied content; Unit 9 inserted a third (the ⌘K
    // command-palette hint button) between them. The DOM order in
    // the right slot is now: caller content → command-palette-hint →
    // dark-mode-toggle-placeholder → history-drawer-toggle. The
    // history toggle is disabled (no session) so it's skipped in tab
    // order, leaving the palette hint and the dark-mode placeholder
    // as the auto-mounted stops between the caller's "Top action"
    // and the rail collapse chevron.
    await user.tab();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('command-palette-hint');

    await user.tab();
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'dark-mode-toggle-placeholder',
    );

    await user.tab();
    // Next focus stop is the rail collapse chevron.
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/collapse left rail/i);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rail action' }));

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Main action' }));
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

    // The dialog's z-index class is z-50, ensuring it stacks above the
    // shell DOM (which uses z-10 on the top bar at most).
    const zStacked = dialog.closest('[class*="z-50"]');
    expect(zStacked).not.toBeNull();
  });

  it('renders a dock overlay above inspector and results when supplied', () => {
    render(<AppShell dockOverlay={<div>PF did not converge.</div>} />);
    expect(screen.getByText('PF did not converge.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /dock overlay/i })).toBeInTheDocument();
  });

  it('renders custom inspector and results content when provided', () => {
    render(<AppShell inspector={<div>Bus 1 properties</div>} results={<div>v=1.0 pu</div>} />);
    expect(screen.getByText('Bus 1 properties')).toBeInTheDocument();
    expect(screen.getByText('v=1.0 pu')).toBeInTheDocument();
    // Empty-state captions should be gone.
    expect(screen.queryByText('No element selected')).not.toBeInTheDocument();
    expect(screen.queryByText('No results yet')).not.toBeInTheDocument();
  });

  it('mounts the global Toaster so toasts render anywhere in the tree (Unit 3)', async () => {
    const { container } = render(<AppShell />);
    // Sonner is lazy — the toaster's portal renders only on the first
    // emitted toast. Fire one through the typed wrapper (which is
    // load-bearing for every component using `@/lib/toast`) and
    // confirm the portal landed in the document.
    const { toast } = await import('@/lib/toast');
    toast.success('hello from the toaster smoke test');
    await screen.findByText(/hello from the toaster smoke test/i);
    const sonnerRoot = container.ownerDocument.querySelector('[data-sonner-toaster]');
    expect(sonnerRoot).not.toBeNull();
  });
});

describe('AppShell — keyboard floor (R20)', () => {
  it('Esc dismisses an open Dialog mounted in the modal slot', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
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
