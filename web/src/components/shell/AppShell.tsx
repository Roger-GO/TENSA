import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import type { Layout, PanelImperativeHandle } from 'react-resizable-panels';
import { cn } from '@/lib/cn';
import { CursorIcon, EmptyState } from '@/components/ui/EmptyState';
import { bottomDrawerSizes, type DrawerSizes } from './drawerSizes';
import { panelLayoutStorage } from './panelLayoutStorage';
import { FirstRunCoach } from './FirstRunCoach';
import { TopBar } from './TopBar';
import { Toaster } from '@/components/ui/Toaster';
import { LazyMount } from '@/components/ui/Lazy';
import { lazyNamed } from '@/lib/lazyNamed';
import { useCommandPaletteStore } from '@/store/commandPalette';
import { useShortcutCheatsheetStore } from '@/store/shortcutCheatsheet';
import { useLayoutStore } from '@/store/layout';
import { useSldStore } from '@/store/sld';
import { useHotkeys } from '@/lib/useHotkeys';
import { GlobalShortcuts } from '@/lib/useGlobalShortcuts';
import { useTheme } from '@/lib/useTheme';

// The palette (with ``cmdk``) and the cheatsheet are fetched the first time
// they open, not with the shell.
const CommandPalette = lazyNamed(() => import('./CommandPalette'), 'CommandPalette', 'overlay');
const ShortcutCheatsheet = lazyNamed(
  () => import('./ShortcutCheatsheet'),
  'ShortcutCheatsheet',
  'overlay',
);

/**
 * AppShell. Top-level v3 IDE-style 4-pane layout (Unit 1 of the v3 IDE
 * layout plan).
 *
 * Layout:
 *
 * ```
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ TopBar (44px, slots: left | center | right)                      │
 * ├────────────┬─────────────────────────────────────┬───────────────┤
 * │ LeftSidebar│      Canvas (SldCanvas)             │RightInspector │
 * │            │                                     │               │
 * │            ├─────────────────────────────────────┴───────────────┤
 * │            │      BottomDrawer                                   │
 * └────────────┴─────────────────────────────────────────────────────┘
 * ```
 *
 * Implementation notes:
 *
 * - Three nested ``Group``s of ``react-resizable-panels`` per the v3 plan
 *   KTD-1: outer horizontal (LeftSidebar | RightSide); right-side vertical
 *   (TopRow | BottomDrawer); top-row horizontal (Canvas | RightInspector).
 *   Sizes are given in percent of the group (``"20%"``): a bare number is
 *   pixels to the library.
 * - Layout state (collapse + sizes + active tabs) lives on
 *   ``useLayoutStore`` (NOT ``useUiStore``, per F-FEAS-1 resolution) and
 *   persists to localStorage via the persist middleware. Each panel's
 *   imperative handle is wired by effect to the store value so the
 *   layout state IS the source of truth. The widths of the sidebar and
 *   the inspector the user dragged to are kept by the library
 *   (``useDefaultLayout``, under the keys they always had); the height of
 *   the drawer is the store's, which the drawer's group starts from.
 * - Inspector visibility model: per the F-DESIGN-2 resolution, the
 *   inspector panel collapses to size=0 when no element is selected AND
 *   the user explicitly toggled it closed. The user can manually open
 *   the panel via Unit 2's TopBar toggle even with no selection — in
 *   that case the panel renders an EmptyState. The visibility predicate
 *   is ``selectedNodeId !== null OR rightInspectorCollapsed === false``.
 *   When the predicate is true, ``panelRef.expand()`` runs in an effect;
 *   when false, ``panelRef.collapse()`` runs.
 * - The ``dockOverlay`` slot is positioned absolutely over the right
 *   side's canvas + inspector + drawer column (NOT the old dock — the
 *   dock is gone). AddElementPanel keeps its existing
 *   ``absolute right-0 w-[420px]`` self-positioning per the F-FEAS-4
 *   resolution.
 * - Modals (RuntimeCrashModal) render via the ``modal`` slot at the end
 *   of the tree so Radix's portal mounts above the shell.
 *
 * --- Spike-phase findings (v3 Unit 1 placeholder spike, 2026-05-10) ---
 *
 * Per the F-DESIGN-3 resolution, the chassis was first wired with simple
 * placeholder content to exercise four edge cases against
 * ``react-resizable-panels``. Findings (on version 2 of it, whose
 * ``PanelGroup`` is ``Group`` in version 4; they still hold):
 *
 *  (a) Imperative resize collision (``panelRef.expand()`` immediately
 *      followed by ``panelRef.resize(40)`` in the same tick): the
 *      ``resize()`` call wins. The lib reconciles in a single
 *      synchronous pass; no setTimeout-0 workaround needed. Persistence
 *      via ``onLayout`` writes the post-resize value, so localStorage
 *      stays consistent.
 *
 *  (b) Focus trap in size=0 panel (a ``<button>`` inside a panel with
 *      ``collapsedSize={0}`` after ``panelRef.collapse()``): focus DOES
 *      enter the invisible button on Tab cycle. The lib renders the
 *      panel's children even at size=0 — there is no implicit
 *      ``unmountOnCollapse``. Mitigation: gate panel children by the
 *      ``isCollapsed`` derived state, or render placeholder content
 *      that's intentionally non-interactive at size=0. This unit gates
 *      the right-inspector children behind the visibility predicate so
 *      its EmptyState only mounts when the panel is expanded.
 *
 *  (c) Corner handle conflict at the canvas/inspector vertical handle
 *      meeting the topRow/drawer horizontal handle: the handles are
 *      siblings under different ``PanelGroup``s, so the lib hands the
 *      pointer to whichever handle's hit-target is registered first at
 *      the corner pixel. In practice the bottom (horizontal) handle
 *      wins because it's painted on top in DOM order. No deadlock,
 *      no pointer leak; user can drag whichever handle their cursor
 *      starts over and the lib drops the other on pointermove. No
 *      4-px dead zone needed at this resolution; revisit if Unit 17
 *      design-iterator finds the corner cursor flickers.
 *
 *  (d) ``defaultSize=0`` + ``minSize=20`` contradiction: the lib
 *      *snaps to ``minSize``* on first mount when ``collapsible`` is
 *      false. With ``collapsible=true`` + ``collapsedSize=0`` +
 *      ``defaultSize=0``, the panel boots in the collapsed state and
 *      respects the 0. Implication: the right-inspector panel uses
 *      ``collapsible=true`` + ``collapsedSize=0`` + ``defaultSize=0``
 *      (NOT a positive ``minSize`` with no ``collapsedSize``) so the
 *      first-paint state matches the persisted preference. Expand
 *      target comes from ``rightInspectorWidthPx`` translated to a
 *      percentage in the effect that calls ``panelRef.expand()``.
 *
 * Conventions to follow (from `web/AGENTS.md`):
 *
 * - Form-input contract: use `<Input>` from `@/components/ui/Input`.
 * - Toast policy: form validation inline (`role="alert"`); transient
 *   action result via `toast.*`; recovery transitions toast.
 * - Keyboard policy: use `useHotkeys`; never `window.addEventListener('keydown')`.
 * - Theme: `.dark` class on `<html>`; semantic tokens, no hex.
 * - testid kebab-case.
 */
export interface AppShellProps {
  /** Top-bar slots. */
  topBarLeft?: ReactNode;
  topBarCenter?: ReactNode;
  topBarRight?: ReactNode;
  /** Left sidebar content (case nav now; ComponentLibrary etc. arrive in Unit 3). */
  leftSidebar?: ReactNode;
  /** Center canvas content (SLD). */
  canvas?: ReactNode;
  /** Right inspector content (Unit 7 supplies the populated accordion). */
  rightInspector?: ReactNode;
  /** Bottom drawer content (Unit 11 supplies the tab strip + grid bodies). */
  bottomDrawer?: ReactNode;
  /**
   * Full-space results page (v3.1). When ``useLayoutStore.resultsViewActive``
   * is true the shell short-circuits the canvas/inspector/drawer chassis and
   * mounts this single region instead, so plots/tables get the whole content
   * area. The TopBar + overlays stay mounted in both branches.
   */
  resultsView?: ReactNode;
  /**
   * Floating overlay anchored over the canvas/inspector/drawer column.
   * Hosts AddElementPanel and any non-modal banners (NumericalErrorBanner,
   * ConvergenceErrorPanel) that need to sit above the chassis content
   * without taking layout space. Each child owns its own absolute
   * positioning math — the slot just provides a positioned container
   * (per F-FEAS-4 resolution).
   */
  dockOverlay?: ReactNode;
  /** Top-level overlay slot for modals. */
  modal?: ReactNode;
}

export function AppShell({
  topBarLeft,
  topBarCenter,
  topBarRight,
  leftSidebar,
  canvas,
  rightInspector,
  bottomDrawer,
  resultsView,
  dockOverlay,
  modal,
}: AppShellProps) {
  // Theme bridge (Unit 12). Mounts once at AppShell so the matchMedia
  // listener that tracks `prefers-color-scheme` is single-mounted.
  useTheme();

  // ⌘K / Ctrl+K opens the command palette (Unit 9). Per AGENTS.md this
  // is one of the rare global shortcuts that fires inside form tags.
  const togglePalette = useCommandPaletteStore((s) => s.togglePalette);
  useHotkeys(
    'meta+k, ctrl+k',
    (event) => {
      event.preventDefault();
      togglePalette();
    },
    { enableOnFormTags: ['INPUT', 'TEXTAREA'] },
    [togglePalette],
  );

  // ? opens the keyboard cheatsheet (Unit 10). Inherits the project
  // default `enableOnFormTags: false`.
  const toggleCheatsheet = useShortcutCheatsheetStore((s) => s.toggleCheatsheet);
  useHotkeys(
    '?',
    (event) => {
      event.preventDefault();
      toggleCheatsheet();
    },
    undefined,
    [toggleCheatsheet],
  );

  // v3.1 — full-space results view. When active we render a single
  // results region in place of the canvas/inspector/drawer chassis.
  const resultsViewActive = useLayoutStore((s) => s.resultsViewActive);

  return (
    <div
      className={cn(
        'flex h-screen w-screen flex-col',
        'bg-background text-foreground',
        'relative overflow-hidden',
      )}
    >
      <TopBar left={topBarLeft} center={topBarCenter} right={topBarRight} />

      {resultsViewActive ? (
        /* v3.1 full-space results view — a top-level conditional render
           (NOT an imperative panel collapse) per the plan: simpler than
           driving the fragile inspectorVisible/syncPanel logic to size=0,
           and it guarantees the diagram + parameters are fully unmounted
           ("hide the system and its parameters"). The TopBar above + the
           modal/overlay/Toaster/palette below stay mounted in both
           branches so global affordances keep working. */
        <main
          aria-label="Results"
          data-testid="app-shell-results-view"
          className="bg-background flex min-h-0 flex-1 flex-col"
        >
          {resultsView}
        </main>
      ) : (
        <ShellPanels
          leftSidebar={leftSidebar}
          canvas={canvas}
          rightInspector={rightInspector}
          bottomDrawer={bottomDrawer}
          dockOverlay={dockOverlay}
        />
      )}

      {modal}

      {/* Global toast surface (v2.0 polish Unit 3). */}
      <Toaster />

      {/* Global command palette (v2.0 polish Unit 9) and keyboard-shortcut
          cheatsheet (v2.0 polish Unit 10). */}
      <GlobalOverlays />

      {/* Per-command shortcut registrar (v2.0 polish Unit 10). */}
      <GlobalShortcuts />

      {/* First-run coach (v2.0 polish Unit 13). */}
      <FirstRunCoach />
    </div>
  );
}

/** The ids of the shell's panels, by which the layouts of their groups are keyed. */
const PANEL = {
  sidebar: 'app-shell-left-sidebar-panel',
  rightSide: 'app-shell-right-side-panel',
  topRow: 'app-shell-top-row-panel',
  canvas: 'app-shell-canvas-panel',
  inspector: 'app-shell-right-inspector-panel',
  drawer: 'app-shell-bottom-drawer-panel',
} as const;

type ShellPanelsProps = Pick<
  AppShellProps,
  'leftSidebar' | 'canvas' | 'rightInspector' | 'bottomDrawer' | 'dockOverlay'
>;

/**
 * The chassis: the sidebar, the diagram, the inspector and the drawer in
 * their three groups of panels, and the overlay over them. The results view
 * takes their place, and they are mounted again when it is left, so they
 * start each time from the layout store as it is then: a drawer dragged
 * higher, a sidebar hidden from the results view, are drawn as they now are.
 */
function ShellPanels({
  leftSidebar,
  canvas,
  rightInspector,
  bottomDrawer,
  dockOverlay,
}: ShellPanelsProps) {
  // Layout state — driven by useLayoutStore (NOT useUiStore) per F-FEAS-1.
  const leftSidebarCollapsed = useLayoutStore((s) => s.leftSidebarCollapsed);
  const bottomDrawerCollapsed = useLayoutStore((s) => s.bottomDrawerCollapsed);
  const rightInspectorCollapsed = useLayoutStore((s) => s.rightInspectorCollapsed);
  const setBottomDrawerHeightPct = useLayoutStore((s) => s.setBottomDrawerHeightPct);
  const setBottomDrawerCollapsed = useLayoutStore((s) => s.setBottomDrawerCollapsed);
  const setLeftSidebarWidthPct = useLayoutStore((s) => s.setLeftSidebarWidthPct);
  const setRightInspectorWidthPct = useLayoutStore((s) => s.setRightInspectorWidthPct);

  // Selection state drives inspector visibility per F-DESIGN-2.
  const selectedNodeId = useSldStore((s) => s.selectedNodeId);
  // Inspector is visible when the user has either selected something OR
  // explicitly opened the panel via the (Unit 2) toggle.
  const inspectorVisible = selectedNodeId !== null || !rightInspectorCollapsed;

  const leftSidebarPanelRef = useRef<PanelImperativeHandle>(null);
  const rightInspectorPanelRef = useRef<PanelImperativeHandle>(null);
  const bottomDrawerPanelRef = useRef<PanelImperativeHandle>(null);

  // The widths the sidebar and the inspector were dragged to, as the
  // library keeps them, under the keys of the groups' ``autoSaveId`` of
  // version 2 of it, whose layouts it reads.
  const outerLayout = useDefaultLayout({
    id: 'tensa:layout-v1:outer',
    storage: panelLayoutStorage,
  });
  const topRowLayout = useDefaultLayout({
    id: 'tensa:layout-v1:top-row',
    storage: panelLayoutStorage,
  });
  // What the groups start from, taken when the panels mount: a panel whose
  // size props change is registered with its group again, and the drawer's
  // height changes on every step of a drag. Each panel is open or shut as
  // the store has it, which the results view may have changed while the
  // panels were not drawn. Open, the sidebar and the inspector are as wide
  // as the library kept them, or, when it kept them shut, as they were last
  // open; the drawer is as high as the store keeps it, or at its tab strip.
  const [initial] = useState(() => {
    const { leftSidebarWidthPct, rightInspectorWidthPct, bottomDrawerHeightPct } =
      useLayoutStore.getState();
    const sidebar = leftSidebarCollapsed
      ? 0
      : openWidth(outerLayout.defaultLayout?.[PANEL.sidebar], leftSidebarWidthPct);
    const inspector = inspectorVisible
      ? openWidth(topRowLayout.defaultLayout?.[PANEL.inspector], rightInspectorWidthPct)
      : 0;
    const drawer = bottomDrawerCollapsed ? bottomDrawerSizes(0).strip : bottomDrawerHeightPct;
    return {
      outer: { [PANEL.sidebar]: sidebar, [PANEL.rightSide]: 100 - sidebar } satisfies Layout,
      topRow: { [PANEL.canvas]: 100 - inspector, [PANEL.inspector]: inspector } satisfies Layout,
      rightSide: { [PANEL.topRow]: 100 - drawer, [PANEL.drawer]: drawer } satisfies Layout,
    };
  });

  // The column the drawer shares with the diagram, measured: the group of
  // panels the drawer is in. The panels are sized in percent of it, and the
  // drawer needs so many pixels whatever the window: its tab strip when it
  // is shut, and a table with a row or two when it is open
  // (`bottomDrawerSizes`).
  const [drawerSection, setDrawerSection] = useState<HTMLElement | null>(null);
  const [columnHeight, setColumnHeight] = useState(0);
  // The sizes for the height measured last, for what reads them outside a
  // render. They are written where the column is measured, so they are the
  // new ones before the render the measure starts, in which the panels size
  // the drawer again (below).
  const drawerSizesRef = useRef<DrawerSizes>(bottomDrawerSizes(0));
  useLayoutEffect(() => {
    const column = drawerSection?.closest<HTMLElement>('[data-group]');
    if (!column) return;
    const measure = (): void => {
      const height = column.clientHeight;
      drawerSizesRef.current = bottomDrawerSizes(height);
      setColumnHeight(height);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    return () => observer.disconnect();
  }, [drawerSection]);
  const drawerSizes = useMemo(() => bottomDrawerSizes(columnHeight), [columnHeight]);

  // First-mount guard. The groups pick up their layouts on first paint,
  // which already reflect the persisted state (the library's, and the
  // layout store's). Calling the imperative API on first mount would throw
  // (the lib has no layout for a group it has not measured yet) AND would
  // do redundant work. Subsequent store-driven updates do need the
  // imperative call so toggle buttons can flip the panel without mounting
  // the group again (which would lose the user's post-mount drag
  // adjustments).
  const firstMountRef = useRef(true);

  // Keep the LeftSidebar panel in sync with the store on store change. It
  // opens to the width it was last open at, which the library forgets with
  // the page.
  useEffect(() => {
    if (firstMountRef.current) return;
    syncPanel(
      leftSidebarPanelRef.current,
      leftSidebarCollapsed,
      useLayoutStore.getState().leftSidebarWidthPct,
    );
  }, [leftSidebarCollapsed]);

  // Keep the BottomDrawer panel in sync with the store on store change. A
  // drawer that is opened opens to the height the store keeps, and shows
  // its content: one that was dragged shut, or nearly, opens to the height
  // it has by default.
  useEffect(() => {
    if (firstMountRef.current) return;
    syncPanel(
      bottomDrawerPanelRef.current,
      bottomDrawerCollapsed,
      useLayoutStore.getState().bottomDrawerHeightPct,
    );
    if (!bottomDrawerCollapsed) openEnough(bottomDrawerPanelRef.current, drawerSizesRef.current);
  }, [bottomDrawerCollapsed]);

  // Keep the RightInspector panel in sync with the visibility predicate.
  // Per spike finding (a): expand() then resize() in the same tick
  // works without a setTimeout workaround; we expand to the width it was
  // last open at, kept in the store as a % of the top-row horizontal
  // group.
  useEffect(() => {
    if (firstMountRef.current) return;
    // inspectorVisible === true means we want the panel expanded, so
    // pass collapsed=!visible to the helper.
    syncPanel(
      rightInspectorPanelRef.current,
      !inspectorVisible,
      useLayoutStore.getState().rightInspectorWidthPct,
    );
  }, [inspectorVisible]);

  // Flip the first-mount guard after the initial paint completes. The
  // separate effect ensures the three sync effects above see
  // ``firstMountRef.current === true`` on their first run.
  useEffect(() => {
    firstMountRef.current = false;
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1">
      {/* Outer horizontal split: LeftSidebar | RightSide */}
      <Group
        orientation="horizontal"
        defaultLayout={initial.outer}
        onLayoutChanged={(layout, meta) => {
          outerLayout.onLayoutChanged(layout, meta);
          // The width the sidebar opens to again. Shut, it has none.
          const sidebar = layout[PANEL.sidebar];
          if (sidebar !== undefined && sidebar > 0) setLeftSidebarWidthPct(sidebar);
        }}
        className="flex h-full w-full"
      >
        <Panel
          panelRef={leftSidebarPanelRef}
          id={PANEL.sidebar}
          collapsible
          defaultSize="20%"
          collapsedSize="0%"
          minSize="15%"
          maxSize="40%"
          className="flex min-w-0 flex-col"
        >
          <aside
            aria-label="Case navigation"
            data-testid="app-shell-left-sidebar"
            data-collapsed={leftSidebarCollapsed ? 'true' : 'false'}
            className={cn(
              'flex h-full min-h-0 min-w-0 flex-col',
              'border-border bg-background border-r',
            )}
          >
            {/* Children only render when expanded — spike finding (b):
              the lib does NOT auto-unmount panel children at
              size=0, so a focus trap would form against any
              interactive element inside. Gating by collapsed
              prevents that. */}
            {!leftSidebarCollapsed ? leftSidebar : null}
          </aside>
        </Panel>

        <ResizeHandle direction="horizontal" label="Resize left sidebar" />

        <Panel
          id={PANEL.rightSide}
          defaultSize="80%"
          minSize="60%"
          className="flex min-w-0 flex-col"
        >
          {/* Right-side vertical split: TopRow | BottomDrawer */}
          <Group
            orientation="vertical"
            defaultLayout={initial.rightSide}
            className="flex h-full w-full"
            onLayoutChange={(layout) => {
              // Persist the drawer's size whenever the user drags. The
              // persist middleware batches writes so this is safe
              // per-pointer-move.
              const drawerPct = layout[PANEL.drawer];
              if (typeof drawerPct !== 'number') return;
              // Collapsed is what the drawer is while it is down at its
              // tab strip, however it got there: dragged down (it snaps
              // there from under the least height it has open) as well
              // as toggled. Only the strip is drawn then, and a click on
              // a tab opens it again; dragged up from there it is open,
              // and shows its content. The strip is no height to come
              // back to, so it is not kept as one.
              // Read as they are now, not as they were when this was
              // handed over: the drawer is sized again as soon as the
              // height of its strip in percent changes, before the
              // panels have this callback of the same render.
              const atStrip = drawerPct <= drawerSizesRef.current.strip + 0.5;
              if (atStrip !== useLayoutStore.getState().bottomDrawerCollapsed) {
                setBottomDrawerCollapsed(atStrip);
              }
              if (!atStrip) setBottomDrawerHeightPct(drawerPct);
            }}
          >
            <Panel
              id={PANEL.topRow}
              // The diagram keeps a height it can be used at, in pixels
              // (`CANVAS_MIN_PX`), whatever the drawer was left at.
              minSize={`${drawerSizes.canvasMin}%`}
              className="flex min-w-0 flex-col"
            >
              {/* Top-row horizontal split: Canvas | RightInspector */}
              <Group
                orientation="horizontal"
                defaultLayout={initial.topRow}
                onLayoutChanged={(layout, meta) => {
                  topRowLayout.onLayoutChanged(layout, meta);
                  // The width the inspector opens to again, as for the sidebar.
                  const inspector = layout[PANEL.inspector];
                  if (inspector !== undefined && inspector > 0) {
                    setRightInspectorWidthPct(inspector);
                  }
                }}
                className="flex h-full w-full"
              >
                <Panel
                  id={PANEL.canvas}
                  defaultSize="75%"
                  minSize="30%"
                  className="flex min-w-0 flex-col"
                >
                  <main
                    aria-label="Single-line diagram"
                    data-testid="app-shell-canvas"
                    className="bg-background flex h-full min-h-0 min-w-0 flex-1 flex-col"
                  >
                    {canvas}
                  </main>
                </Panel>

                <ResizeHandle direction="horizontal" label="Resize canvas and inspector" />

                <Panel
                  panelRef={rightInspectorPanelRef}
                  id={PANEL.inspector}
                  collapsible
                  defaultSize={`${initial.topRow[PANEL.inspector]}%`}
                  collapsedSize="0%"
                  minSize="18%"
                  maxSize="45%"
                  className="flex min-w-0 flex-col"
                >
                  <aside
                    aria-label="Inspector"
                    data-testid="app-shell-right-inspector"
                    data-collapsed={inspectorVisible ? 'false' : 'true'}
                    className={cn(
                      'flex h-full min-h-0 min-w-0 flex-col',
                      'border-border bg-background border-l',
                    )}
                  >
                    {/* Per spike finding (b), gate children behind the
                      visibility predicate. When inspectorVisible is
                      true but no rightInspector content was supplied
                      AND no element is selected, render an
                      EmptyState (the F-DESIGN-2 "manually opened
                      with no selection" case). */}
                    {inspectorVisible
                      ? (rightInspector ?? (
                          <EmptyState
                            icon={<CursorIcon />}
                            title="Nothing selected"
                            description="Select an element on the canvas or a row in the data grid to inspect its properties."
                            emptyStateKey="app-shell-right-inspector"
                          />
                        ))
                      : null}
                  </aside>
                </Panel>
              </Group>
            </Panel>

            <ResizeHandle direction="vertical" label="Resize bottom drawer" />

            <Panel
              panelRef={bottomDrawerPanelRef}
              id={PANEL.drawer}
              collapsible
              // Collapsed, it is as high as its tab strip (KTD-7: a
              // 32px collapsed bar), whatever that is in percent of
              // the column at the height the window has.
              collapsedSize={`${drawerSizes.strip}%`}
              // Open, it is never lower than a table needs for its
              // bar, its heading and a row or two: dragged below
              // that it snaps down to its tab strip.
              minSize={`${drawerSizes.openMin}%`}
              // No higher than leaves the diagram its least height.
              maxSize={`${Math.min(75, 100 - drawerSizes.canvasMin)}%`}
              className="flex min-w-0 flex-col"
            >
              <section
                ref={setDrawerSection}
                aria-label="Bottom drawer"
                data-testid="app-shell-bottom-drawer"
                data-collapsed={bottomDrawerCollapsed ? 'true' : 'false'}
                className={cn(
                  'flex h-full min-h-0 min-w-0 flex-col',
                  'border-border bg-background border-t',
                )}
              >
                {bottomDrawer}
              </section>
            </Panel>
          </Group>
        </Panel>
      </Group>

      {/* dockOverlay slot — absolutely positioned over the canvas +
        inspector + drawer column. The wrapper is
        ``pointer-events-none`` so it never intercepts clicks on the
        chassis surfaces below; each overlay child (AddElementPanel,
        ConvergenceErrorPanel, NumericalErrorBanner) is responsible
        for adding ``pointer-events-auto`` on its own visible panel
        when it actually renders content. Children that return null
        when inactive contribute zero hit-testing surface. */}
      {dockOverlay ? (
        <div data-testid="app-shell-dock-overlay" className="pointer-events-none absolute inset-0">
          {dockOverlay}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The width a panel the store has open starts at: the width the library
 * kept for it, or the width it was last open at where the library kept
 * none, or kept the panel shut (it was shown from the results view, while
 * its group was not drawn).
 */
function openWidth(kept: number | undefined, lastOpen: number): number {
  return kept !== undefined && kept > 0 ? kept : lastOpen;
}

/**
 * The command palette and the shortcut cheatsheet, mounted the first time their
 * store flag opens them. The flags are read here, not in ``AppShell``, so that
 * opening either one does not re-render the whole shell.
 */
function GlobalOverlays() {
  const paletteOpen = useCommandPaletteStore((s) => s.open);
  const closePalette = useCommandPaletteStore((s) => s.closePalette);
  const cheatsheetOpen = useShortcutCheatsheetStore((s) => s.open);
  const closeCheatsheet = useShortcutCheatsheetStore((s) => s.closeCheatsheet);
  return (
    <>
      <LazyMount when={paletteOpen} onLoadFailed={closePalette}>
        <CommandPalette />
      </LazyMount>
      <LazyMount when={cheatsheetOpen} onLoadFailed={closeCheatsheet}>
        <ShortcutCheatsheet />
      </LazyMount>
    </>
  );
}

/**
 * Imperatively collapse/expand a panel handle, swallowing the throw the
 * lib raises when called before its group has a layout (it has none
 * until it has been measured). That race happens in jsdom (where layout
 * never resolves) and on the very first mount tick in production. A
 * panel that is expanded is resized to `openTo`, in percent of its group:
 * the size it was last open at. The lib keeps that only while the group is
 * mounted, and expands a panel it has not seen open to its ``minSize``.
 */
function syncPanel(
  panel: PanelImperativeHandle | null,
  shouldBeCollapsed: boolean,
  openTo: number,
): void {
  if (!panel) return;
  try {
    if (shouldBeCollapsed && !panel.isCollapsed()) {
      panel.collapse();
    } else if (!shouldBeCollapsed && panel.isCollapsed()) {
      panel.expand();
      panel.resize(`${openTo}%`);
    }
  } catch {
    // Pre-layout call. The group picks up its layout on first paint,
    // which already matches the persisted state. Subsequent store
    // updates re-fire this effect once the group has a layout.
  }
}

/**
 * Give the bottom drawer its usual height where it opened to the least it
 * can have: a drawer that was dragged down to its tab strip has no height
 * to come back to, and opens to about a third of its column.
 */
function openEnough(panel: PanelImperativeHandle | null, sizes: DrawerSizes): void {
  if (!panel) return;
  try {
    if (panel.getSize().asPercentage <= sizes.openMin + 0.5) panel.resize(`${sizes.open}%`);
  } catch {
    // Not registered yet: see `syncPanel`.
  }
}

interface ResizeHandleProps {
  direction: 'horizontal' | 'vertical';
  label: string;
}

function ResizeHandle({ direction, label }: ResizeHandleProps) {
  // 4px draggable bar with hover + drag affordance per the v3 spec.
  // Mirrors the styling pattern from the v2 AppShell handles so the
  // new chassis reads as the same visual family. (The v2 RightDock
  // wrapper that originally seeded this style was retired in v3 Unit
  // 15; the visual contract lives on here.) The lib takes the pointer a
  // few pixels either side of the bar as well, and says so in
  // ``data-separator`` (``hover``, then ``active`` while it is dragged).
  // A double-click would set the panel beside it to its default size,
  // past the store, which says whether the panel is open: it does
  // nothing, as before.
  return (
    <Separator
      aria-label={label}
      disableDoubleClick
      className={cn(
        'group relative flex shrink-0 items-center justify-center',
        direction === 'horizontal' ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',
        'bg-border hover:bg-primary/70 data-[separator=hover]:bg-primary/70',
        'transition-colors duration-[var(--duration-fast)]',
        'data-[separator=active]:bg-primary',
        'focus-visible:bg-primary focus-visible:outline-none',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'block rounded-full',
          // Hover/drag grow the inner pill so the handle "lifts" toward
          // the user — the bar itself remains 4px so layout doesn't shift.
          direction === 'horizontal'
            ? 'h-8 w-[2px] group-hover:h-12 group-data-[separator=hover]:h-12'
            : 'h-[2px] w-8 group-hover:w-12 group-data-[separator=hover]:w-12',
          'bg-muted-foreground/30 group-hover:bg-primary-foreground/90',
          'group-data-[separator=hover]:bg-primary-foreground/90',
          'group-data-[separator=active]:bg-primary-foreground',
          'transition-all duration-[var(--duration-fast)]',
        )}
      />
    </Separator>
  );
}
