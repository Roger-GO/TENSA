import { useEffect, useRef, useState } from 'react';
import { ChartLineIcon, EmptyState } from '@/components/ui/EmptyState';
import { useCaseStore } from '@/store/case';
import type { SelectedElement } from '@/store/case';
import { useRunsStore } from '@/store/runs';
import { usePflowStore } from '@/store/pflow';
import { useUnitsStore } from '@/store/units';
import type { RunRecord } from '@/store/runs';
import { cn } from '@/lib/cn';
import { findTopologyEntry, generatorRowKey } from '@/lib/topology';
import {
  busBaseKv,
  displayDecimals,
  radToDeg,
  speedDisplay,
  unitBasesOf,
  voltageDisplay,
  type UnitBases,
} from '@/lib/units';
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
 * Voltage and speed read in pu or in kV and Hz with the display units
 * (``lib/units.ts``); angles read in degrees. A run's samples convert with the
 * bases the run was started with, the PF badge with those of the open case.
 *
 * Implementation detail: the runs store is updated per-frame as TDS rows
 * stream in. Subscribing directly via Zustand triggers a render every
 * frame which churns the DOM. Per the plan this component throttles via
 * ``requestAnimationFrame`` — at most one render per animation frame —
 * and caps the rendered samples at 200 to keep the SVG path bounded.
 */

const SAMPLE_CAP = 200;

// Plot channels exist only for static elements; a controller selection
// falls through `KindContent`'s default branch to the empty state (a
// controller's signals plot under its parent device).
type SelectedKind = SelectedElement['kind'];

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

/** The unit bases of the active run: what its streamed values convert to actual units with. */
function useActiveRunBases(): UnitBases | undefined {
  return useRunsStore((s) => (s.activeRunId ? s.runs[s.activeRunId]?.bases : undefined));
}

interface KindContentProps {
  kind: SelectedKind;
  idx: string;
  /** Row of the PF result's `generator_outputs` that a generator reads. */
  pflowKey: string;
  /** The open case's unit bases, for the values read off the PF result. */
  bases: UnitBases | undefined;
}

function BusContent({ idx, bases }: { idx: string; bases: UnitBases | undefined }) {
  const colName = `Bus_${idx}_v`;
  const samples = useThrottledColumn(colName);
  const pflow = usePflowStore((s) => s.lastRun);
  const unitMode = useUnitsStore((s) => s.mode);
  const runBases = useActiveRunBases();

  if (samples && samples.length >= 2) {
    const display = voltageDisplay(unitMode, busBaseKv(runBases, idx));
    const decimals = displayDecimals(display, 4);
    return (
      <InlineSparkline
        values={Array.from(samples, (v) => v * display.factor)}
        label={`Voltage (${display.unit})`}
        valueFormat={(v) => v.toFixed(decimals)}
      />
    );
  }
  if (pflow && pflow.converged) {
    const v = pflow.bus_voltages[idx];
    if (v !== undefined && Number.isFinite(v)) {
      const display = voltageDisplay(unitMode, busBaseKv(bases, idx));
      return (
        <div data-testid="plots-static-badge" className="flex flex-col gap-1">
          <span className="text-muted-foreground text-[10px] tracking-wide uppercase">
            Voltage ({display.unit})
          </span>
          <span className="text-foreground font-mono text-lg">
            {(v * display.factor).toFixed(displayDecimals(display, 4))}
          </span>
          <span className="text-muted-foreground text-[10px]">From PF result</span>
        </div>
      );
    }
  }
  return <PlotsEmpty />;
}

function GeneratorContent({ idx, pflowKey }: { idx: string; pflowKey: string }) {
  const omegaSamples = useThrottledColumn(`Gen_${idx}_omega`);
  const deltaSamples = useThrottledColumn(`Gen_${idx}_delta`);
  const pflow = usePflowStore((s) => s.lastRun);
  const unitMode = useUnitsStore((s) => s.mode);
  const runBases = useActiveRunBases();

  const hasOmega = omegaSamples && omegaSamples.length >= 2;
  const hasDelta = deltaSamples && deltaSamples.length >= 2;
  if (hasOmega || hasDelta) {
    const speed = speedDisplay(unitMode, runBases?.freqHz);
    const speedDecimals = displayDecimals(speed, 4);
    return (
      <div className="flex flex-col gap-3">
        {hasOmega ? (
          <InlineSparkline
            values={Array.from(omegaSamples!, (v) => v * speed.factor)}
            label={speed.unit === 'Hz' ? 'f (Hz)' : 'ω (pu)'}
            valueFormat={(v) => v.toFixed(speedDecimals)}
          />
        ) : null}
        {hasDelta ? (
          <InlineSparkline
            values={Array.from(deltaSamples!, radToDeg)}
            label="δ (°)"
            valueFormat={(v) => v.toFixed(2)}
          />
        ) : null}
      </div>
    );
  }

  if (pflow && pflow.converged) {
    const gen = pflow.generator_outputs?.[pflowKey];
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

function KindContent({ kind, idx, pflowKey, bases }: KindContentProps) {
  switch (kind) {
    case 'bus':
      return <BusContent idx={idx} bases={bases} />;
    case 'generator':
      return <GeneratorContent idx={idx} pflowKey={pflowKey} />;
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
  const topology = useCaseStore((s) => s.topology);
  if (!selectedElement) {
    return (
      <div data-testid="plots-accordion" className={cn('flex flex-col gap-2', className)}>
        <PlotsEmpty />
      </div>
    );
  }
  // A dynamic machine has no PF row of its own: it reads its static generator's.
  const entry = topology ? findTopologyEntry(topology, selectedElement) : null;
  return (
    <div data-testid="plots-accordion" className={cn('flex flex-col gap-2', className)}>
      <KindContent
        kind={selectedElement.kind}
        idx={selectedElement.idx}
        pflowKey={entry ? generatorRowKey(entry) : selectedElement.idx}
        bases={unitBasesOf(topology)}
      />
    </div>
  );
}
