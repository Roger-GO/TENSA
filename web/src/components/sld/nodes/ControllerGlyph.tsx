import type { ControllerSubKind } from '@/lib/controllers';
import { cn } from '@/lib/cn';

/**
 * Inline line glyph for a controller sub-kind. Stroke uses `currentColor`,
 * so the icon inherits the surrounding text colour. Shared by the SLD
 * `ControllerNode` badge (Unit 19) and the inspector's
 * `AttachedControllersSection` drill-down rows (Unit 20) so both surfaces
 * stay visually consistent.
 *
 * Per-class IEC 60617 art is deferred; these are neutral schematic symbols
 * discriminated by sub-kind only.
 */
export function ControllerGlyph({
  subKind,
  className,
}: {
  subKind: ControllerSubKind;
  className?: string;
}) {
  const common = {
    'aria-hidden': true,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: cn('h-3.5 w-3.5', className),
  };
  switch (subKind) {
    case 'exciter':
      // Amplifier triangle with a field winding tap (AVR / field forcing).
      return (
        <svg {...common}>
          <path d="M7 5l10 7-10 7z" />
          <path d="M3 12h4" />
        </svg>
      );
    case 'governor':
      // Valve / throttle: a body with a control stem (turbine governor).
      return (
        <svg {...common}>
          <circle cx="12" cy="14" r="5" />
          <path d="M12 9V4" />
          <path d="M9 4h6" />
        </svg>
      );
    case 'pss':
      // Damping sine — the stabiliser's modulating signal.
      return (
        <svg {...common}>
          <path d="M3 12c3-7 6 7 9 0s6-7 9 0" />
        </svg>
      );
    case 'renewable':
      // Wind/PV controller — a three-blade rotor hub.
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="1.6" />
          <path d="M12 10.4V4" />
          <path d="M13.4 12.8l5.6 3.2" />
          <path d="M10.6 12.8L5 16" />
        </svg>
      );
    case 'measurement':
      // Gauge — PMU / frequency measurement.
      return (
        <svg {...common}>
          <path d="M4 16a8 8 0 0116 0" />
          <path d="M12 16l4-4" />
        </svg>
      );
    case 'profile':
      // Time-series profile — a stepped trace.
      return (
        <svg {...common}>
          <path d="M3 17V7" />
          <path d="M3 17h18" />
          <path d="M6 14l4-4 3 3 4-6" />
        </svg>
      );
    case 'other':
      // Generic control block.
      return (
        <svg {...common}>
          <rect x="6" y="7" width="12" height="10" rx="1.5" />
          <path d="M3 12h3" />
          <path d="M18 12h3" />
        </svg>
      );
  }
}
