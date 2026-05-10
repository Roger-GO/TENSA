import { useEffect, useRef, useState } from 'react';
import { ChartLineIcon, EmptyState } from '@/components/ui/EmptyState';
import { useCaseStore } from '@/store/case';
import { useRunsStore } from '@/store/runs';
import { usePflowStore } from '@/store/pflow';
import type { RunRecord } from '@/store/runs';
import { cn } from '@/lib/cn';
import { InlineSparkline } from './InlineSparkline';

/**
 * PlotsAccordion (v3 Unit 9).
 *
 * Renders the per-element Plots section of the RightInspector accordion.
 * Three-tier data-source cascade per the F-FEAS-6 resolution:
 *
 *   1. Active TDS run + matching column → ``InlineSparkline`` from the
 *      run's history. Column-name derivation mirrors
 *      ``parseColumnName`` in ``store/plot.ts`` — bus voltage is
 *      ``Bus_<idx>_v``; generator state is ``Gen_<idx>_omega|delta``;
 *      line flow is ``Line_<idx>_p|q``.
 *   2. PF result (no active TDS) → static scalar badge from the
 *      ``pflow.lastRun`` summary.
 *   3. Neither → ``<EmptyState />`` ("Run PF or TDS to populate plots.")
 *
 * Implementation detail: the runs store is updated per-frame as TDS rows
 * stream in. Subscribing directly via Zustand triggers a render every
 * frame which churns the DOM. Per the plan this component throttles via
 * ``requestAnimationFrame`` — at most one render per animation frame —
 * and caps the rendered samples at 200 to keep the SVG path bounded.
 */

const SAMPLE_CAP = 200;

type SelectedKind = 'bus' | 'line' | 'transformer' | 'generator' | 'load' | 'shunt';

/**
 * Subscribe to the active run's column slice with a frame throttle.
 * Returns the latest sliced ``Float64Array`` (or null when no run /
 * column is available). The hook re-renders at most once per
 * ``requestAnimationFrame`` regardless of how many appends fire on the
 * runs store between frames.
 */
function useThrottledColumn(columnName: string | null): Float64Array | null {
  const activeRunId = useRunsStore((s) => s.activeRunId);
  const [snapshot, setSnapshot] = useState<Float64Array | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<Float64Array | null>(null);

  useEffect(() => {
    if (!activeRunId || !columnName) {
      setSnapshot(null);
      return;
    }
    // Sample once on (re-)subscribe so the panel paints immediately on
    // first selection without waiting for the next frame append.
    const seedRun: RunRecord | undefined = useRunsStore.getState().runs[activeRunId];
    if (seedRun) {
      const col = seedRun.columns[columnName];
      if (col) {
        const view = col.subarray(0, seedRun.seqCount);
        const start = view.length > SAMPLE_CAP ? view.length - SAMPLE_CAP : 0;
        setSnapshot(view.slice(start));
      } else {
        setSnapshot(null);
      }
    }

    const flush = () => {
      rafRef.current = null;
      const next = pendingRef.current;
      pendingRef.current = null;
      if (next === null) return;
      setSnapshot(next);
    };

    const schedule = (next: Float64Array) => {
      pendingRef.current = next;
      if (rafRef.current !== null) return;
      // jsdom + vitest run with a polyfilled rAF that's effectively
      // setTimeout(0); production wires the real frame loop. Either way
      // we only enqueue once per pending slice.
      rafRef.current = requestAnimationFrame(flush);
    };

    const unsubscribe = useRunsStore.subscribe((state) => {
      const run: RunRecord | undefined = state.runs[activeRunId];
      if (!run) {
        if (pendingRef.current !== null) pendingRef.current = null;
        setSnapshot(null);
        return;
      }
      const col = run.columns[columnName];
      if (!col) return;
      const view = col.subarray(0, run.seqCount);
      const start = view.length > SAMPLE_CAP ? view.length - SAMPLE_CAP : 0;
      schedule(view.slice(start));
    });

    return () => {
      unsubscribe();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      pendingRef.current = null;
    };
  }, [activeRunId, columnName]);

  return snapshot;
}

interface KindContentProps {
  kind: SelectedKind;
  idx: string;
}

function BusContent({ idx }: { idx: string }) {
  const colName = `Bus_${idx}_v`;
  const samples = useThrottledColumn(colName);
  const pflow = usePflowStore((s) => s.lastRun);

  if (samples && samples.length >= 2) {
    return (
      <InlineSparkline
        values={Array.from(samples)}
        label="Voltage (pu)"
        valueFormat={(v) => v.toFixed(4)}
      />
    );
  }
  if (pflow && pflow.converged) {
    const v = pflow.bus_voltages[idx];
    if (v !== undefined && Number.isFinite(v)) {
      return (
        <div data-testid="plots-static-badge" className="flex flex-col gap-1">
          <span className="text-muted-foreground text-[10px] tracking-wide uppercase">
            Voltage (pu)
          </span>
          <span className="text-foreground font-mono text-lg">{v.toFixed(4)}</span>
          <span className="text-muted-foreground text-[10px]">From PF result</span>
        </div>
      );
    }
  }
  return <PlotsEmpty />;
}

function GeneratorContent({ idx }: { idx: string }) {
  const omegaSamples = useThrottledColumn(`Gen_${idx}_omega`);
  const deltaSamples = useThrottledColumn(`Gen_${idx}_delta`);
  const pflow = usePflowStore((s) => s.lastRun);

  const hasOmega = omegaSamples && omegaSamples.length >= 2;
  const hasDelta = deltaSamples && deltaSamples.length >= 2;
  if (hasOmega || hasDelta) {
    return (
      <div className="flex flex-col gap-3">
        {hasOmega ? (
          <InlineSparkline
            values={Array.from(omegaSamples!)}
            label="ω (pu)"
            valueFormat={(v) => v.toFixed(4)}
          />
        ) : null}
        {hasDelta ? (
          <InlineSparkline
            values={Array.from(deltaSamples!)}
            label="δ (rad)"
            valueFormat={(v) => v.toFixed(4)}
          />
        ) : null}
      </div>
    );
  }

  if (pflow && pflow.converged) {
    const gen = pflow.generator_outputs?.[idx];
    if (gen) {
      return (
        <div data-testid="plots-static-badge" className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground text-[10px] tracking-wide uppercase">P</span>
            <span className="text-foreground font-mono text-sm">{gen.p.toFixed(2)} MW</span>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground text-[10px] tracking-wide uppercase">Q</span>
            <span className="text-foreground font-mono text-sm">{gen.q.toFixed(2)} MVAr</span>
          </div>
          <span className="text-muted-foreground text-[10px]">From PF result</span>
        </div>
      );
    }
  }
  return <PlotsEmpty />;
}

function LineContent({ idx }: { idx: string }) {
  const pSamples = useThrottledColumn(`Line_${idx}_p`);
  const qSamples = useThrottledColumn(`Line_${idx}_q`);
  const pflow = usePflowStore((s) => s.lastRun);

  const hasP = pSamples && pSamples.length >= 2;
  const hasQ = qSamples && qSamples.length >= 2;
  if (hasP || hasQ) {
    return (
      <div className="flex flex-col gap-3">
        {hasP ? (
          <InlineSparkline
            values={Array.from(pSamples!)}
            label="P (MW)"
            valueFormat={(v) => v.toFixed(2)}
          />
        ) : null}
        {hasQ ? (
          <InlineSparkline
            values={Array.from(qSamples!)}
            label="Q (MVAr)"
            valueFormat={(v) => v.toFixed(2)}
          />
        ) : null}
      </div>
    );
  }
  if (pflow && pflow.converged) {
    const flow = pflow.line_flows?.[idx];
    if (flow) {
      return (
        <div data-testid="plots-static-badge" className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground text-[10px] tracking-wide uppercase">P</span>
            <span className="text-foreground font-mono text-sm">{flow.p.toFixed(2)} MW</span>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground text-[10px] tracking-wide uppercase">Q</span>
            <span className="text-foreground font-mono text-sm">{flow.q.toFixed(2)} MVAr</span>
          </div>
          <span className="text-muted-foreground text-[10px]">From PF result</span>
        </div>
      );
    }
  }
  return <PlotsEmpty />;
}

function LoadContent({ idx }: { idx: string }) {
  const pflow = usePflowStore((s) => s.lastRun);
  if (pflow && pflow.converged) {
    const ld = pflow.load_consumption?.[idx];
    if (ld) {
      return (
        <div data-testid="plots-static-badge" className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground text-[10px] tracking-wide uppercase">P</span>
            <span className="text-foreground font-mono text-sm">{ld.p.toFixed(2)} MW</span>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground text-[10px] tracking-wide uppercase">Q</span>
            <span className="text-foreground font-mono text-sm">{ld.q.toFixed(2)} MVAr</span>
          </div>
          <span className="text-muted-foreground text-[10px]">From PF result</span>
        </div>
      );
    }
  }
  return <PlotsEmpty />;
}

function PlotsEmpty() {
  return (
    <EmptyState
      icon={<ChartLineIcon />}
      title="No plot data"
      description="Run power flow or TDS to populate this section."
      emptyStateKey="plots-accordion-empty"
      className="py-4"
    />
  );
}

function KindContent({ kind, idx }: KindContentProps) {
  switch (kind) {
    case 'bus':
      return <BusContent idx={idx} />;
    case 'generator':
      return <GeneratorContent idx={idx} />;
    case 'line':
    case 'transformer':
      return <LineContent idx={idx} />;
    case 'load':
      return <LoadContent idx={idx} />;
    case 'shunt':
    default:
      return <PlotsEmpty />;
  }
}

export interface PlotsAccordionProps {
  className?: string;
}

export function PlotsAccordion({ className }: PlotsAccordionProps) {
  const selectedElement = useCaseStore((s) => s.selectedElement);
  if (!selectedElement) {
    return (
      <div data-testid="plots-accordion" className={cn('flex flex-col gap-2', className)}>
        <PlotsEmpty />
      </div>
    );
  }
  return (
    <div data-testid="plots-accordion" className={cn('flex flex-col gap-2', className)}>
      <KindContent kind={selectedElement.kind} idx={selectedElement.idx} />
    </div>
  );
}
