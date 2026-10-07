import { memo, useCallback } from 'react';
import type { NodeProps } from '@xyflow/react';
import { iconForModel } from '@/icons/iec60617/manifest';
import { cn } from '@/lib/cn';
import { selectedUnitMember, type UnitMemberInfo } from '@/lib/generatingUnits';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useSldStore } from '@/store/sld';
import { getGeneratorLimitState } from '../overlay';
import { qLimitMarker, qLimitMarkerLabel } from '../qLimit';
import { VoltageMarker } from '../VoltageMarker';
import type { SldNodeData } from './BusNode';
import { DevicePorts } from './DevicePorts';
import { DeviceValueLabel } from './DeviceValueLabel';
import { UnitChain, UnitChips, UnitToggle } from './GeneratingUnit';

const NO_MEMBERS: readonly UnitMemberInfo[] = [];

/**
 * Generator node: the symbol of one generating unit, which is a static
 * generator with the machine that takes its place in a time-domain run and
 * their controllers (`generatingUnits`). Renders the IEC 60617 generator
 * glyph (a circle with a tilde or "G"); the static-vs-synchronous distinction
 * is encoded in the icon manifest (`PV`/`Slack` → `generator.svg`;
 * `GENROU`/`GENCLS` → `generator-syngen.svg`), and a unit that has a machine
 * shows the machine's.
 *
 * Connected to its bus by a stub edge that leaves from the port on the
 * face that points at the bus (`DevicePorts`) and lands on a tap of the
 * bar. Click to inspect. After a converged PF it
 * carries its P / Q readout (`DeviceValueLabel`), and a generator whose
 * reactive output is on or past a limit gets an amber or red outline and a
 * triangle on its corner (up at `qmax`, down at `qmin`; empty on the limit,
 * filled past it) so the state does not rest on colour alone. The triangle
 * hangs off the corner and the outline is doubled inside the border, so
 * neither adds to the node's box: a power flow leaves the connector, and
 * the lines that were routed around the symbol, where they were.
 *
 * A unit of more than one model (`data.unit`) names the others in chips on
 * either side of the glyph, has a control at the end of its name that draws
 * the control chain out, and shows the chain while it is drawn out
 * (`GeneratingUnit.tsx`). The two columns of chips are equally wide, so the
 * glyph stays in the middle of the box, over the port its connector leaves
 * by, and the box is no higher than that of any other device.
 */
export const GeneratorNode = memo(function GeneratorNode({ data, selected }: NodeProps) {
  const d = data as SldNodeData;
  const members = d.unit?.members ?? NO_MEMBERS;
  const pendingDependents = useCaseStore((s) => s.pendingDependents);
  const isPending = useCallback(
    (member: { kind: string; idx: string }) =>
      pendingDependents.some((dep) => dep.kind === member.kind && String(dep.idx) === member.idx),
    [pendingDependents],
  );
  const isPendingDependent = isPending(d) || members.some(isPending);
  // The model of the unit that is selected: the one the diagram's selection
  // names when it names one of them alone, else the one the Inspector shows.
  const selectedElement = useCaseStore((s) => (members.length > 0 ? s.selectedElement : null));
  const selectedNodeId = useSldStore((s) => (members.length > 0 ? s.selectedNodeId : null));
  const named = members.filter((member) => member.nodeId === selectedNodeId);
  const selectedMember =
    named.length === 1
      ? named[0]!
      : selectedUnitMember(named.length > 1 ? named : members, selectedElement);
  const limitState = usePflowStore((s) =>
    getGeneratorLimitState(d.pflowIdx === undefined ? d.idx : d.pflowIdx, s.lastRun),
  );
  const { band, side } = qLimitMarker(limitState);
  const flagged = band === 'danger' || band === 'warning';
  const name = d.name || d.idx;
  const chainSide = d.unit?.side ?? 'above';
  const glyph = (
    <img
      src={iconForModel(d.symbolKind ?? d.kind)}
      alt=""
      aria-hidden="true"
      className="h-6 w-6 object-contain"
      draggable={false}
    />
  );
  return (
    <div
      data-testid={`generator-node-${d.idx}`}
      data-kind="generator"
      data-idx={d.idx}
      data-selected={selected ? 'true' : undefined}
      data-q-limit={flagged ? limitState : undefined}
      data-pending-dependent={isPendingDependent ? 'true' : undefined}
      data-unit-expanded={d.unit ? String(d.unit.expanded) : undefined}
      className={cn(
        'relative flex flex-col items-center gap-0.5 px-1.5 py-0.5',
        'bg-background text-foreground',
        'rounded-[var(--radius-md)] border',
        selected
          ? 'border-[var(--color-ring)] ring-2 ring-[var(--color-ring)]'
          : band === 'danger'
            ? 'border-danger shadow-[inset_0_0_0_1px_var(--color-danger)]'
            : band === 'warning'
              ? 'border-warning shadow-[inset_0_0_0_1px_var(--color-warning)]'
              : 'border-border',
        isPendingDependent ? 'ring-warning/60 ring-2' : '',
        'transition-colors duration-[var(--duration-fast)]',
        'cursor-pointer select-none',
      )}
    >
      <DevicePorts />
      {d.unit ? (
        <span className="grid grid-cols-[1fr_auto_1fr] items-center gap-x-[3px]">
          <UnitChips
            unitIdx={d.idx}
            members={members}
            selected={selectedMember}
            isPending={isPending}
            side="left"
          />
          {glyph}
          <UnitChips
            unitIdx={d.idx}
            members={members}
            selected={selectedMember}
            isPending={isPending}
            side="right"
          />
        </span>
      ) : (
        glyph
      )}
      <span className="text-foreground font-mono text-[9px] leading-none">{name}</span>
      {d.unit ? <UnitToggle unitIdx={d.idx} name={name} expanded={d.unit.expanded} /> : null}
      {flagged ? (
        <VoltageMarker
          band={band}
          side={side}
          label={qLimitMarkerLabel(limitState)}
          data-testid={`generator-q-marker-${d.idx}`}
          className="absolute -top-1 -right-1 h-[10px] w-[10px]"
        />
      ) : null}
      {d.unit?.expanded ? (
        <UnitChain
          unitIdx={d.idx}
          name={name}
          members={members}
          selected={selectedMember}
          isPending={isPending}
          side={chainSide}
          beyondReadout={(d.valueSide ?? 'below') === chainSide}
        />
      ) : null}
      <DeviceValueLabel kind="generator" data={d} />
    </div>
  );
});
