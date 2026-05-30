import { useMemo } from 'react';
import { useCaseStore } from '@/store/case';
import { useSldStore } from '@/store/sld';
import { useCurrentTopology } from '@/api/queries';
import { subKindForControllerClass } from '@/lib/controllers';
import { ControllerGlyph } from '@/components/sld/nodes/ControllerGlyph';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/cn';

/**
 * AttachedControllersSection (v3.1 Unit 20).
 *
 * Rendered under a selected generator's Properties accordion. Lists the
 * dynamic controllers bound to that machine by their `syn` reference
 * (exciters, governors, …) so the user can drill from a generator straight
 * to its exciter/governor without opening a picker. Each row switches the
 * inspector selection to that controller (and the SLD highlight follows).
 *
 * Empty state nudges toward pairing a `.dyr` file when the machine has no
 * dynamic stack yet.
 *
 * Scoping note: the substrate wires governors/exciters to the SynGen via
 * `syn`; PSS attach to the exciter (`avr`) and renewable controllers to the
 * RenGen (`reg`/`ree`), so they surface one drill-down hop deeper, under
 * their own parent. This section intentionally shows only the direct `syn`
 * children of the selected machine.
 */
export function AttachedControllersSection({ className }: { className?: string }) {
  const selected = useCaseStore((s) => s.selectedElement);
  const setSelectedElement = useCaseStore((s) => s.setSelectedElement);
  const setSelectedNodeId = useSldStore((s) => s.setSelectedNodeId);
  const topology = useCurrentTopology();

  const generatorIdx = selected?.kind === 'generator' ? selected.idx : null;

  const attached = useMemo(() => {
    if (generatorIdx === null) return [];
    return (topology?.controllers ?? []).filter(
      (c) => String(c.params?.syn ?? '') === generatorIdx,
    );
  }, [topology, generatorIdx]);

  // Defensive: PropertiesAccordion already gates mount on the generator
  // kind, but keep the component total so a stray mount renders nothing.
  if (generatorIdx === null) return null;

  return (
    <section
      data-testid="attached-controllers-section"
      className={cn('flex flex-col gap-1.5', className)}
      aria-label="Attached controllers"
    >
      <h4 className="text-muted-foreground text-[10px] font-semibold tracking-[0.12em] uppercase">
        Attached controllers
      </h4>
      {attached.length === 0 ? (
        <EmptyState
          title="No dynamic controllers attached"
          description="Pair this case with a .dyr file to add exciters / governors."
          emptyStateKey="attached-controllers-empty"
          className="py-4"
        />
      ) : (
        <ul className="flex flex-col gap-1" data-testid="attached-controllers-list">
          {attached.map((c) => {
            const idx = String(c.idx);
            const subKind = subKindForControllerClass(c.kind);
            return (
              <li key={`${c.kind}-${idx}`}>
                <button
                  type="button"
                  data-testid={`attached-controller-row-${idx}`}
                  onClick={() => {
                    setSelectedElement({ kind: 'controller', subKind, idx });
                    setSelectedNodeId(`controller-${idx}`);
                  }}
                  className={cn(
                    'group flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5',
                    'border-border border',
                    'bg-background hover:bg-muted/60',
                    'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                    'transition-colors',
                  )}
                >
                  <span className="text-muted-foreground flex items-center" aria-hidden="true">
                    <ControllerGlyph subKind={subKind} />
                  </span>
                  <span className="text-foreground min-w-0 flex-1 truncate text-left font-mono text-xs">
                    <span className="font-semibold">{c.kind}</span>
                    <span className="text-muted-foreground"> {idx}</span>
                  </span>
                  <ChevronRight />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ChevronRight() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-muted-foreground group-hover:text-foreground h-3.5 w-3.5 transition-colors"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
