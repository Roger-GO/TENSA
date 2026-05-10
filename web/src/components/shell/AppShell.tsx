import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { cn } from '@/lib/cn';
import { EmptyState } from './EmptyState';
import { LeftRail } from './LeftRail';
import { RightDock } from './RightDock';
import { TopBar } from './TopBar';
import { CommandPalette } from './CommandPalette';
import { ShortcutCheatsheet } from './ShortcutCheatsheet';
import { Toaster } from '@/components/ui/Toaster';
import { SldCanvas } from '@/components/sld/SldCanvas';
import { useCaseStore } from '@/store/case';
import { useCommandPaletteStore } from '@/store/commandPalette';
import { useShortcutCheatsheetStore } from '@/store/shortcutCheatsheet';
import { useHotkeys } from '@/lib/useHotkeys';
import { GlobalShortcuts } from '@/lib/useGlobalShortcuts';

/**
 * AppShell. Top-level split-pane layout per R18.
 *
 * Layout:
 *
 * ```
 * ┌─────────────────────────────────────────────────────────┐
 * │ TopBar (44px, slots: left | center | right)            │
 * ├──────┬──────────────────────────────────┬───────────────┤
 * │      │                                  │ Inspector     │
 * │ Left │   Main canvas (≥ 60%, R18)       │ ──────────────│
 * │ Rail │                                  │ Results table │
 * │      │                                  │               │
 * └──────┴──────────────────────────────────┴───────────────┘
 * ```
 *
 * Composition rules:
 *
 * - The horizontal split (rail | main | dock) and the vertical sub-split
 *   inside the dock (inspector | results) both use `react-resizable-panels`
 *   with `autoSaveId` so the user's preferred sizes survive reloads. The
 *   library validates min/max bounds on read; we set explicit
 *   minSize/maxSize per panel as a defensive belt-and-braces.
 * - Modals (TokenPasteModal in Unit 5; runtime-crash modal per R8) render
 *   via the `modal` slot at the end of the tree so Radix's portal mounts
 *   above the shell.
 * - Tab order is the natural DOM order: top bar → left rail → main canvas
 *   → right dock. The shell does not override tabindex; visible focus
 *   rings come from `:focus-visible` styling defined in `globals.css` and
 *   per-component class lists.
 *
 * Wrapping (QueryClientProvider, auth modal mount, etc.) is intentionally
 * pushed up to `App.tsx` so the shell stays free of cross-cutting state.
 */
export interface AppShellProps {
  /** Top-bar slots. */
  topBarLeft?: ReactNode;
  topBarCenter?: ReactNode;
  topBarRight?: ReactNode;
  /** Left rail content (case nav). When omitted, an EmptyState renders. */
  leftRail?: ReactNode;
  /** Optional collapsed-state content for the left rail (icon stack). */
  leftRailCollapsed?: ReactNode;
  /** Main canvas content (SLD). When omitted, the pre-load EmptyState renders. */
  main?: ReactNode;
  /** Inspector content (right dock, top region). */
  inspector?: ReactNode;
  /** Results-table content (right dock, bottom region). */
  results?: ReactNode;
  /** Optional overlay banner above the dock contents (PF non-convergence, R8). */
  dockOverlay?: ReactNode;
  /** Top-level overlay slot for modals (TokenPasteModal lands here in Unit 5). */
  modal?: ReactNode;
}

const SMALL_VIEWPORT_BREAKPOINT_PX = 1024;

function getViewportTooSmall(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < SMALL_VIEWPORT_BREAKPOINT_PX;
}

export function AppShell({
  topBarLeft,
  topBarCenter,
  topBarRight,
  leftRail,
  leftRailCollapsed,
  main,
  inspector,
  results,
  dockOverlay,
  modal,
}: AppShellProps) {
  // Viewport-too-small fallback (R18): collapse the right dock entirely so
  // the SLD canvas remains usable. The user can still expand the rail/dock
  // by dragging the resize handle once they widen the window.
  const [viewportTooSmall, setViewportTooSmall] = useState<boolean>(() => getViewportTooSmall());

  // ⌘K / Ctrl+K opens the command palette (Unit 9). Per AGENTS.md
  // this is one of the rare global shortcuts that should ALSO fire
  // when an `<input>` / `<textarea>` has focus — a user typing in
  // the snapshot-name input still wants ⌘K to summon the palette.
  // The same binding is also declared in the command registry
  // (`help.command-palette`) so it surfaces in the cheatsheet; the
  // registry's binding uses the project-default `enableOnFormTags:
  // false` and so won't fire from inside an input — this AppShell-
  // local registration is the one that wins inside form tags. (No
  // duplicate fire: outside form tags, react-hotkeys-hook
  // de-duplicates by combo signature.)
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
  // default `enableOnFormTags: false`, so a user typing into an input
  // (where `?` would just be a literal question mark) does NOT see
  // the modal pop. The `help.shortcuts` registry entry binds the
  // SAME key — registering twice is intentional: the registry
  // surface keeps the cheatsheet visible to discovery (palette +
  // cheatsheet itself), and this AppShell-local registration
  // guarantees the binding stays mounted even if the registry
  // memoisation churns.
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

  // Default `main` slot content depends on whether a case is loaded:
  // - no case → EmptyState ("No case loaded") — directs the user to the
  //   left rail.
  // - case loaded → SldCanvas (which itself shows the layout-skeleton
  //   while ELK runs and the canvas once positions are known).
  // Callers that pass `main` explicitly retain full override control.
  const caseSelection = useCaseStore((s) => s.selection);
  const defaultMain =
    caseSelection !== null ? (
      <SldCanvas />
    ) : (
      <EmptyState
        title="No case loaded"
        description="Pick a case file from the left rail to begin."
      />
    );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setViewportTooSmall(getViewportTooSmall());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <div
      className={cn(
        'flex h-screen w-screen flex-col',
        'bg-background text-foreground',
        // any overlay we render at the modal slot is portaled above this
        'relative overflow-hidden',
      )}
    >
      <TopBar left={topBarLeft} center={topBarCenter} right={topBarRight} />

      <div className="flex min-h-0 flex-1">
        <PanelGroup
          direction="horizontal"
          autoSaveId="andes-app:layout:main"
          className="flex h-full w-full"
        >
          {/* Left rail. The rail's width is fixed at 240px expanded /
              48px collapsed — it is not a user-resizable Panel. We render
              it as a plain flex child so the PanelGroup only manages the
              main canvas + dock split. */}
          <div className="flex h-full shrink-0">
            <LeftRail
              forceCollapsed={viewportTooSmall ? true : undefined}
              collapsedContent={leftRailCollapsed}
            >
              {leftRail}
            </LeftRail>
          </div>

          <Panel
            id="main-canvas"
            order={1}
            defaultSize={viewportTooSmall ? 100 : 65}
            minSize={30}
            maxSize={90}
            className="flex min-w-0 flex-col"
          >
            <main
              aria-label="Single-line diagram"
              className="bg-background flex h-full min-h-0 flex-1 flex-col"
            >
              {main ?? defaultMain}
            </main>
          </Panel>

          {viewportTooSmall ? null : (
            <>
              <PanelResizeHandle
                aria-label="Resize main canvas and dock"
                className={cn(
                  'group relative flex w-1 shrink-0 items-center justify-center',
                  'bg-border hover:bg-[var(--color-ring)]',
                  'transition-colors duration-[var(--duration-fast)]',
                  'data-[resize-handle-state=drag]:bg-[var(--color-ring)]',
                  'focus-visible:bg-[var(--color-ring)] focus-visible:outline-none',
                )}
              >
                {/* Vertical grip — small bar centered on the handle. */}
                <span
                  aria-hidden="true"
                  className={cn(
                    'block h-6 w-px rounded-full',
                    'bg-muted-foreground/40 group-hover:bg-background',
                    'transition-colors duration-[var(--duration-fast)]',
                  )}
                />
              </PanelResizeHandle>

              <Panel
                id="right-dock"
                order={2}
                defaultSize={35}
                minSize={15}
                maxSize={60}
                className="flex min-w-0 flex-col"
              >
                <RightDock inspector={inspector} results={results} overlay={dockOverlay} />
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>

      {/* Modal mount slot. Modals (Radix Dialog) handle their own portal
          mounting; this slot exists so callers have an explicit place to
          render them and so the shell DOM has a documented top-level
          overlay region. */}
      {modal}

      {/* Global toast surface (Unit 3 of the v2.0 polish plan). Sonner
          owns the portal — `<Toaster />` mounted once here means a
          toast survives the unmount of its originating component. See
          `web/src/lib/toast.ts` for the typed wrapper + policy. */}
      <Toaster />

      {/* Global command palette (Unit 9 of the v2.0 polish plan).
          Mounted once at the shell root so the ⌘K hotkey can summon
          it from anywhere — even when the user is mid-edit in a panel
          that would otherwise unmount during a state transition. */}
      <CommandPalette />

      {/* Global keyboard-shortcut cheatsheet (Unit 10). Same lifecycle
          rationale as the command palette — mounted once at root so
          the `?` hotkey can summon the modal from any surface. */}
      <ShortcutCheatsheet />

      {/* Per-command shortcut registrar (Unit 10). Renders one
          invisible binder per command-with-shortcut so each binding
          gets its own `useHotkeys` registration. Mounted ONCE at
          the shell root — duplicating it would register every
          binding twice. */}
      <GlobalShortcuts />
    </div>
  );
}
