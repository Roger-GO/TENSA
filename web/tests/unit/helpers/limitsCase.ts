import { parseRunId } from '@/api/types';
import type { PflowResult, TopologySummary } from '@/api/types';
import { lineFlow } from './lineFlow';

/**
 * A small solved case that breaks or nears one limit of each kind, for the
 * tests of the Violations table, its count and the notice after a run.
 *
 * Violations: bus 1 above its vmax (1.07 against 1.05), line L1 at 112.4% of
 * its rating, transformer T1 at 130%, generator PV 1 at 30 MVAr against a
 * qmax of 15. Warnings: bus 2 near its vmin (0.915 against 0.9, inside the
 * 0.02 margin), line L2 at 85%, generator Slack 2 on its qmax. Fine: bus 3,
 * and line L3, which has no rating.
 */
export const LIMITS_TOPOLOGY: TopologySummary = {
  state: 'committed',
  buses: [
    { idx: 1, name: 'Bus1', kind: 'Bus', params: { vmin: 0.95, vmax: 1.05, Vn: 110 } },
    { idx: 2, name: 'Bus2', kind: 'Bus', params: { vmin: 0.9, vmax: 1.1, Vn: 110 } },
    { idx: 3, name: 'Bus3', kind: 'Bus', params: { vmin: 0.9, vmax: 1.1, Vn: 110 } },
  ],
  lines: [
    { idx: 'L1', name: 'Line1-2', kind: 'Line', params: { bus1: 1, bus2: 2 } },
    { idx: 'L2', name: 'Line2-3', kind: 'Line', params: { bus1: 2, bus2: 3 } },
    { idx: 'L3', name: 'Line1-3', kind: 'Line', params: { bus1: 1, bus2: 3 } },
  ],
  transformers: [{ idx: 'T1', name: 'Trafo1', kind: 'Line', params: { bus1: 1, bus2: 3 } }],
  generators: [
    { idx: 1, name: 'PV_1', kind: 'PV', params: { bus: 1 } },
    { idx: 2, name: 'Slack_2', kind: 'Slack', params: { bus: 2 } },
    { idx: 'GENROU_1', name: 'GENROU_1', kind: 'GENROU', params: { bus: 1, gen: 1 } },
  ],
  loads: [],
};

export function limitsPflow(overrides: Partial<PflowResult> = {}): PflowResult {
  return {
    run_id: parseRunId('run-limits'),
    converged: true,
    iterations: 4,
    mismatch: 1e-7,
    bus_voltages: { '1': 1.07, '2': 0.915, '3': 1.0 },
    bus_angles: { '1': 0, '2': -0.05, '3': -0.04 },
    line_flows: {
      L1: lineFlow(112.4, 10, { from: 1, to: 2 }, { rate_a: 100, loading_pct: 112.4 }),
      L2: lineFlow(85, 5, { from: 2, to: 3 }, { rate_a: 100, loading_pct: 85 }),
      L3: lineFlow(20, 2, { from: 1, to: 3 }),
      T1: lineFlow(26, 2, { from: 1, to: 3 }, { rate_a: 20, loading_pct: 130 }),
    },
    generator_outputs: {
      '1': { p: 40, q: 30, v: 1.07, bus: 1, q_min: -40, q_max: 15 },
      '2': { p: 10, q: 15, v: 0.915, bus: 2, q_min: -50, q_max: 15 },
    },
    load_consumption: {},
    ...overrides,
  };
}
