/**
 * ThemeToggle (Unit 12 of the v2.0 polish plan).
 *
 * Three-state cycle: light → dark → system → light. The icon reflects
 * the user-selected ``themePreference`` (NOT the resolved theme) so
 * the user always sees what they picked — when ``system`` is active
 * the laptop glyph is shown regardless of whether the OS is currently
 * dark or light.
 *
 * Replaces the Unit 8 placeholder button (``DarkModeTogglePlaceholder``
 * inside ``TopBar.tsx``). Keeps the same right-edge slot so the layout
 * doesn't shift across versions.
 *
 * Icons: inline SVG, mirroring the rest of the codebase (``RunButton``'s
 * Spinner, the Unit 8 SunGlyph). The plan called for ``lucide-react``
 * but the package is not in the project's deps and the constraint is
 * "do not add new deps"; the inline glyphs below are shape-compatible
 * with Lucide's Sun / Moon / Laptop icons so a future swap is a
 * one-import change.
 */
import { Button } from '@/components/ui/button';
import { useTheme } from '@/lib/useTheme';
import type { ThemePreference } from '@/store/theme';
import { nextPreference } from '@/store/theme';
import { cn } from '@/lib/cn';

export interface ThemeToggleProps {
  className?: string;
}

const PREF_LABELS: Record<ThemePreference, string> = {
  light: 'light',
  dark: 'dark',
  system: 'system',
};

export function ThemeToggle({ className }: ThemeToggleProps) {
  const { themePreference, cycleTheme } = useTheme();
  const next = nextPreference(themePreference);
  const tooltip = `Theme: ${PREF_LABELS[themePreference]} — click to switch to ${PREF_LABELS[next]} mode`;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={cycleTheme}
      data-testid="theme-toggle"
      data-theme-preference={themePreference}
      aria-label={tooltip}
      title={tooltip}
      className={cn('px-2', className)}
    >
      <ThemeIcon preference={themePreference} />
    </Button>
  );
}

function ThemeIcon({ preference }: { preference: ThemePreference }) {
  switch (preference) {
    case 'light':
      return <SunGlyph data-testid="theme-toggle-icon-light" className="h-4 w-4" />;
    case 'dark':
      return <MoonGlyph data-testid="theme-toggle-icon-dark" className="h-4 w-4" />;
    case 'system':
    default:
      return <LaptopGlyph data-testid="theme-toggle-icon-system" className="h-4 w-4" />;
  }
}

interface GlyphProps {
  className?: string;
  ['data-testid']?: string;
}

function SunGlyph({ className, ...rest }: GlyphProps) {
  return (
    <svg
      {...rest}
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

function MoonGlyph({ className, ...rest }: GlyphProps) {
  return (
    <svg
      {...rest}
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function LaptopGlyph({ className, ...rest }: GlyphProps) {
  return (
    <svg
      {...rest}
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M2 20h20" />
    </svg>
  );
}
