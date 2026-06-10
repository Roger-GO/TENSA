import { useMemo } from 'react';
import { useCaseStore } from '@/store/case';
import {
  controllerSubKindLabel,
  summarizeControllers,
  type ControllerSubKind,
} from '@/lib/controllers';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';

/**
 * DynamicContentBadge (v3.1 Unit 24, R18).
 *
 * Tells the user at a glance whether the loaded case carries dynamic-model
 * data — the precondition for the dynamic routines (TDS / EIG). Three states:
 *
 *   - `loading`     — a case is selected but its topology hasn't resolved yet.
 *   - `dynamic`     — the case has ≥1 controller; tooltip lists the categories.
 *   - `static-only` — no controllers; tooltip nudges toward a `.dyr` addfile.
 *
 * Derived entirely client-side from `topology.controllers` (no dedicated
 * substrate field). `compact` trades the text label for an icon-only chip in
 * the TopBar status cluster; the tooltip carries the full picture either way.
 *
 * Renders nothing when no case is loaded (there is nothing to characterise).
 */

type BadgeState = 'loading' | 'dynamic' | 'static-only';

const SUBKIND_ORDER: readonly ControllerSubKind[] = [
  'exciter',
  'governor',
  'pss',
  'renewable',
  'measurement',
  'profile',
  'other',
];

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-3 w-3', className)}
    >
      <path d="M5 12l5 5 9-11" />
    </svg>
  );
}

export interface DynamicContentBadgeProps {
  compact?: boolean;
  className?: string;
}

export function DynamicContentBadge({ compact = false, className }: DynamicContentBadgeProps) {
  const selection = useCaseStore((s) => s.selection);
  // Store mirror of the topology query (synced by `setTopology`) — keeps the
  // badge a pure store reader so it adds no query side effects to the TopBar /
  // CaseNav mounts.
  const topology = useCaseStore((s) => s.topology);

  const summary = useMemo(
    () => summarizeControllers(topology?.controllers ?? []),
    [topology?.controllers],
  );

  // A synchronous-machine generator (GENROU/GENCLS) carries rotor DAE states,
  // so a system with one IS dynamic even with zero controllers (matches the
  // TDS/EIG readiness gate). Without this, a from-scratch GENCLS system read
  // as "static-only".
  const dynamicGenCount = useMemo(
    () =>
      (topology?.generators ?? []).filter((g) => g.kind === 'GENROU' || g.kind === 'GENCLS').length,
    [topology?.generators],
  );

  if (selection === null) return null;

  const isDynamic = summary.total > 0 || dynamicGenCount > 0;
  const state: BadgeState = topology === null ? 'loading' : isDynamic ? 'dynamic' : 'static-only';

  const label = state === 'loading' ? 'Loading…' : state === 'dynamic' ? 'Dynamic' : 'Static-only';

  const present = [
    ...(dynamicGenCount > 0
      ? [`${dynamicGenCount} synchronous machine${dynamicGenCount > 1 ? 's' : ''}`]
      : []),
    ...SUBKIND_ORDER.filter((k) => summary.bySubKind[k] > 0).map(
      (k) => `${summary.bySubKind[k]} ${controllerSubKindLabel(k).toLowerCase()}`,
    ),
  ];
  const tooltip =
    state === 'loading'
      ? 'Reading the case…'
      : state === 'dynamic'
        ? `Dynamic models: ${present.join(', ')}. TDS / EIG available.`
        : 'No dynamic models — load a .dyr addfile via the case picker to enable TDS / EIG.';

  const tone =
    state === 'dynamic'
      ? 'border-success/40 bg-success/10 text-success'
      : state === 'loading'
        ? 'border-border bg-muted/40 text-muted-foreground animate-pulse'
        : 'border-border bg-muted/40 text-muted-foreground';

  const dot =
    state === 'dynamic' ? null : (
      <span
        aria-hidden
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          state === 'loading' ? 'bg-muted-foreground/60' : 'bg-muted-foreground',
        )}
      />
    );

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid="dynamic-content-badge"
            data-state={state}
            aria-label={`${label}. ${tooltip}`}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border font-mono text-xs',
              compact ? 'px-1.5 py-0.5' : 'px-2 py-0.5',
              tone,
              className,
            )}
          >
            {state === 'dynamic' ? <CheckIcon /> : dot}
            {compact ? null : <span>{label}</span>}
          </span>
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent>{tooltip}</TooltipContent>
        </TooltipPortal>
      </Tooltip>
    </TooltipProvider>
  );
}
