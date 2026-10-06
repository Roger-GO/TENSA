import { cn } from '@/lib/cn';
import {
  unitChipLabel,
  unitMemberSelection,
  unitRoleLabel,
  type UnitMemberInfo,
} from '@/lib/generatingUnits';
import { useCaseStore } from '@/store/case';
import { __requestUnitExpanded, useSldStore } from '@/store/sld';
import { unitChips, unitMoreLabel, type ChainSide } from '../graph';

/**
 * What the symbol of a generating unit shows of the unit besides its machine
 * symbol and its name (`GeneratorNode` puts them together):
 *
 * - `UnitChips`: one chip per model after the unit's own, in a column either
 *   side of the machine symbol. A chip names what the model is to the unit
 *   (`SG`, `AVR`, `GOV`, `PSS`; `unitChipLabel`), and a press on it shows
 *   that model in the Inspector.
 * - `UnitToggle`: the control at the end of the name that draws the control
 *   chain out and folds it away again.
 * - `UnitChain`: the chain drawn out, a row per model with each under the
 *   one it refers to. It hangs off a side of the symbol (the one away from
 *   the bus, or the right or the left where something stands there) and
 *   adds nothing to the node's box, so the port the connector leaves by,
 *   the readout and the place the unit was put stay what they were.
 *
 * Everything here that is pressed carries React Flow's `nodrag`, so a press
 * is a click however the pointer slips, and `nokey`, so the keys that move
 * a node are not taken from it. The unit is dragged by its machine symbol
 * and its name. A press does not reach the node under it, which would show
 * the unit's own model in the Inspector instead.
 */

/** Show `member` in the Inspector and mark it on the diagram. */
function inspectMember(member: UnitMemberInfo): void {
  useCaseStore.getState().setSelectedElement(unitMemberSelection(member));
  useSldStore.getState().setSelectedNodeId(member.nodeId, 'diagram');
}

/** `Governor: TGOV1 TGOV1_3`, the words a chip or a row stands for. */
function memberTitle(member: UnitMemberInfo): string {
  return `${unitRoleLabel(member.role)}: ${member.kind} ${member.idx}`;
}

const CHIP_CLASS = cn(
  'nodrag nopan nokey block w-full cursor-pointer rounded-[3px] border px-0.5 text-center',
  'font-mono text-[8px] leading-[9px] whitespace-nowrap',
  'transition-colors duration-[var(--duration-fast)]',
  'focus-visible:ring-1 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
);

interface ChipProps {
  member: UnitMemberInfo;
  selected: boolean;
  pending: boolean;
}

function UnitChip({ member, selected, pending }: ChipProps) {
  const title = memberTitle(member);
  return (
    <button
      type="button"
      // The chips are reached by the pointer; the keyboard reaches the same
      // models through the list the Inspector shows for the unit.
      tabIndex={-1}
      data-testid={`unit-chip-${member.kind}-${member.idx}`}
      data-role={member.role}
      data-selected={selected ? 'true' : undefined}
      data-pending-dependent={pending ? 'true' : undefined}
      aria-label={title}
      aria-pressed={selected}
      title={`${title}. Click to inspect.`}
      onClick={(event) => {
        event.stopPropagation();
        inspectMember(member);
      }}
      className={cn(
        CHIP_CLASS,
        selected
          ? 'bg-primary/10 text-foreground border-[var(--color-ring)]'
          : 'border-border bg-muted/60 text-muted-foreground hover:border-foreground/40 hover:text-foreground',
        pending ? 'ring-warning/60 ring-1' : '',
      )}
    >
      {unitChipLabel(member)}
    </button>
  );
}

export interface UnitChipsProps {
  unitIdx: string;
  /** The models of the unit; the first is the symbol's own and gets no chip. */
  members: readonly UnitMemberInfo[];
  /** The model that is selected, when it is one of the unit's. */
  selected: UnitMemberInfo | null;
  /** Whether a model is flagged as standing in the way of a delete. */
  isPending: (member: UnitMemberInfo) => boolean;
  side: 'left' | 'right';
}

/**
 * The chips of one side of the machine symbol. The first half of the models
 * stand on the left and the rest on the right, two to a side; where the unit
 * has more models than places, the last place says how many it leaves out,
 * and a press on it draws the whole chain out.
 */
export function UnitChips({ unitIdx, members, selected, isPending, side }: UnitChipsProps) {
  const { chips, more } = unitChips(members);
  const places = chips.length + (more > 0 ? 1 : 0);
  const onLeft = Math.ceil(places / 2);
  const mine = side === 'left' ? chips.slice(0, onLeft) : chips.slice(onLeft);
  return (
    <span className="flex flex-col gap-[2px]" data-testid={`unit-chips-${side}-${unitIdx}`}>
      {mine.map((member) => (
        <UnitChip
          key={`${member.kind}-${member.idx}`}
          member={member}
          selected={selected === member}
          pending={isPending(member)}
        />
      ))}
      {side === 'right' && more > 0 ? (
        <button
          type="button"
          tabIndex={-1}
          data-testid={`unit-more-${unitIdx}`}
          aria-label={`${more} more models. Show the control chain.`}
          title={`${more} more models. Click to show the control chain.`}
          onClick={(event) => {
            event.stopPropagation();
            __requestUnitExpanded(unitIdx, true);
          }}
          className={cn(
            CHIP_CLASS,
            'border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground border-dashed',
          )}
        >
          {unitMoreLabel(more)}
        </button>
      ) : null}
    </span>
  );
}

export interface UnitToggleProps {
  unitIdx: string;
  /** The name the symbol shows, for the control's accessible name. */
  name: string;
  expanded: boolean;
}

/**
 * The control that draws the chain of a unit out and folds it away: a plus
 * while the chain is folded, a minus once it is drawn out, as on the branch
 * of a tree. It sits at the end of the name, inside the node's box.
 */
export function UnitToggle({ unitIdx, name, expanded }: UnitToggleProps) {
  const label = expanded
    ? `Hide the control chain of generator ${name}`
    : `Show the control chain of generator ${name}`;
  return (
    <button
      type="button"
      data-testid={`unit-toggle-${unitIdx}`}
      aria-label={label}
      aria-expanded={expanded}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        __requestUnitExpanded(unitIdx, !expanded);
      }}
      className={cn(
        'nodrag nopan nokey absolute right-[3px] bottom-[2px] h-[9px] w-[9px] cursor-pointer',
        // A target the pointer can hit: four pixels more on every side.
        'before:absolute before:-inset-1 before:content-[""]',
        'border-border bg-background rounded-[2px] border',
        'text-muted-foreground hover:border-foreground/40 hover:text-foreground',
        'focus-visible:ring-1 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
      )}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 7 7"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinecap="round"
        className="block h-[7px] w-[7px]"
      >
        <path d={expanded ? 'M1.5 3.5h4' : 'M1.5 3.5h4M3.5 1.5v4'} />
      </svg>
    </button>
  );
}

/** The left padding of a row of the chain, by how deep its model is in it. */
const DEPTH_PADDING = ['pl-1', 'pl-1', 'pl-3', 'pl-5', 'pl-7'] as const;

export interface UnitChainProps {
  unitIdx: string;
  name: string;
  members: readonly UnitMemberInfo[];
  selected: UnitMemberInfo | null;
  isPending: (member: UnitMemberInfo) => boolean;
  side: ChainSide;
  /** The P / Q readout hangs off the same side: the chain stands clear of it. */
  beyondReadout: boolean;
}

/**
 * Where the chain hangs, by its side: against the middle of that side of the
 * symbol, a gap from it (`UNIT_CHAIN_GAP`), and beyond the readout where
 * that hangs off the same side.
 */
function chainPlacement(side: ChainSide, beyondReadout: boolean): string {
  switch (side) {
    case 'above':
      return cn('left-1/2 -translate-x-1/2 bottom-full', beyondReadout ? 'mb-7' : 'mb-1');
    case 'below':
      return cn('left-1/2 -translate-x-1/2 top-full', beyondReadout ? 'mt-7' : 'mt-1');
    case 'left':
      return 'top-1/2 -translate-y-1/2 right-full mr-1';
    case 'right':
      return 'top-1/2 -translate-y-1/2 left-full ml-1';
  }
}

/**
 * The control chain of a unit, drawn out: one row per model, the generator
 * first and each model under the one it refers to (the machine under the
 * generator, the exciter and the governor under the machine, the stabiliser
 * under the exciter). A row gives the model's class and idx and, at its end,
 * the letters its chip has. A press on a row shows that model in the
 * Inspector.
 */
export function UnitChain({
  unitIdx,
  name,
  members,
  selected,
  isPending,
  side,
  beyondReadout,
}: UnitChainProps) {
  return (
    <div
      role="group"
      aria-label={`Control chain of generator ${name}`}
      data-testid={`unit-chain-${unitIdx}`}
      data-side={side}
      // A press between two rows is not a press on the unit.
      onClick={(event) => event.stopPropagation()}
      className={cn(
        'nodrag nopan nokey absolute z-10 cursor-default',
        chainPlacement(side, beyondReadout),
        'bg-background border-border rounded-[var(--radius-md)] border shadow-sm',
        'flex flex-col p-0.5',
      )}
    >
      {members.map((member, i) => {
        const isSelected = selected === member;
        return (
          <button
            key={`${member.kind}-${member.idx}`}
            type="button"
            data-testid={`unit-chain-row-${member.kind}-${member.idx}`}
            data-role={member.role}
            data-depth={member.depth}
            data-selected={isSelected ? 'true' : undefined}
            aria-label={memberTitle(member)}
            aria-pressed={isSelected}
            title={`${memberTitle(member)}. Click to inspect.`}
            onClick={(event) => {
              event.stopPropagation();
              inspectMember(member);
            }}
            className={cn(
              'nokey flex cursor-pointer items-center gap-1 rounded-[3px] py-px pr-1 text-left',
              DEPTH_PADDING[Math.min(member.depth, DEPTH_PADDING.length - 1)],
              'font-mono text-[9px] leading-[11px] whitespace-nowrap',
              'focus-visible:ring-1 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
              isSelected ? 'bg-primary/10' : 'hover:bg-muted',
              isPending(member) ? 'ring-warning/60 ring-1' : '',
            )}
          >
            {member.depth > 0 ? (
              <span className="text-muted-foreground" aria-hidden="true">
                └
              </span>
            ) : null}
            <span className="text-foreground font-semibold">{member.kind}</span>
            <span className="text-muted-foreground">{member.idx}</span>
            {i > 0 ? (
              <span className="text-muted-foreground ml-auto pl-2 text-[8px]" aria-hidden="true">
                {unitChipLabel(member)}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
