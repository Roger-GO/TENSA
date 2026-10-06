import { useMemo } from 'react';
import { useCaseStore } from '@/store/case';
import { useSldStore } from '@/store/sld';
import { useCurrentTopology } from '@/api/queries';
import {
  generatingUnits,
  selectedUnitMember,
  unitChipLabel,
  unitMemberSelection,
  unitOfSelection,
  unitRoleLabel,
  type UnitMember,
} from '@/lib/generatingUnits';
import { iconForModel } from '@/icons/iec60617/manifest';
import { ControllerGlyph } from '@/components/sld/nodes/ControllerGlyph';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/cn';

/**
 * GeneratingUnitSection.
 *
 * Rendered under the Properties of a selected generator, machine or
 * controller. Lists the generating unit the selection belongs to
 * (`generatingUnits`): the static generator, the machine that names it, the
 * exciter and the governor of that machine, the stabiliser of the exciter,
 * and a converter with its controls. Each model stands under the one it
 * refers to, as in the chain the diagram draws out for the unit, and the one
 * the Inspector is showing is marked. A row switches the Inspector to that
 * model; the diagram keeps the unit's symbol picked out and marks the
 * model's chip on it.
 *
 * This is how every model of a unit is reached without the pointer: the
 * diagram draws the unit as one symbol, and the chips on it are not tab
 * stops.
 *
 * A generator that is the only model of its unit gets a line that says so.
 * A controller that belongs to no unit (a PMU on a bus, one whose reference
 * names nothing) gets no section.
 */
export function GeneratingUnitSection({ className }: { className?: string }) {
  const selected = useCaseStore((s) => s.selectedElement);
  const setSelectedElement = useCaseStore((s) => s.setSelectedElement);
  const setSelectedNodeId = useSldStore((s) => s.setSelectedNodeId);
  const topology = useCurrentTopology();

  const units = useMemo(() => (topology ? generatingUnits(topology).units : []), [topology]);
  const unit = useMemo(() => unitOfSelection(units, selected), [units, selected]);

  if (selected === null || (selected.kind !== 'generator' && selected.kind !== 'controller')) {
    return null;
  }
  if (unit === null && selected.kind === 'controller') return null;

  const members = unit?.members ?? [];
  const shown = selectedUnitMember(members, selected);

  return (
    <section
      data-testid="generating-unit-section"
      className={cn('flex flex-col gap-1.5', className)}
      aria-label="Generating unit"
    >
      <h4 className="text-muted-foreground text-[10px] font-semibold tracking-[0.12em] uppercase">
        Generating unit
      </h4>
      {members.length < 2 ? (
        <EmptyState
          title="No dynamic models attached"
          description="Pair this case with a .dyr file to add a machine, an exciter and a governor."
          emptyStateKey="generating-unit-empty"
          className="py-4"
        />
      ) : (
        <ul className="flex flex-col gap-1" data-testid="generating-unit-list">
          {members.map((member) => (
            <li key={`${member.kind}-${member.idx}`} className={DEPTH_MARGIN[depthOf(member)]}>
              <UnitRow
                member={member}
                shown={member === shown}
                onPick={() => {
                  setSelectedElement(unitMemberSelection(member));
                  // The id the model goes by; the diagram shows the unit it is of.
                  setSelectedNodeId(member.nodeId);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** How far a row is set in, by how deep its model is in the chain. */
const DEPTH_MARGIN = ['', 'ml-3', 'ml-6', 'ml-9'] as const;

function depthOf(member: UnitMember): 0 | 1 | 2 | 3 {
  return Math.min(member.depth, DEPTH_MARGIN.length - 1) as 0 | 1 | 2 | 3;
}

function UnitRow({
  member,
  shown,
  onPick,
}: {
  member: UnitMember;
  shown: boolean;
  onPick: () => void;
}) {
  const isController = member.role !== 'generator' && member.role !== 'machine';
  return (
    <button
      type="button"
      data-testid={`generating-unit-row-${member.kind}-${member.idx}`}
      data-role={member.role}
      // Announce the role the glyph conveys visually, e.g.
      // "Exciter: EXST1 EXST1_1" (the glyph itself is aria-hidden).
      aria-label={`${unitRoleLabel(member.role)}: ${member.kind} ${member.idx}`}
      aria-current={shown ? 'true' : undefined}
      disabled={shown}
      onClick={onPick}
      className={cn(
        'group flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5',
        'border',
        shown
          ? 'bg-primary/10 border-[var(--color-ring)]'
          : 'border-border bg-background hover:bg-muted/60',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        'transition-colors',
      )}
    >
      <span className="text-muted-foreground flex items-center" aria-hidden="true">
        {member.role === 'generator' || member.role === 'machine' ? (
          <img
            src={iconForModel(member.kind)}
            alt=""
            className="h-3.5 w-3.5 object-contain"
            draggable={false}
          />
        ) : (
          <ControllerGlyph subKind={member.role} />
        )}
      </span>
      <span className="text-foreground min-w-0 flex-1 truncate text-left font-mono text-xs">
        <span className="font-semibold">{member.kind}</span>
        <span className="text-muted-foreground"> {member.idx}</span>
      </span>
      {/* The letters the model's chip has on the unit's symbol. */}
      {isController || member.role === 'machine' ? (
        <span className="text-muted-foreground font-mono text-[10px]" aria-hidden="true">
          {unitChipLabel(member)}
        </span>
      ) : null}
      {shown ? null : <ChevronRight />}
    </button>
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
