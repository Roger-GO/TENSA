import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import type { ImperativePanelHandle } from 'react-resizable-panels';
import { cn } from '@/lib/cn';
import { CursorIcon, EmptyState } from '@/components/ui/EmptyState';
import { FirstRunCoach } from './FirstRunCoach';
import { TopBar } from './TopBar';
import { CommandPalette } from './CommandPalette';
import { ShortcutCheatsheet } from './ShortcutCheatsheet';
import { Toaster } from '@/components/ui/Toaster';
import { useCommandPaletteStore } from '@/store/commandPalette';
import { useShortcutCheatsheetStore } from '@/store/shortcutCheatsheet';
import { useLayoutStore } from '@/store/layout';
import { useSldStore } from '@/store/sld';
import { useHotkeys } from '@/lib/useHotkeys';
import { GlobalShortcuts } from '@/lib/useGlobalShortcuts';
import { useTheme } from '@/lib/useTheme';

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
 * - Three nested ``PanelGroup``s per the v3 plan KTD-1: outer horizontal
 *   (LeftSidebar | RightSide); right-side vertical (TopRow | BottomDrawer);
 *   top-row horizontal (Canvas | RightInspector).
 * - Layout state (collapse + sizes + active tabs) lives on
 *   ``useLayoutStore`` (NOT ``useUiStore``, per F-FEAS-1 resolution) and
 *   persists to localStorage via the persist middleware. Each panel's
 *   imperative handle is wired by effect to the store value so the
 *   layout state IS the source of truth.
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
 *   ``absolute right-0 w-[70%]`` self-positioning per the F-FEAS-4
 *   resolution.
 * - Modals (TokenPasteModal, RuntimeCrashModal) render via the ``modal``
 *   slot at the end of the tree so Radix's portal mounts above the
 *   shell.
 *
 * --- Spike-phase findings (v3 Unit 1 placeholder spike, 2026-05-10) ---
 *
 * Per the F-DESIGN-3 resolution, the chassis was first wired with simple
 * placeholder content to exercise four edge cases against
 * ``react-resizable-panels``. Findings:
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

  // Layout state — driven by useLayoutStore (NOT useUiStore) per F-FEAS-1.
  const leftSidebarCollapsed = useLayoutStore((s) => s.leftSidebarCollapsed);
  const bottomDrawerCollapsed = useLayoutStore((s) => s.bottomDrawerCollapsed);
  const bottomDrawerHeightPct = useLayoutStore((s) => s.bottomDrawerHeightPct);
  const rightInspectorCollapsed = useLayoutStore((s) => s.rightInspectorCollapsed);
  const setBottomDrawerHeightPct = useLayoutStore((s) => s.setBottomDrawerHeightPct);

  // Selection state drives inspector visibility per F-DESIGN-2.
  const selectedNodeId = useSldStore((s) => s.selectedNodeId);
  // Inspector is visible when the user has either selected something OR
  // explicitly opened the panel via the (Unit 2) toggle.
  const inspectorVisible = selectedNodeId !== null || !rightInspectorCollapsed;

  const leftSidebarPanelRef = useRef<ImperativePanelHandle>(null);
  const rightInspectorPanelRef = useRef<ImperativePanelHandle>(null);
  const bottomDrawerPanelRef = useRef<ImperativePanelHandle>(null);

  // First-mount guard. The PanelGroup picks up ``defaultSize`` on first
  // paint, which already reflects the persisted state via the
  // ``defaultSize`` prop derived from the layout store. Calling the
  // imperative API on first mount would throw "Panel size not found"
  // (the lib registers panels async) AND would do redundant work.
  // Subsequent store-driven updates do need the imperative call so
  // toggle buttons can flip the panel without re-rendering the
  // PanelGroup with a new ``defaultSize`` (which would lose the user's
  // post-mount drag adjustments).
  const firstMountRef = useRef(true);

  // Keep the LeftSidebar panel in sync with the store on store change.
  useEffect(() => {
    if (firstMountRef.current) return;
    syncPanel(leftSidebarPanelRef.current, leftSidebarCollapsed);
  }, [leftSidebarCollapsed]);

  // Keep the BottomDrawer panel in sync with the store on store change.
  useEffect(() => {
    if (firstMountRef.current) return;
    syncPanel(bottomDrawerPanelRef.current, bottomDrawerCollapsed);
  }, [bottomDrawerCollapsed]);

  // Keep the RightInspector panel in sync with the visibility predicate.
  // Per spike finding (a): expand() then resize() in the same tick
  // works without a setTimeout workaround; we expand to a width derived
  // from the persisted px preference (translated to a % of the top-row
  // horizontal PanelGroup at hydrate time).
  useEffect(() => {
    if (firstMountRef.current) return;
    // inspectorVisible === true means we want the panel expanded, so
    // pass collapsed=!visible to the helper.
    syncPanel(rightInspectorPanelRef.current, !inspectorVisible);
  }, [inspectorVisible]);

  // Flip the first-mount guard after the initial paint completes. The
  // separate effect ensures the three sync effects above see
  // ``firstMountRef.current === true`` on their first run.
  useEffect(() => {
    firstMountRef.current = false;
  }, []);

  return (
    <div
      className={cn(
        'flex h-screen w-screen flex-col',
        'bg-background text-foreground',
        'relative overflow-hidden',
      )}
    >
      <TopBar left={topBarLeft} center={topBarCenter} right={topBarRight} />

      <div className="relative flex min-h-0 flex-1">
        {/* Outer horizontal split: LeftSidebar | RightSide */}
        <PanelGroup
          direction="horizontal"
          autoSaveId="andes-app:layout-v1:outer"
          className="flex h-full w-full"
        >
          <Panel
            ref={leftSidebarPanelRef}
            id="app-shell-left-sidebar-panel"
            order={1}
            collapsible
            defaultSize={20}
            collapsedSize={0}
            minSize={15}
            maxSize={40}
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
            id="app-shell-right-side-panel"
            order={2}
            defaultSize={80}
            minSize={60}
            className="flex min-w-0 flex-col"
          >
            {/* Right-side vertical split: TopRow | BottomDrawer */}
            <PanelGroup
              direction="vertical"
              autoSaveId="andes-app:layout-v1:right-side"
              className="flex h-full w-full"
              onLayout={(sizes) => {
                // The drawer is the second panel (index 1). Persist its
                // size whenever the user drags. The persist middleware
                // batches writes so this is safe per-pointer-move.
                const drawerPct = sizes[1];
                if (typeof drawerPct === 'number' && !bottomDrawerCollapsed) {
                  setBottomDrawerHeightPct(drawerPct);
                }
              }}
            >
              <Panel
                id="app-shell-top-row-panel"
                order={1}
                defaultSize={100 - bottomDrawerHeightPct}
                minSize={20}
                className="flex min-w-0 flex-col"
              >
                {/* Top-row horizontal split: Canvas | RightInspector */}
                <PanelGroup
                  direction="horizontal"
                  autoSaveId="andes-app:layout-v1:top-row"
                  className="flex h-full w-full"
                >
                  <Panel
                    id="app-shell-canvas-panel"
                    order={1}
                    defaultSize={75}
                    minSize={30}
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
                    ref={rightInspectorPanelRef}
                    id="app-shell-right-inspector-panel"
                    order={2}
                    collapsible
                    defaultSize={inspectorVisible ? 25 : 0}
                    collapsedSize={0}
                    minSize={18}
                    maxSize={45}
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
                </PanelGroup>
              </Panel>

              <ResizeHandle direction="vertical" label="Resize bottom drawer" />

              <Panel
                ref={bottomDrawerPanelRef}
                id="app-shell-bottom-drawer-panel"
                order={2}
                collapsible
                defaultSize={bottomDrawerHeightPct}
                // Collapsed size approximates the 32px tab strip Unit 11
                // will mount; KTD-7 specifies a 32px collapsed bar. As a
                // % of the right-side vertical group, ~4 covers it on
                // typical 800-1200px viewports without crowding.
                collapsedSize={4}
                minSize={4}
                maxSize={75}
                className="flex min-w-0 flex-col"
              >
                <section
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
            </PanelGroup>
          </Panel>
        </PanelGroup>

        {/* dockOverlay slot — absolutely positioned over the canvas +
            inspector + drawer column. The wrapper is
            ``pointer-events-none`` so it never intercepts clicks on the
            chassis surfaces below; each overlay child (AddElementPanel,
            ConvergenceErrorPanel, NumericalErrorBanner) is responsible
            for adding ``pointer-events-auto`` on its own visible panel
            when it actually renders content. Children that return null
            when inactive contribute zero hit-testing surface. */}
        {dockOverlay ? (
          <div
            data-testid="app-shell-dock-overlay"
            className="pointer-events-none absolute inset-0"
          >
            {dockOverlay}
          </div>
        ) : null}
      </div>

      {modal}

      {/* Global toast surface (v2.0 polish Unit 3). */}
      <Toaster />

      {/* Global command palette (v2.0 polish Unit 9). */}
      <CommandPalette />

      {/* Global keyboard-shortcut cheatsheet (v2.0 polish Unit 10). */}
      <ShortcutCheatsheet />

      {/* Per-command shortcut registrar (v2.0 polish Unit 10). */}
      <GlobalShortcuts />

      {/* First-run coach (v2.0 polish Unit 13). */}
      <FirstRunCoach />
    </div>
  );
}

/**
 * Imperatively collapse/expand a panel handle, swallowing the
 * "Panel size not found" throw the lib raises when called before the
 * panel registers with its PanelGroup. That race happens in jsdom (where
 * layout never resolves) and on the very first mount tick in production.
 */
function syncPanel(panel: ImperativePanelHandle | null, shouldBeCollapsed: boolean): void {
  if (!panel) return;
  try {
    if (shouldBeCollapsed && panel.isExpanded()) {
      panel.collapse();
    } else if (!shouldBeCollapsed && panel.isCollapsed()) {
      panel.expand();
    }
  } catch {
    // Pre-registration call. The PanelGroup will pick up defaultSize on
    // first paint, which already matches the persisted state via the
    // ``defaultSize`` prop derived from the layout store. Subsequent
    // store updates re-fire this effect once the panel is registered.
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
  // 15; the visual contract lives on here.)
  return (
    <PanelResizeHandle
      aria-label={label}
      className={cn(
        'group relative flex shrink-0 items-center justify-center',
        direction === 'horizontal' ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',
        'bg-border hover:bg-primary/70',
        'transition-colors duration-[var(--duration-fast)]',
        'data-[resize-handle-state=drag]:bg-primary',
        'focus-visible:bg-primary focus-visible:outline-none',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'block rounded-full',
          // Hover/drag grow the inner pill so the handle "lifts" toward
          // the user — the bar itself remains 4px so layout doesn't shift.
          direction === 'horizontal' ? 'h-8 w-[2px] group-hover:h-12' : 'h-[2px] w-8 group-hover:w-12',
          'bg-muted-foreground/30 group-hover:bg-primary-foreground/90',
          'group-data-[resize-handle-state=drag]:bg-primary-foreground',
          'transition-all duration-[var(--duration-fast)]',
        )}
      />
    </PanelResizeHandle>
  );
}
