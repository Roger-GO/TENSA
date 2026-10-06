import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { iconForModel } from '@/icons/iec60617/manifest';
import { cn } from '@/lib/cn';
import { useIsPendingDependent } from '@/store/pendingDependents';
import { usePflowStore } from '@/store/pflow';
import { getGeneratorLimitState } from '../overlay';
import { qLimitMarker, qLimitMarkerLabel } from '../qLimit';
import { VoltageMarker } from '../VoltageMarker';
import type { SldNodeData } from './BusNode';
import { DevicePorts } from './DevicePorts';
import { DeviceValueLabel } from './DeviceValueLabel';

/**
 * Generator node. Renders the IEC 60617 generator glyph (a circle with
 * a tilde or "G"); the static-vs-synchronous distinction is encoded in
 * the icon manifest (`PV`/`Slack` → `generator.svg`; `GENROU`/`GENCLS`
 * → `generator-syngen.svg`).
 *
 * Connected to its bus by a stub edge that leaves from the port on the
 * face that points at the bus (`DevicePorts`) and lands on a tap of the
 * bar. Click to inspect. After a converged PF it
 * carries its P / Q readout (`DeviceValueLabel`), and a generator whose
 * reactive output is on or past a limit gets an amber or red outline and a
 * triangle on its corner (up at `qmax`, down at `qmin`; empty on the limit,
 * filled past it) so the state does not rest on colour alone. The triangle
 * hangs off the corner and adds nothing to the node's box.
 */
export const GeneratorNode = memo(function GeneratorNode({ data, selected }: NodeProps) {
  const d = data as SldNodeData;
  const isPendingDependent = useIsPendingDependent(d.kind, d.idx);
  const limitState = usePflowStore((s) =>
    getGeneratorLimitState(d.pflowIdx === undefined ? d.idx : d.pflowIdx, s.lastRun),
  );
  const { band, side } = qLimitMarker(limitState);
  const flagged = band === 'danger' || band === 'warning';
  return (
    <div
      data-testid={`generator-node-${d.idx}`}
      data-kind="generator"
      data-idx={d.idx}
      data-q-limit={flagged ? limitState : undefined}
      data-pending-dependent={isPendingDependent ? 'true' : undefined}
      className={cn(
        'relative flex flex-col items-center gap-0.5 px-1.5 py-0.5',
        'bg-background text-foreground',
        'rounded-[var(--radius-md)] border',
        selected
          ? 'border-[var(--color-ring)] ring-2 ring-[var(--color-ring)]'
          : band === 'danger'
            ? 'border-danger border-2'
            : band === 'warning'
              ? 'border-warning border-2'
              : 'border-border',
        isPendingDependent ? 'ring-warning/60 ring-2' : '',
        'transition-colors duration-[var(--duration-fast)]',
        'cursor-pointer select-none',
      )}
    >
      <DevicePorts />
      <img
        src={iconForModel(d.kind)}
        alt=""
        aria-hidden="true"
        className="h-6 w-6 object-contain"
        draggable={false}
      />
      <span className="text-foreground font-mono text-[9px] leading-none">{d.name || d.idx}</span>
      {flagged ? (
        <VoltageMarker
          band={band}
          side={side}
          label={qLimitMarkerLabel(limitState)}
          data-testid={`generator-q-marker-${d.idx}`}
          className="absolute -top-1 -right-1 h-[10px] w-[10px]"
        />
      ) : null}
      <DeviceValueLabel kind="generator" data={d} />
    </div>
  );
});
