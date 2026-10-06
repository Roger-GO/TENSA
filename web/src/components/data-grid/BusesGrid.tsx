/**
 * BusesGrid (v3 Unit 13).
 *
 * Bottom-drawer "Buses" tab. Reads topology from the TanStack Query
 * cache + per-bus PF result from ``usePflowStore.lastRun``. Row click
 * writes both ``useSldStore.selectedNodeId`` (drives canvas pan +
 * highlight) AND ``useCaseStore.selectedElement`` (drives the right
 * inspector form data) per the F-DESIGN-7 dual-write pattern. Bus
 * rowId is the bare ``idx`` string — bus React Flow nodes use the
 * bare idx as their node id.
 *
 * Columns mirror the retired v2 BUS_COLUMNS shape verbatim (the
 * canonical pattern from Phase 2 Unit 11; v2 file retired in v3
 * Unit 15) plus area + zone (per the v3 plan unit-13 spec). The two
 * voltage limits each bus is judged on, and the verdict in words, sit
 * right after V so a bus's voltage, its limits and where it stands read
 * across one row (the diagram says the same with a bar colour and a
 * triangle). The angle reads in degrees, as on the diagram and in the
 * Inspector; V and its limits read in pu or kV with the display units.
 *
 * The rated voltage (`Vn`), the two limits, area and zone are the case's own
 * values and can be changed in the table, before the case has been run: a limit
 * shown in kV is typed in kV and written per unit on the bus's rated voltage (the new
 * one, when the same edit sets it). The rest are results.
 * p_inj / q_inj are computed client-side from the PF result's
 * per-device ``generator_outputs`` / ``load_consumption`` maps:
 * the net bus injection is Σ gen P − Σ load P at the bus (same for
 * Q). Buses with no attached generator or load render ``—``.
 */
import { useMemo } from 'react';
import { DataGrid, type ColumnConfig } from './DataGrid';
import { formatParamValue } from './gridCells';
import { useGridEditing, type GridEditTarget } from './useGridEditing';
import { useCurrentTopology } from '@/api/queries';
import { usePflowStore } from '@/store/pflow';
import { useSldStore } from '@/store/sld';
import { useCaseStore } from '@/store/case';
import { useUnitsStore } from '@/store/units';
import { busBaseKv, radToDeg, unitBasesOf, type DisplayUnit } from '@/lib/units';
import {
  DEFAULT_VOLTAGE_LIMITS,
  VOLTAGE_WARNING_MARGIN,
  assessVoltage,
  busVoltageLimits,
  voltageStatusText,
} from '@/components/sld/voltage';
import type { ParamValue, PflowResult } from '@/api/types';
import { paramNumber, paramString } from './entryParams';

interface BusRow {
  idx: string;
  name: string;
  /** Rated voltage in kV, as the case gives it. */
  vn: number | null;
  /** What a per-unit value is multiplied by to read in the unit the voltage columns show. */
  toShown: number;
  /** In the unit the V column reads in (pu, or kV with the display units). */
  v: number | null;
  /** The limits the bus is judged on (its own, or the 0.95 / 1.05 pu default), in the same unit. */
  vmin: number;
  vmax: number;
  /** Where `v` stands against them, in words; null without a converged voltage. */
  limit_check: string | null;
  /** Degrees. */
  theta: number | null;
  p_inj: number | null;
  q_inj: number | null;
  area: string | null;
  zone: string | null;
}

interface BusInjection {
  p: number;
  q: number;
}

/**
 * Net per-bus P/Q injection (MW / MVAr) from the last converged PF
 * result: Σ generator output − Σ load consumption at each bus. Buses
 * with neither a generator nor a load are absent from the map, so the
 * grid keeps rendering ``—`` for them.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function computeBusInjections(pflow: PflowResult | null): Map<string, BusInjection> {
  const map = new Map<string, BusInjection>();
  if (!pflow?.converged) return map;
  const accumulate = (bus: string | number, p: number, q: number, sign: 1 | -1) => {
    const key = String(bus);
    const cur = map.get(key) ?? { p: 0, q: 0 };
    map.set(key, { p: cur.p + sign * p, q: cur.q + sign * q });
  };
  for (const gen of Object.values(pflow.generator_outputs ?? {})) {
    accumulate(gen.bus, gen.p, gen.q, 1);
  }
  for (const load of Object.values(pflow.load_consumption ?? {})) {
    accumulate(load.bus, load.p, load.q, -1);
  }
  return map;
}

/** The columns, with V and its limits labelled in the unit they read in. */
function columnsFor(voltageUnit: DisplayUnit): ColumnConfig<BusRow>[] {
  const inKv =
    voltageUnit === 'kV' ? '. Shown in kV: the pu limit times the rated voltage of the bus.' : '';
  return [
    { key: 'idx', label: 'idx', minWidth: 64, accessor: (r) => r.idx },
    { key: 'name', label: 'name', minWidth: 96, accessor: (r) => r.name },
    {
      key: 'vn',
      label: 'Vn (kV)',
      title: 'Rated voltage of the bus, the base its per-unit values are read against',
      minWidth: 88,
      numeric: true,
      format: formatParamValue,
      accessor: (r) => r.vn,
      edit: { param: 'Vn' },
    },
    { key: 'v', label: `V (${voltageUnit})`, minWidth: 84, numeric: true, accessor: (r) => r.v },
    {
      key: 'vmin',
      label: `vmin (${voltageUnit})`,
      title: `Lower voltage limit this bus is judged on: the one the case sets, or ${DEFAULT_VOLTAGE_LIMITS.vmin} pu if it sets none${inKv}`,
      minWidth: 96,
      numeric: true,
      format: formatParamValue,
      accessor: (r) => r.vmin,
      edit: { param: 'vmin', toParam: (shown, row) => shown / row.toShown },
    },
    {
      key: 'vmax',
      label: `vmax (${voltageUnit})`,
      title: `Upper voltage limit this bus is judged on: the one the case sets, or ${DEFAULT_VOLTAGE_LIMITS.vmax} pu if it sets none${inKv}`,
      minWidth: 96,
      numeric: true,
      format: formatParamValue,
      accessor: (r) => r.vmax,
      edit: { param: 'vmax', toParam: (shown, row) => shown / row.toShown },
    },
    {
      key: 'limit_check',
      label: 'Limit check',
      title: `Where V stands against this bus's own vmin and vmax: within them, near one (inside ${VOLTAGE_WARNING_MARGIN} pu of it) or beyond one. Filled in once a power flow has run.`,
      minWidth: 112,
      accessor: (r) => r.limit_check,
    },
    {
      key: 'theta',
      label: 'θ (°)',
      title: 'Voltage angle in degrees',
      minWidth: 80,
      numeric: true,
      accessor: (r) => r.theta,
    },
    { key: 'p_inj', label: 'P (MW)', minWidth: 84, numeric: true, accessor: (r) => r.p_inj },
    { key: 'q_inj', label: 'Q (MVAr)', minWidth: 92, numeric: true, accessor: (r) => r.q_inj },
    {
      key: 'area',
      label: 'area',
      minWidth: 64,
      accessor: (r) => r.area,
      edit: { param: 'area' },
    },
    {
      key: 'zone',
      label: 'zone',
      minWidth: 64,
      accessor: (r) => r.zone,
      edit: { param: 'zone' },
    },
  ];
}

/**
 * A limit typed in kV is turned to per unit on the rated voltage the row held when the
 * cell was edited. A batch that also gives the bus a new ``Vn`` (a row pasted back
 * from a spreadsheet) means the new one, so the limits are redone on it and land at
 * the kV that were typed.
 */
function settleLimits(row: BusRow, params: Record<string, ParamValue>): Record<string, ParamValue> {
  const vn = params.Vn;
  if (row.toShown === 1 || typeof vn !== 'number' || !(vn > 0)) return params;
  const settled = { ...params };
  for (const key of ['vmin', 'vmax']) {
    const pu = params[key];
    // Twelve digits drop the rounding the two divisions add.
    if (typeof pu === 'number') settled[key] = Number(((pu * row.toShown) / vn).toPrecision(12));
  }
  return settled;
}

const EDIT_TARGET: GridEditTarget<BusRow> = {
  model: () => 'Bus',
  idx: (r) => r.idx,
  settle: settleLimits,
};

export interface BusesGridProps {
  className?: string;
}

export function BusesGrid({ className }: BusesGridProps) {
  const topology = useCurrentTopology();
  const pflow = usePflowStore((s) => s.lastRun);
  const setSelectedNodeId = useSldStore((s) => s.setSelectedNodeId);
  const selectedNodeId = useSldStore((s) => s.selectedNodeId);
  const setSelectedElement = useCaseStore((s) => s.setSelectedElement);
  const unitMode = useUnitsStore((s) => s.mode);

  // kV needs every bus's rated voltage: a column cannot read in two units.
  const bases = useMemo(() => unitBasesOf(topology), [topology]);
  const voltageUnit: DisplayUnit =
    unitMode === 'actual' &&
    topology !== null &&
    topology.buses.length > 0 &&
    topology.buses.every((bus) => busBaseKv(bases, bus.idx) !== null)
      ? 'kV'
      : 'pu';
  const columns = useMemo(() => columnsFor(voltageUnit), [voltageUnit]);
  const editing = useGridEditing(EDIT_TARGET);

  const rows = useMemo<BusRow[]>(() => {
    if (!topology) return [];
    const injections = computeBusInjections(pflow);
    return topology.buses.map((bus) => {
      const idx = String(bus.idx);
      const v = pflow?.converged ? (pflow.bus_voltages[idx] ?? null) : null;
      const theta = pflow?.converged ? (pflow.bus_angles[idx] ?? null) : null;
      // Net injection from the per-device PF maps (Σ gen − Σ load at
      // this bus). ``null`` (→ "—") when no generator/load attaches
      // here or PF hasn't converged yet.
      const inj = injections.get(idx) ?? null;
      const volts = typeof v === 'number' && Number.isFinite(v) ? v : null;
      const limits = busVoltageLimits(bus);
      // The verdict is judged in pu; only what is shown changes unit.
      const toShown = voltageUnit === 'kV' ? (busBaseKv(bases, bus.idx) ?? 1) : 1;
      return {
        idx,
        name: bus.name,
        vn: paramNumber(bus, 'Vn'),
        toShown,
        v: volts === null ? null : volts * toShown,
        vmin: limits.vmin * toShown,
        vmax: limits.vmax * toShown,
        limit_check: volts === null ? null : voltageStatusText(assessVoltage(volts, limits)),
        theta: typeof theta === 'number' && Number.isFinite(theta) ? radToDeg(theta) : null,
        p_inj: inj !== null && Number.isFinite(inj.p) ? inj.p : null,
        q_inj: inj !== null && Number.isFinite(inj.q) ? inj.q : null,
        area: paramString(bus, 'area'),
        zone: paramString(bus, 'zone'),
      };
    });
  }, [topology, pflow, voltageUnit, bases]);

  const onRowClick = (id: string) => {
    setSelectedNodeId(id);
    setSelectedElement({ kind: 'bus', idx: id });
  };

  return (
    <DataGrid
      columns={columns}
      rows={rows}
      rowIdAccessor={(r) => r.idx}
      onRowClick={onRowClick}
      selectedRowId={selectedNodeId}
      emptyState={topology ? 'No buses in this case.' : 'Load a case to see buses.'}
      testId="buses-grid"
      ariaLabel="Buses"
      exportPanel="buses"
      filterable
      copyable
      editing={editing}
      className={className}
    />
  );
}
