import { useEffect, useMemo, useState } from 'react';
import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { CursorIcon, EmptyState } from '@/components/ui/EmptyState';
import { useCaseStore } from '@/store/case';
import type { SelectedElement } from '@/store/case';
import { useCurrentTopology } from '@/api/queries';
import { cn } from '@/lib/cn';
import { PropertiesAccordion } from './PropertiesAccordion';
import { PlotsAccordion } from './PlotsAccordion';
import { DisturbancesAccordion } from './DisturbancesAccordion';

/**
 * RightInspector (v3 Unit 7).
 *
 * The per-element accordion that mounts inside the AppShell's
 * ``rightInspector`` slot. Three sections — Properties, Plots,
 * Disturbances — driven by the selection from ``case.selectedElement``.
 *
 * Open-state persistence: per-element-kind (so a generator selection
 * remembers the user's preferred section split independent of a bus
 * selection's). Stored in localStorage under
 * ``andes-app:layout-v1:rightInspector:openSections:<kind>`` as a JSON
 * ``string[]`` of section ids.
 *
 * Empty branch: when no element is selected, renders an EmptyState
 * (this mirrors the AppShell's existing placeholder when no inspector
 * content is supplied; the difference is the AppShell already gates
 * mount on selection-or-toggle visibility, so this empty branch should
 * only paint when the user has manually opened the inspector with no
 * selection).
 *
 * Header: small element-kind glyph + ``<Kind> <name>`` (or just
 * ``<Kind> <idx>`` when the topology hasn't resolved a name).
 */

const STORAGE_PREFIX = 'andes-app:layout-v1:rightInspector:openSections';

const SECTION_IDS = ['properties', 'plots', 'disturbances'] as const;
type SectionId = (typeof SECTION_IDS)[number];

const DEFAULT_OPEN: readonly SectionId[] = ['properties'];

function storageKey(kind: SelectedElement['kind']): string {
  return `${STORAGE_PREFIX}:${kind}`;
}

function readPersistedOpen(kind: SelectedElement['kind']): SectionId[] {
  if (typeof window === 'undefined') return [...DEFAULT_OPEN];
  try {
    const raw = window.localStorage.getItem(storageKey(kind));
    if (!raw) return [...DEFAULT_OPEN];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_OPEN];
    const filtered = parsed.filter(
      (v): v is SectionId =>
        typeof v === 'string' && (SECTION_IDS as readonly string[]).includes(v),
    );
    return filtered;
  } catch {
    return [...DEFAULT_OPEN];
  }
}

function writePersistedOpen(kind: SelectedElement['kind'], open: SectionId[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(kind), JSON.stringify(open));
  } catch {
    // localStorage can throw under quota / private-mode; the panel still
    // works without persistence so swallow + continue.
  }
}

/**
 * Minimal inline glyphs per element kind. Stroke uses ``currentColor``
 * so the icon inherits the header text colour.
 */
function KindGlyph({ kind, className }: { kind: SelectedElement['kind']; className?: string }) {
  const common = {
    'aria-hidden': true,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: cn('h-4 w-4', className),
  };
  switch (kind) {
    case 'bus':
      return (
        <svg {...common}>
          <rect x="3" y="10" width="18" height="4" rx="1" />
        </svg>
      );
    case 'generator':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v8" />
          <path d="M9 11l3-3 3 3" />
        </svg>
      );
    case 'load':
      return (
        <svg {...common}>
          <path d="M12 4l8 8-8 8-8-8z" />
        </svg>
      );
    case 'shunt':
      return (
        <svg {...common}>
          <path d="M12 3v8" />
          <path d="M8 11h8" />
          <path d="M9 14h6" />
          <path d="M10 17h4" />
        </svg>
      );
    case 'line':
      return (
        <svg {...common}>
          <path d="M4 12h16" />
          <circle cx="6" cy="12" r="1.4" />
          <circle cx="18" cy="12" r="1.4" />
        </svg>
      );
    case 'transformer':
      return (
        <svg {...common}>
          <circle cx="9" cy="12" r="4" />
          <circle cx="15" cy="12" r="4" />
        </svg>
      );
    default:
      return <svg {...common} />;
  }
}

function ChevronGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(
        'h-3.5 w-3.5 transition-transform duration-150',
        'group-data-[state=open]:rotate-180',
        className,
      )}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** Capitalize the first letter for header display. */
function titleCase(kind: SelectedElement['kind']): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

interface SectionProps {
  id: SectionId;
  label: string;
  children: React.ReactNode;
}

function Section({ id, label, children }: SectionProps) {
  return (
    <AccordionPrimitive.Item
      value={id}
      data-testid={`right-inspector-section-${id}`}
      className="border-border border-b last:border-b-0"
    >
      <AccordionPrimitive.Header className="flex">
        <AccordionPrimitive.Trigger
          data-testid={`right-inspector-section-trigger-${id}`}
          className={cn(
            'group flex flex-1 items-center justify-between gap-2 px-3 py-2',
            // Subtle section-header band: bg-muted recess on the strip
            // when collapsed, lifts to bg-background when open so the
            // body content visually attaches. Radix sets data-state on
            // the trigger itself.
            'bg-muted/40 data-[state=open]:bg-background',
            'text-muted-foreground data-[state=open]:text-foreground',
            'text-[10px] font-semibold tracking-[0.12em] uppercase',
            'hover:text-foreground transition-colors',
            'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          )}
        >
          <span>{label}</span>
          <ChevronGlyph />
        </AccordionPrimitive.Trigger>
      </AccordionPrimitive.Header>
      <AccordionPrimitive.Content
        data-testid={`right-inspector-section-content-${id}`}
        className="px-3 pb-3"
      >
        {children}
      </AccordionPrimitive.Content>
    </AccordionPrimitive.Item>
  );
}

export interface RightInspectorProps {
  className?: string;
}

export function RightInspector({ className }: RightInspectorProps) {
  const selectedElement = useCaseStore((s) => s.selectedElement);
  const topology = useCurrentTopology();

  // Per-element-kind open-state. Hydrate from localStorage on kind change
  // so switching from bus → generator picks up that kind's persisted set.
  const kind = selectedElement?.kind ?? null;
  const [openByKind, setOpenByKind] = useState<Record<string, SectionId[]>>(() => ({}));

  useEffect(() => {
    if (!kind) return;
    if (openByKind[kind] !== undefined) return;
    const persisted = readPersistedOpen(kind);
    setOpenByKind((curr) => ({ ...curr, [kind]: persisted }));
  }, [kind, openByKind]);

  const open = kind ? (openByKind[kind] ?? readPersistedOpen(kind)) : [...DEFAULT_OPEN];

  const handleValueChange = (next: string[]) => {
    if (!kind) return;
    const filtered = next.filter((v): v is SectionId =>
      (SECTION_IDS as readonly string[]).includes(v),
    );
    setOpenByKind((curr) => ({ ...curr, [kind]: filtered }));
    writePersistedOpen(kind, filtered);
  };

  const headerName = useMemo(() => {
    if (!selectedElement || !topology) return null;
    const buckets: Record<
      SelectedElement['kind'],
      readonly { idx: string | number; name: string }[]
    > = {
      bus: topology.buses,
      line: topology.lines,
      transformer: topology.transformers,
      generator: topology.generators,
      load: topology.loads,
      shunt: topology.shunts ?? [],
    };
    const bucket = buckets[selectedElement.kind] ?? [];
    const entry = bucket.find((e) => String(e.idx) === selectedElement.idx);
    return entry?.name ?? null;
  }, [selectedElement, topology]);

  if (!selectedElement) {
    return (
      <div data-testid="right-inspector" className={cn('flex h-full min-h-0 flex-col', className)}>
        <EmptyState
          icon={<CursorIcon />}
          title="Nothing selected"
          description="Select an element on the canvas or a row in the data grid to inspect its properties."
          emptyStateKey="right-inspector-no-selection"
        />
      </div>
    );
  }

  return (
    <div data-testid="right-inspector" className={cn('flex h-full min-h-0 flex-col', className)}>
      <header
        data-testid="right-inspector-header"
        className={cn('border-border bg-background flex items-center gap-2 border-b px-3 py-2.5')}
      >
        <KindGlyph kind={selectedElement.kind} className="text-primary" />
        {/* Kind chip + element name. The chip carries the element kind
            in a tracking-wider uppercase eyebrow; the name dominates so
            the user reads "BUS5" first, kind second. */}
        <span
          data-testid="right-inspector-header-kind"
          className={cn(
            'rounded-[var(--radius-sm)] border px-1.5 py-px',
            'border-primary/30 bg-primary/10 text-primary',
            'text-[9px] font-semibold tracking-[0.1em] uppercase',
          )}
        >
          {titleCase(selectedElement.kind)}
        </span>
        <p className="text-foreground truncate font-mono text-sm font-semibold">
          {headerName ?? selectedElement.idx}
        </p>
      </header>
      <AccordionPrimitive.Root
        type="multiple"
        value={open}
        onValueChange={handleValueChange}
        data-testid="right-inspector-accordion"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        <Section id="properties" label="Properties">
          <PropertiesAccordion />
        </Section>
        <Section id="plots" label="Plots">
          <PlotsAccordion />
        </Section>
        <Section id="disturbances" label="Disturbances">
          <DisturbancesAccordion />
        </Section>
      </AccordionPrimitive.Root>
    </div>
  );
}
