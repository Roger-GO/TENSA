/**
 * The difference between two solved power flows: what `comparePflow` subtracts,
 * how it orders the rows, how it treats an element only one result has, and the
 * tables and the headline made from it.
 */
import { describe, expect, it } from 'vitest';
import { parseRunId } from '@/api/types';
import type { PflowResult, PflowSummary } from '@/api/types';
import { elementNamesOf, NO_ELEMENT_NAMES, type ElementNames } from '@/lib/elementNames';
import {
  comparePflow,
  comparisonCellText,
  comparisonHeadline,
  comparisonTables,
  signed,
  wrapDegrees,
  type PflowSide,
} from '@/lib/pflowCompare';
import { RAD_TO_DEG } from '@/lib/units';
import { LIMITS_TOPOLOGY } from '../helpers/limitsCase';
import { lineFlow } from '../helpers/lineFlow';

const NAMES: ElementNames = {
  buses: { '1': 'North', '2': 'South', '3': 'East' },
  lines: { L1: 'North-South', L2: 'South-East' },
  generators: { G1: 'Hydro' },
  loads: { D1: 'Town' },
};

const SUMMARY: PflowSummary = {
  generation_p: 100,
  generation_q: 20,
  load_p: 98,
  load_q: 25,
  shunt_p: 0,
  shunt_q: -8,
  loss_p: 2,
  loss_q: 3,
  slack_p: 100,
  slack_q: 20,
};

function result(overrides: Partial<PflowResult> = {}): PflowResult {
  return {
    run_id: parseRunId('run-a'),
    converged: true,
    iterations: 3,
    mismatch: 1e-9,
    bus_voltages: { '1': 1.0, '2': 0.98, '3': 0.97 },
    bus_angles: { '1': 0, '2': -0.02, '3': -0.05 },
    line_flows: {
      L1: lineFlow(60, 10, { from: 1, to: 2 }, { p_to: -59, q_to: -9, loss: 1 }),
      L2: lineFlow(
        40,
        5,
        { from: 2, to: 3 },
        { p_to: -39, q_to: -4, loss: 1, rate_a: 50, loading_pct: 80.6 },
      ),
    },
    generator_outputs: { G1: { p: 100, q: 20, v: 1.0, bus: 1 } },
    load_consumption: { D1: { p: 98, q: 25, bus: 3 } },
    summary: SUMMARY,
    ...overrides,
  };
}

function side(overrides: Partial<PflowResult> = {}, names: ElementNames = NAMES): PflowSide {
  return { result: result(overrides), names };
}

describe('wrapDegrees', () => {
  it('leaves a difference inside -180..180 alone', () => {
    expect(wrapDegrees(12.5)).toBe(12.5);
    expect(wrapDegrees(-90)).toBe(-90);
  });

  it('brings a difference across the 180 degree line back', () => {
    // 170 minus -170 is 340 the long way round and -20 the short way.
    expect(wrapDegrees(340)).toBeCloseTo(-20, 9);
    expect(wrapDegrees(-340)).toBeCloseTo(20, 9);
  });

  it('keeps the sign of a half turn', () => {
    expect(wrapDegrees(180)).toBe(180);
    expect(wrapDegrees(-180)).toBe(-180);
  });
});

describe('comparePflow', () => {
  it('subtracts A from B: voltage in pu, angle in degrees', () => {
    const cmp = comparePflow(
      side(),
      side({
        bus_voltages: { '1': 1.0, '2': 0.95, '3': 0.97 },
        bus_angles: { '1': 0, '2': -0.03, '3': -0.05 },
      }),
    );
    const south = cmp.buses.find((b) => b.idx === '2')!;
    expect(south.name).toBe('South');
    expect(south.vA).toBe(0.98);
    expect(south.vB).toBe(0.95);
    expect(south.dV).toBeCloseTo(-0.03, 12);
    expect(south.angleA).toBeCloseTo(-0.02 * RAD_TO_DEG, 12);
    expect(south.dAngle).toBeCloseTo(-0.01 * RAD_TO_DEG, 12);
    expect(south.onlyIn).toBeNull();
  });

  it('subtracts the line flows at both ends, the loss and the loading', () => {
    const cmp = comparePflow(
      side(),
      side({
        line_flows: {
          L1: lineFlow(70, 12, { from: 1, to: 2 }, { p_to: -68.5, q_to: -10, loss: 1.5 }),
          L2: lineFlow(
            45,
            5,
            { from: 2, to: 3 },
            { p_to: -43.8, q_to: -4, loss: 1.2, rate_a: 50, loading_pct: 90.6 },
          ),
        },
      }),
    );
    const l1 = cmp.lines.find((l) => l.idx === 'L1')!;
    expect(l1.name).toBe('North-South');
    expect([l1.fromIdx, l1.toIdx]).toEqual(['1', '2']);
    expect(l1.dP).toBeCloseTo(10, 12);
    expect(l1.dQ).toBeCloseTo(2, 12);
    expect(l1.dPTo).toBeCloseTo(-9.5, 12);
    expect(l1.dQTo).toBeCloseTo(-1, 12);
    expect(l1.dLoss).toBeCloseTo(0.5, 12);
    // No rating, so no loading on either side and no change of it.
    expect(l1.loadingA).toBeNull();
    expect(l1.dLoading).toBeNull();
    const l2 = cmp.lines.find((l) => l.idx === 'L2')!;
    expect(l2.dLoading).toBeCloseTo(10, 9);
  });

  it('subtracts the generator outputs, the load draws and the system totals', () => {
    const cmp = comparePflow(
      side(),
      side({
        generator_outputs: { G1: { p: 110, q: 18, v: 1.0, bus: 1 } },
        load_consumption: { D1: { p: 107, q: 25, bus: 3 } },
        summary: { ...SUMMARY, generation_p: 110, generation_q: 18, load_p: 107, loss_p: 3 },
      }),
    );
    expect(cmp.generators[0]).toMatchObject({ idx: 'G1', name: 'Hydro', bus: '1', dP: 10, dQ: -2 });
    expect(cmp.loads[0]).toMatchObject({ idx: 'D1', name: 'Town', bus: '3', dP: 9, dQ: 0 });
    const totals = Object.fromEntries(cmp.totals.map((t) => [t.id, t]));
    expect(totals.generation).toMatchObject({ pA: 100, pB: 110, dP: 10, dQ: -2 });
    expect(totals.load?.dP).toBe(9);
    expect(totals.loss?.dP).toBe(1);
  });

  it('has no totals when one result carries no system summary', () => {
    const cmp = comparePflow(side(), side({ summary: null }));
    expect(cmp.totals).toEqual([]);
  });

  it('puts the largest change first and keeps the order of B for equal changes', () => {
    const cmp = comparePflow(
      side(),
      side({
        bus_voltages: { '1': 1.0, '2': 0.979, '3': 0.92 },
      }),
    );
    expect(cmp.buses.map((b) => b.idx)).toEqual(['3', '2', '1']);

    const same = comparePflow(side(), side());
    expect(same.buses.map((b) => b.idx)).toEqual(['1', '2', '3']);
    expect(same.lines.map((l) => l.idx)).toEqual(['L1', 'L2']);
  });

  it('orders by the angle when the voltages moved by the same amount', () => {
    const cmp = comparePflow(side(), side({ bus_angles: { '1': 0, '2': -0.02, '3': -0.09 } }));
    expect(cmp.buses[0]?.idx).toBe('3');
  });

  it('lists an element only one result has, with no difference, ahead of the rest', () => {
    const cmp = comparePflow(
      side(),
      side(
        {
          bus_voltages: { '1': 1.0, '2': 0.98, '4': 1.01 },
          bus_angles: { '1': 0, '2': -0.02, '4': -0.01 },
          line_flows: {
            L1: lineFlow(60, 10, { from: 1, to: 2 }, { p_to: -59, q_to: -9, loss: 1 }),
          },
        },
        { ...NAMES, buses: { '1': 'North', '2': 'South', '4': 'West' } },
      ),
    );
    expect(cmp.buses.slice(0, 2).map((b) => [b.idx, b.onlyIn, b.name])).toEqual([
      ['4', 'B', 'West'],
      ['3', 'A', 'East'],
    ]);
    expect(cmp.buses[0]).toMatchObject({ vA: null, vB: 1.01, dV: null, dAngle: null });
    expect(cmp.lines.find((l) => l.idx === 'L2')).toMatchObject({
      onlyIn: 'A',
      pA: 40,
      pB: null,
      dP: null,
      fromIdx: '2',
      toIdx: '3',
    });
    expect(cmp.unmatched).toBe(3);
    expect(cmp.identical).toBe(false);
  });

  it('names where each quantity changed most, with the signed change', () => {
    const cmp = comparePflow(
      side(),
      side({
        bus_voltages: { '1': 1.0, '2': 0.95, '3': 0.975 },
        bus_angles: { '1': 0, '2': -0.02, '3': -0.08 },
        line_flows: {
          L1: lineFlow(48, 10, { from: 1, to: 2 }, { p_to: -47, q_to: -9, loss: 1 }),
          L2: lineFlow(
            41,
            5,
            { from: 2, to: 3 },
            { p_to: -40, q_to: -4, loss: 1, rate_a: 50, loading_pct: 82.6 },
          ),
        },
      }),
    );
    expect(cmp.maxDV).toMatchObject({ idx: '2', name: 'South' });
    expect(cmp.maxDV?.value).toBeCloseTo(-0.03, 12);
    expect(cmp.maxDAngle?.idx).toBe('3');
    expect(cmp.maxDP).toMatchObject({ idx: 'L1', value: -12 });
  });

  it('says two equal results are identical, and one that moved is not', () => {
    expect(comparePflow(side(), side()).identical).toBe(true);
    expect(
      comparePflow(side(), side({ bus_voltages: { '1': 1.0, '2': 0.98, '3': 0.9701 } })).identical,
    ).toBe(false);
    // The to end of a line is part of the result too.
    expect(
      comparePflow(
        side(),
        side({
          line_flows: {
            ...result().line_flows,
            L1: lineFlow(60, 10, { from: 1, to: 2 }, { p_to: -59, q_to: -9.5, loss: 1 }),
          },
        }),
      ).identical,
    ).toBe(false);
  });

  it('falls back to the idx for an element with no name on either side', () => {
    const cmp = comparePflow(side({}, NO_ELEMENT_NAMES), side({}, NO_ELEMENT_NAMES));
    expect(cmp.buses[0]?.name).toBe('1');
    expect(cmp.lines[0]?.name).toBe('L1');
  });
});

describe('comparisonTables', () => {
  it('gives one table per kind of element and one of the totals, with the same rows', () => {
    const cmp = comparePflow(side(), side({ bus_voltages: { '1': 1.0, '2': 0.95, '3': 0.97 } }));
    const tables = comparisonTables(cmp);
    expect(tables.map((t) => t.id)).toEqual(['buses', 'lines', 'generators', 'loads', 'totals']);
    const buses = tables[0]!;
    expect(buses.columns.map((c) => c.key)).toEqual([
      'idx',
      'name',
      'vA',
      'vB',
      'dV',
      'angleA',
      'angleB',
      'dAngle',
    ]);
    expect(buses.rows[0]?.id).toBe('2');
    expect(buses.rows[0]?.cells.slice(0, 4)).toEqual(['2', 'South', 0.98, 0.95]);
    for (const table of tables) {
      for (const row of table.rows) expect(row.cells).toHaveLength(table.columns.length);
    }
  });

  it('adds the "only in" column only when some element is in one result only', () => {
    const matched = comparisonTables(comparePflow(side(), side()));
    expect(matched[0]!.columns.some((c) => c.key === 'onlyIn')).toBe(false);

    const cmp = comparePflow(
      side(),
      side({ bus_voltages: { '1': 1.0, '2': 0.98 }, bus_angles: { '1': 0, '2': -0.02 } }),
    );
    const tables = comparisonTables(cmp);
    for (const table of tables.filter((t) => t.id !== 'totals')) {
      expect(table.columns.some((c) => c.key === 'onlyIn')).toBe(true);
      for (const row of table.rows) expect(row.cells).toHaveLength(table.columns.length);
    }
    const at = tables[0]!.columns.findIndex((c) => c.key === 'onlyIn');
    expect(tables[0]!.rows.find((r) => r.id === '3')?.cells[at]).toBe('A');
    expect(tables[0]!.rows.find((r) => r.id === '1')?.cells[at]).toBe('');
  });

  it('marks the differences, which read with their sign, apart from the values', () => {
    const tables = comparisonTables(comparePflow(side(), side()));
    for (const table of tables) {
      for (const column of table.columns) {
        expect(column.change, `${table.id}.${column.key}`).toBe(/^d[A-Z]/.test(column.key));
      }
    }
  });
});

describe('comparisonCellText and signed', () => {
  const [buses] = comparisonTables(comparePflow(side(), side()));
  const column = (key: string) => buses!.columns.find((c) => c.key === key)!;

  it('prints a value plainly and a difference with its sign', () => {
    expect(comparisonCellText(0.98, column('vA'))).toBe('0.9800');
    expect(comparisonCellText(0.0312, column('dV'))).toBe('+0.03120');
    expect(comparisonCellText(-0.0312, column('dV'))).toBe('-0.03120');
  });

  it('prints a difference that rounds to nothing as zero, without a sign', () => {
    expect(signed(-0.0000004, 5)).toBe('0.00000');
    expect(signed(0, 3)).toBe('0.000');
  });

  it('prints nothing for a value there is none of', () => {
    expect(comparisonCellText(null, column('dV'))).toBe('');
    expect(comparisonCellText(Number.NaN, column('vA'))).toBe('');
    expect(comparisonCellText('South', column('name'))).toBe('South');
  });
});

describe('comparisonHeadline', () => {
  it('says so when the two results are the same', () => {
    expect(comparisonHeadline(comparePflow(side(), side()))).toBe('The two results are the same.');
  });

  it('names the largest change of each kind and where it is', () => {
    const cmp = comparePflow(
      side(),
      side({
        bus_voltages: { '1': 1.0, '2': 0.95, '3': 0.97 },
        line_flows: {
          ...result().line_flows,
          L1: lineFlow(72, 10, { from: 1, to: 2 }, { p_to: -71, q_to: -9, loss: 1 }),
        },
      }),
    );
    expect(comparisonHeadline(cmp)).toBe(
      'Largest change: ΔV -0.0300 pu at South (2); ΔP +12.00 MW at North-South (L1).',
    );
  });

  it('counts the elements that are in one result only', () => {
    const cmp = comparePflow(
      side(),
      side({ bus_voltages: { '1': 1.0, '2': 0.98 }, bus_angles: { '1': 0, '2': -0.02 } }),
    );
    expect(comparisonHeadline(cmp)).toBe('1 element is in one of the two results only.');
  });
});

describe('elementNamesOf', () => {
  it('reads the names of what a power flow reports on from a topology', () => {
    const names = elementNamesOf(LIMITS_TOPOLOGY);
    expect(names.buses).toEqual({ '1': 'Bus1', '2': 'Bus2', '3': 'Bus3' });
    // The result keys lines and transformers alike.
    expect(names.lines).toEqual({ L1: 'Line1-2', L2: 'Line2-3', L3: 'Line1-3', T1: 'Trafo1' });
    // A dynamic machine has no row of its own in a power flow.
    expect(names.generators).toEqual({ '1': 'PV_1', '2': 'Slack_2' });
    expect(names.loads).toEqual({});
  });

  it('has no names without a topology', () => {
    expect(elementNamesOf(null)).toEqual(NO_ELEMENT_NAMES);
    expect(elementNamesOf(undefined)).toEqual(NO_ELEMENT_NAMES);
  });
});
