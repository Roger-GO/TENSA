/**
 * TopBarMenu — generic dropdown wrapper for the TopBar's grouped menus
 * (Unit 8 of the v2.0 polish plan).
 *
 * Provides:
 *
 * - Consistent ghost-button trigger styling with a label + chevron.
 * - Radix-Popover-backed disclosure with `role="menu"` content + items
 *   marked `role="menuitem"` for screen-reader and keyboard support.
 * - Arrow-key roving focus across items + Enter/Space activation +
 *   Escape closes (Radix already gives us outside-click-to-close and
 *   focus return).
 *
 * Implementation note on the primitive: the v2.0 polish plan suggests
 * `@radix-ui/react-dropdown-menu`, but the package isn't currently in
 * dependencies and Unit 8 is constrained to "no new deps". The
 * Popover primitive already in the project (`@radix-ui/react-popover`,
 * already used by `SnapshotMenu` and `ExportMenu`) gives us the same
 * portal/positioning/outside-click semantics; the small bit of arrow-
 * key roving focus that DropdownMenu would have given for free is
 * handled by `useMenuKeyboardNav` below. When DropdownMenu lands in
 * the dependency set (Unit 9 command palette work or later) this
 * wrapper can swap primitives without callers changing their API.
 *
 * Trigger styling matches the existing ghost `Button` (size="sm") so
 * the four menu triggers visually align with the other small actions
 * (HideLabelsToggle, History toggle).
 *
 * Per the AGENTS.md "Form-input contract" section: this component does
 * not render any form inputs, so the controlled-state pattern there
 * doesn't apply. Per the testid kebab-case convention: callers pass a
 * stable kebab-case `testId`; the trigger gets `${testId}-trigger`,
 * the content gets `${testId}-content`.
 */
import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type {
  ButtonHTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode,
} from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/**
 * Inline chevron-down glyph. Avoids adding `lucide-react` (Unit 8 is
 * constrained to no new deps); the existing components use the same
 * inline-SVG approach for the `RunButton` spinner.
 */
function ChevronDown({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 12 12"
      width="10"
      height="10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M3 4.5 6 7.5 9 4.5" />
    </svg>
  );
}

/**
 * Props for an icon component passed via `icon` (e.g., a Lucide-style
 * functional SVG component). The shape is the bare minimum the
 * existing inline glyphs already match — `className` for sizing.
 */
export type MenuIconComponent = (props: { className?: string }) => ReactElement;

export interface TopBarMenuProps {
  /** Trigger label (rendered as text inside the ghost button). */
  label: string;
  /**
   * Optional icon component to render before the label. Anything that
   * accepts `{ className }` works (matches Lucide's signature so a
   * future swap to lucide-react is trivial).
   */
  icon?: MenuIconComponent;
  /**
   * Menu items. Each direct child should be a `<TopBarMenuItem />`
   * (clickable) or a separator/heading. Non-`MenuItem` children render
   * as-is.
   */
  children: ReactNode;
  /**
   * Stable kebab-case slug used to derive testids:
   * `${testId}-trigger`, `${testId}-content`. Required.
   */
  testId: string;
  /**
   * Align the popover content to the end of the trigger (right edge).
   * Defaults to `"start"` (left edge), matching the left-aligned
   * Workspace / Edit / Run menus; the Export menu on the right side
   * passes `alignEnd` so it doesn't escape the viewport.
   */
  alignEnd?: boolean;
  /**
   * Disable the trigger entirely. Useful when no session is loaded
   * and every item in the menu would itself be disabled.
   */
  disabled?: boolean;
  /** Optional class on the trigger button. */
  triggerClassName?: string;
}

/**
 * The menu wrapper. See module docstring.
 */
export function TopBarMenu({
  label,
  icon: Icon,
  children,
  testId,
  alignEnd = false,
  disabled = false,
  triggerClassName,
}: TopBarMenuProps) {
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Focus the first menuitem on open so keyboard users land on a
  // sensible target. Radix Popover focuses the content itself by
  // default; we hand off to the first item via a microtask after
  // mount.
  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => {
      const items = contentRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([data-disabled="true"])',
      );
      items?.[0]?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  // Wire close-on-activation onto every TopBarMenuItem child. The
  // pattern lets call-sites write `<TopBarMenuItem onSelect={...}>`
  // without remembering to call setOpen(false) manually — match
  // dropdown-menu's `onSelect` close-on-default semantics.
  const wrappedChildren = Children.map(children, (child) => {
    if (!isValidElement(child)) return child;
    // Type assertion is safe: we only inject the close callback into
    // children that opt in by being `<TopBarMenuItem />`. Other
    // children (separators, headings) flow through unchanged.
    if ((child.type as { __isTopBarMenuItem?: boolean }).__isTopBarMenuItem) {
      return cloneElement(child as ReactElement<{ __closeMenu?: () => void }>, {
        __closeMenu: () => setOpen(false),
      });
    }
    return child;
  });

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const root = contentRef.current;
    if (!root) return;
    const items = Array.from(
      root.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([data-disabled="true"])',
      ),
    );
    if (items.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const currentIdx = active ? items.indexOf(active) : -1;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = currentIdx < 0 ? 0 : (currentIdx + 1) % items.length;
      items[next]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const next = currentIdx <= 0 ? items.length - 1 : currentIdx - 1;
      items[next]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  }, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-haspopup="menu"
          data-testid={`${testId}-trigger`}
          className={cn(
            'gap-1 px-2 text-xs',
            // Visual weight to the active (open) menu, matching the
            // popover hover state so the trigger and content read as
            // one continuous surface.
            'data-[state=open]:bg-muted data-[state=open]:text-foreground',
            triggerClassName,
          )}
        >
          {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
          <span>{label}</span>
          <ChevronDown className="ml-0.5 opacity-80" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align={alignEnd ? 'end' : 'start'}
        sideOffset={4}
        role="menu"
        aria-label={label}
        onKeyDown={handleKeyDown}
        data-testid={`${testId}-content`}
        className="w-60 p-1"
      >
        {wrappedChildren}
      </PopoverContent>
    </Popover>
  );
}

// ---- Menu item primitive --------------------------------------------------

export interface TopBarMenuItemProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect' | 'children'> {
  /** Item label. Rendered after the optional icon. */
  children: ReactNode;
  /** Optional icon component (Lucide-shape). */
  icon?: MenuIconComponent;
  /**
   * Optional keyboard-shortcut hint shown right-aligned (e.g., "⌘K").
   * Display-only — the actual binding is registered via `useHotkeys`.
   */
  shortcut?: string;
  /** Item is checked (RunMenu marks the active routine). */
  checked?: boolean;
  /** When true, suppresses the close-on-click behaviour. */
  preventCloseOnSelect?: boolean;
  /** Stable testid. */
  testId?: string;
  /**
   * Internal: injected by the parent `<TopBarMenu />` to close the
   * menu when the item is activated. Callers do not pass this.
   */
  __closeMenu?: () => void;
}

const TopBarMenuItemImpl = forwardRef<HTMLButtonElement, TopBarMenuItemProps>(
  function TopBarMenuItem(
    {
      children,
      icon: Icon,
      shortcut,
      checked = false,
      disabled = false,
      preventCloseOnSelect = false,
      onClick,
      testId,
      className,
      __closeMenu,
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        role="menuitem"
        tabIndex={-1}
        disabled={disabled}
        data-disabled={disabled ? 'true' : undefined}
        data-testid={testId}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented && !preventCloseOnSelect) {
            __closeMenu?.();
          }
        }}
        className={cn(
          'flex w-full items-center gap-2 rounded-[var(--radius-sm)]',
          'px-2 py-1.5 text-left text-xs',
          'hover:bg-muted/60 focus:bg-muted/60',
          'outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]',
          'disabled:pointer-events-none disabled:opacity-50',
          className,
        )}
        {...rest}
      >
        <span aria-hidden="true" className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          {checked ? <CheckGlyph /> : Icon ? <Icon className="h-3.5 w-3.5" /> : null}
        </span>
        <span className="flex-1 truncate">{children}</span>
        {shortcut ? (
          <span className="text-muted-foreground ml-2 font-mono text-[10px]">{shortcut}</span>
        ) : null}
      </button>
    );
  },
);

// Marker so `TopBarMenu` can identify items vs. arbitrary children
// (separators, headings, etc.) without an explicit `displayName`
// string-match (which is brittle under minification).
(TopBarMenuItemImpl as unknown as { __isTopBarMenuItem: true }).__isTopBarMenuItem = true;

export const TopBarMenuItem = TopBarMenuItemImpl;

function CheckGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 12 12"
      width="10"
      height="10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 6.5 5 9 9.5 3.5" />
    </svg>
  );
}

/**
 * Visual separator between item groups.
 */
export function TopBarMenuSeparator() {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      className="bg-border/60 mx-1 my-1 h-px"
    />
  );
}

/**
 * Small caption rendered above a group of items.
 */
export function TopBarMenuLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        'text-muted-foreground px-2 pt-1.5 pb-0.5',
        'text-[10px] font-medium tracking-wide uppercase',
      )}
    >
      {children}
    </div>
  );
}
