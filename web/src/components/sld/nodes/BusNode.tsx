import { Fragment, memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { cn } from '@/lib/cn';
import { usePflowStore } from '@/store/pflow';
import { useUiStore } from '@/store/ui';
import { useUnitsStore } from '@/store/units';
import { voltageDisplay } from '@/lib/units';
import { useIsPendingDependent } from '@/store/pendingDependents';
import { useRunsStore } from '@/store/runs';
import { useFrameBusOverlay } from '@/store/animation';
import { colorClassForBand, getBusOverlayState } from '../overlay';
import {
  DEFAULT_VOLTAGE_LIMITS,
  barClassForBand,
  formatVoltageLimits,
  type VoltageLimits,
} from '../voltage';
import { VoltageMarker } from '../VoltageMarker';
import {
  BAR_LENGTH,
  BAR_THICKNESS,
  TAP_DOT_RADIUS,
  busLabelPlace,
  type BarGeometry,
} from '../connections';
import { SOURCE_HANDLE, TARGET_HANDLE, type Side, type UnitNodeData } from '../graph';
import { BUS_LABEL_BESIDE_GAP, busLabelWidth, type BusLabelSide } from '../labels';

/**
 * Shape of `data` for an IEC 60617 SLD node. Shared across BusNode +
 * the device nodes (LineNode is the rare case where a "node" is really
 * a midpoint marker; transformers / generators / loads / shunts are
 * proper devices anchored to a bus).
 *
 * `voltage` / `angle` are reserved for Unit 9 — the canvas has no PF
 * data in Unit 8 scope and these fields stay undefined here.
 */
export interface SldNodeData extends Record<string, unknown> {
  idx: string;
  name: string;
  kind: string;
  voltage?: number;
  angle?: number;
  /**
   * Unit 11 — true when this bus node is the active selection driven
   * via the SLD search popover or an inspector-row click. The flag is
   * stamped onto `node.data` by `SldCanvas.nodesWithSelection` so the
   * highlight survives a click that originated outside React Flow's
   * own selection model.
   */
  sldSelected?: boolean;
  /**
   * Generator / load nodes: the key of this device's row in the PF
   * result maps, or `null` when another node prints that row. A generating
   * unit reads the row of its static generator. A dynamic machine (GENROU /
   * GENCLS) that is drawn on its own reads the row of the static generator
   * it names in `gen`, since it has none of its own, unless the node of
   * that generator prints it. Absent: read the row under the node's own
   * idx. Stamped by `buildGraph`.
   */
  pflowIdx?: string | null;
  /**
   * Bus nodes: the voltage limits (pu) the bus is judged against, from its
   * `vmin` / `vmax` with the 0.95 / 1.05 default where the case sets none.
   * Absent: the default. Stamped by `buildGraph`.
   */
  voltageLimits?: VoltageLimits;
  /**
   * Bus nodes: the bus's rated voltage (kV), which the voltage label reads
   * in under the actual-units display. Absent where the case sets none.
   * Stamped by `buildGraph`.
   */
  baseKv?: number;
  /**
   * Generator / load nodes: which side of the node its P / Q readout hangs
   * off: the side facing the parent bus given where the device finally
   * sits, or the far side of a device that hangs so close under its bus
   * that the label of the bus is in between. Stamped by `buildGraph`.
   */
  valueSide?: 'above' | 'below';
  /**
   * Bus nodes: where the bar starts and ends and where its taps are, as
   * `connections.ts` worked them out from what connects to the bus. Absent:
   * a bar of the default length with no taps. Stamped by `SldCanvas`.
   */
  bar?: BarGeometry;
  /**
   * Bus nodes: where the label stands (`placeBusLabels`): under the bar or
   * over it, with the x of its middle as an offset from the origin of the
   * node, beside the east or the west tip of the bar, level with it, or
   * `away` from the bar, with `top` the offset of its top edge as well.
   * `compact` where it has room next to its bar for the name alone: the
   * voltage and the angle of a power flow are left off it, and are in its
   * tooltip. Absent: under the bar, clear of the connectors that land there.
   * Stamped by `SldCanvas`.
   */
  labelAt?: { offset: number; side: BusLabelSide; top?: number; compact?: boolean };
  /**
   * Generator / load / shunt nodes: the face the connector to the bus
   * leaves by. The P / Q readout moves aside when it hangs off that face.
   * Stamped by `SldCanvas`.
   */
  connectorFace?: Side;
  /**
   * Generator / load / shunt nodes: which way the connector goes from the
   * middle of that face, `-1` to the left and `1` to the right; absent when
   * it runs straight out. The P / Q readout stands on the other side of it.
   * Stamped by `SldCanvas`.
   */
  connectorLean?: number;
  /**
   * Generator / load nodes: where the P / Q readout stands when it is not
   * where it would stand first (right of a connector that runs straight out
   * of the face it hangs off): `left` of the connector, on the `far` side of
   * the device, or beside its symbol on the `east` or the `west`. Another
   * connector runs through the first place, or something stands there.
   * `none` when every one of those places is taken: the readout is left off
   * (the values are in the tables and in the Inspector). Stamped by
   * `SldCanvas`.
   */
  readoutSpot?: 'left' | 'far' | 'east' | 'west' | 'none';
  /**
   * Generator nodes that stand for a generating unit of more than one model
   * (a static generator with its machine and their controllers): the models
   * the symbol names, whether their chain is drawn out, and on which side of
   * the symbol. Absent on a generator of one model. Stamped by `buildGraph`.
   */
  unit?: UnitNodeData;
  /**
   * Generator nodes of such a unit: the model whose symbol is drawn, which
   * is the machine where the unit has one. Absent: the node's own `kind`.
   * Stamped by `buildGraph`.
   */
  symbolKind?: string;
}

const SIDES: Array<{ side: Side; position: Position }> = [
  { side: 'north', position: Position.Top },
  { side: 'east', position: Position.Right },
  { side: 'south', position: Position.Bottom },
  { side: 'west', position: Position.Left },
];

/**
 * Bus node — drawn as a traditional one-line **busbar**: a thick
 * horizontal bar that feeders (lines, transformers, generators, loads)
 * tap onto, with the name + voltage/angle label offset below. The bar
 * itself is the electrical bus and the connection target for every
 * branch edge.
 *
 * Four cardinal Handle pairs (source + target) sit ON the bar. Edges set
 * `sourceHandle`/`targetHandle` to one of `<side>-source` /
 * `<side>-target` (see `graph.ts`'s `SOURCE_HANDLE` / `TARGET_HANDLE`).
 * Where each feeder lands is a tap on the bar (`data.bar`, worked out in
 * `connections.ts`): the bar draws a dot at every tap, and is as long as
 * its taps need. A bar that outgrows the default length grows out of both
 * sides of the node, whose own box and origin stay as they are. The label
 * hangs under the middle of the bar, and moves along it to stay clear of a
 * feeder that comes up from below, of a line that passes under the bar and
 * of a symbol that stands there; with no place left under the bar it stands
 * over it, and with none there either beside a tip of the bar
 * (`data.labelAt`, which the canvas works out for the whole diagram).
 *
 * Unit 9: subscribes to `pflow.lastRun` + `ui.hideLabels` and consumes
 * `getBusOverlayState` to tint the bar on a limit violation + show a
 * voltage / angle label below it when post-PF. The bar's tint is judged
 * against the bus's own limits (`data.voltageLimits`), and a bus near or
 * past a limit also carries a triangle beside its name (`VoltageMarker`)
 * that stays when "Hide labels" is on, so the state does not rest on
 * colour alone.
 */
export const BusNode = memo(function BusNode({ data, selected }: NodeProps) {
  const d = data as SldNodeData;
  const pflowResult = usePflowStore((s) => s.lastRun);
  const hideLabels = useUiStore((s) => s.hideLabels);
  const unitMode = useUnitsStore((s) => s.mode);
  const pflowOverlay = getBusOverlayState(
    d.idx,
    pflowResult,
    hideLabels,
    d.voltageLimits,
    voltageDisplay(unitMode, d.baseKv),
  );
  const isPendingDependent = useIsPendingDependent(d.kind, d.idx);

  // v0.2 Unit 5: streaming-overlay layer.
  //
  // When a TDS run is active (or a finished run is being scrubbed), the
  // animation slice carries this bus's per-frame band, written by the
  // single rAF loop in :func:`useSldFrameOverlay`. We layer that on top
  // of the v0.1 PF-result overlay:
  //
  // - Streaming overlay present → use its band + color, but keep the
  //   v0.1 voltage/angle labels (they show the steady-state PF reading;
  //   the streaming reading lives in the plot. Numeric SLD labels
  //   during streaming are deferred — they'd require their own slower
  //   write cadence to avoid visual noise).
  // - Streaming overlay absent → fall back to ``pflowOverlay`` exactly
  //   as v0.1 behaved.
  //
  // The selector returns a stable null reference when no run is active,
  // so the component doesn't re-render on every animation tick of an
  // OTHER bus — Zustand's default reference equality on a returned
  // ``null`` is no-op.
  const activeRunId = useRunsStore((s) => s.activeRunId);
  const frameOverlay = useFrameBusOverlay(activeRunId, d.idx);
  const effectiveBand = frameOverlay !== null ? frameOverlay.band : pflowOverlay.band;
  const effectiveSide = frameOverlay !== null ? frameOverlay.side : pflowOverlay.side;
  const effectiveColorClass =
    frameOverlay !== null ? colorClassForBand(frameOverlay.band) : pflowOverlay.color_class;

  // Unit 11 — `sldSelected` lights the same border/ring as React Flow's
  // own `selected` flag. Both go through the same Tailwind branch via
  // a `data-[selected=true]` selector so the visual stays in lockstep.
  const isSldSelected = d.sldSelected === true;
  const visuallySelected = selected || isSldSelected;
  const barBg = barClassForBand(effectiveBand);
  const barStart = d.bar?.start ?? 0;
  const barEnd = d.bar?.end ?? BAR_LENGTH;
  // One dot per tap: every connection lands at a place of its own.
  const tapXs = [...new Set((d.bar?.taps ?? []).map((tap) => tap.x))];
  // Where the label stands: where the canvas put it, clear of everything
  // else on the diagram, and under the bar otherwise, by the width the
  // diagram takes it to have.
  const labelAt = d.labelAt ?? {
    offset: busLabelPlace(
      d.bar,
      busLabelWidth(d.name || d.idx, pflowOverlay.voltage_label !== null),
    ).offset,
    side: 'below' as const,
  };
  const labelShift = labelAt.offset - BAR_LENGTH / 2;
  // Where the label has room for the name alone, the values a power flow
  // gave are left off it and said in its tooltip.
  const compact = labelAt.compact === true;
  const leftOff = compact
    ? [pflowOverlay.voltage_label, pflowOverlay.angle_label].filter((text) => text !== null)
    : [];
  // `effectiveColorClass` (border-success/...) is retained on the node so
  // existing band-colour assertions keep working AND assistive tooling can
  // read the band off the wrapper; it's visually inert (no border drawn).
  return (
    <div
      data-testid={`bus-node-${d.idx}`}
      data-kind="bus"
      data-idx={d.idx}
      data-band={effectiveBand}
      data-limit-side={effectiveSide ?? undefined}
      data-streaming={frameOverlay !== null ? 'true' : undefined}
      data-pending-dependent={isPendingDependent ? 'true' : undefined}
      data-selected={visuallySelected ? 'true' : undefined}
      className={cn(
        'group relative flex w-[92px] cursor-pointer flex-col items-center select-none',
        effectiveColorClass,
      )}
    >
      {/* Busbar — a thick horizontal bar. Handles sit on it (it is a
          `position: relative` box so the cardinal handles land on the bar,
          not the wider wrapper that also holds the label). */}
      <div className="relative w-full" style={{ height: BAR_THICKNESS }}>
        {SIDES.map(({ side, position }) => (
          <Fragment key={side}>
            <Handle
              type="target"
              position={position}
              id={TARGET_HANDLE[side]}
              className="!h-0 !min-h-0 !w-0 !min-w-0 !border-0 !bg-transparent"
            />
            <Handle
              type="source"
              position={position}
              id={SOURCE_HANDLE[side]}
              className="!h-0 !min-h-0 !w-0 !min-w-0 !border-0 !bg-transparent"
            />
          </Fragment>
        ))}
        <div
          data-testid={`bus-bar-${d.idx}`}
          data-bar-length={barEnd - barStart}
          className={cn(
            'absolute top-0 h-full rounded-full',
            barBg,
            // Subtle depth so the bar reads as a physical busbar.
            'shadow-[0_1px_2px_rgba(0,0,0,0.18)]',
            // Selection / pending highlight as a ring around the bar.
            visuallySelected ? 'ring-2 ring-[var(--color-ring)] ring-offset-1' : '',
            isPendingDependent ? 'ring-warning/70 ring-2 ring-offset-1' : '',
            'ring-offset-background',
          )}
          // Voltage-band colour transition on the bar fill (Unit 19).
          style={{
            left: barStart,
            width: barEnd - barStart,
            transition: 'background-color var(--duration-base) var(--ease-out-quart)',
          }}
        />
        {/* One dot per tap, on top of the bar: where a feeder lands. */}
        {tapXs.map((x) => (
          <span
            key={x}
            data-testid={`bus-tap-${d.idx}`}
            data-tap-x={x}
            aria-hidden="true"
            className="bg-foreground pointer-events-none absolute rounded-full"
            style={{
              left: x - TAP_DOT_RADIUS,
              top: BAR_THICKNESS / 2 - TAP_DOT_RADIUS,
              width: 2 * TAP_DOT_RADIUS,
              height: 2 * TAP_DOT_RADIUS,
            }}
          />
        ))}
      </div>
      {/* Label block, offset below the bar, or over it where there is no
          place for it below. A faint backing keeps the text legible where a
          feeder line passes behind it. */}
      <div
        data-testid={`bus-label-${d.idx}`}
        data-label-side={labelAt.side === 'below' ? undefined : labelAt.side}
        data-label-compact={compact ? 'true' : undefined}
        title={`${d.name || d.idx}: ${leftOff.length > 0 ? `${leftOff.join(', ')}; ` : ''}voltage limits ${formatVoltageLimits(d.voltageLimits ?? DEFAULT_VOLTAGE_LIMITS)}`}
        className={cn(
          'bg-background/70 flex flex-col gap-0 rounded px-1 leading-tight whitespace-nowrap',
          labelAt.side === 'below'
            ? 'relative mt-1 items-center'
            : labelAt.side === 'above'
              ? 'absolute bottom-full mb-1 -translate-x-1/2 items-center'
              : labelAt.side === 'away'
                ? 'absolute -translate-x-1/2 items-center'
                : labelAt.side === 'east'
                  ? 'absolute -translate-y-1/2 items-start'
                  : 'absolute -translate-x-full -translate-y-1/2 items-end',
        )}
        style={
          labelAt.side === 'below'
            ? labelShift === 0
              ? undefined
              : { left: labelShift }
            : labelAt.side === 'above'
              ? { left: labelAt.offset }
              : labelAt.side === 'away'
                ? { left: labelAt.offset, top: labelAt.top ?? BAR_THICKNESS }
                : labelAt.side === 'east'
                  ? { left: barEnd + BUS_LABEL_BESIDE_GAP, top: BAR_THICKNESS / 2 }
                  : { left: barStart - BUS_LABEL_BESIDE_GAP, top: BAR_THICKNESS / 2 }
        }
      >
        <span className="flex items-center gap-0.5">
          <span className="text-foreground font-mono text-[10px] leading-tight font-medium">
            {d.name || d.idx}
          </span>
          <VoltageMarker
            band={effectiveBand}
            side={effectiveSide}
            data-testid={`bus-limit-marker-${d.idx}`}
          />
        </span>
        {pflowOverlay.voltage_label !== null && !compact ? (
          <span
            data-testid={`bus-voltage-${d.idx}`}
            className="text-foreground font-mono text-[10px] leading-tight"
          >
            {pflowOverlay.voltage_label}
          </span>
        ) : null}
        {pflowOverlay.angle_label !== null && !compact ? (
          <span
            data-testid={`bus-angle-${d.idx}`}
            className="text-muted-foreground font-mono text-[9px] leading-tight"
          >
            {pflowOverlay.angle_label}
          </span>
        ) : null}
      </div>
    </div>
  );
});
