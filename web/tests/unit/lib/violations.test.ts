/**
 * collectViolations: the one list of what a solved power flow breaks or nears
 * (bus voltage, line loading, generator reactive power), its order, its counts
 * and what it leaves out.
 */
import { describe, expect, it } from 'vitest';
import { collectViolations, summarizeViolations, type ViolationReport } from '@/lib/violations';
import { LIMITS_TOPOLOGY, limitsPflow } from '../helpers/limitsCase';
import { lineFlow } from '../helpers/lineFlow';

function report(overrides: Parameters<typeof limitsPflow>[0] = {}): ViolationReport {
  const result = collectViolations(limitsPflow(overrides), LIMITS_TOPOLOGY);
  if (result === null) throw new Error('expected a report');
  return result;
}

describe('collectViolations', () => {
  it('has nothing to check without a converged result or a topology', () => {
    expect(collectViolations(null, LIMITS_TOPOLOGY)).toBeNull();
    expect(collectViolations(limitsPflow({ converged: false }), LIMITS_TOPOLOGY)).toBeNull();
    expect(collectViolations(limitsPflow(), null)).toBeNull();
  });

  it('lists violations before warnings, and each kind together, buses then lines then generators', () => {
    const items = report().items;
    expect(items.map((i) => `${i.severity}:${i.id}`)).toEqual([
      'violation:bus-1',
      'violation:transformer-T1',
      'violation:line-L1',
      'violation:generator-1',
      'warning:bus-2',
      'warning:line-L2',
      'warning:generator-2',
    ]);
  });

  it('counts the violations and the warnings, and what it checked', () => {
    const r = report();
    expect(r.violationCount).toBe(4);
    expect(r.warningCount).toBe(3);
    expect(r.checked).toEqual({ buses: 3, lines: 3, generators: 2 });
    // L3 has no rating: it is not checked, and the report says how many.
    expect(r.unratedLines).toBe(1);
  });

  it('orders the worst of a kind first', () => {
    const r = report();
    const lines = r.items.filter((i) => i.kind === 'line-loading' && i.severity === 'violation');
    expect(lines.map((i) => i.idx)).toEqual(['T1', 'L1']); // 130% before 112.4%
  });

  it('judges a bus against its own limits and says which one it is past', () => {
    const bus1 = report().items.find((i) => i.id === 'bus-1')!;
    expect(bus1).toMatchObject({
      severity: 'violation',
      finding: 'Above vmax',
      value: 1.07,
      limit: 1.05,
      unit: 'pu',
      target: { kind: 'bus', idx: '1' },
      nodeId: '1',
      name: 'Bus1',
    });
    const bus2 = report().items.find((i) => i.id === 'bus-2')!;
    expect(bus2).toMatchObject({ severity: 'warning', finding: 'Near vmin', limit: 0.9 });
    // Bus 3 is in the clear.
    expect(report().items.some((i) => i.id === 'bus-3')).toBe(false);
  });

  it('judges a line by its loading and a transformer the same way', () => {
    const items = report().items;
    expect(items.find((i) => i.id === 'line-L1')).toMatchObject({
      severity: 'violation',
      finding: 'Over rating',
      value: 112.4,
      limit: 100,
      unit: '%',
      target: { kind: 'line', idx: 'L1' },
      nodeId: 'line-L1',
    });
    expect(items.find((i) => i.id === 'line-L2')).toMatchObject({
      severity: 'warning',
      finding: 'Near rating',
    });
    expect(items.find((i) => i.id === 'transformer-T1')).toMatchObject({
      severity: 'violation',
      target: { kind: 'transformer', idx: 'T1' },
    });
    expect(items.some((i) => i.id === 'line-L3')).toBe(false);
  });

  it('judges a generator by its reactive limits: past one is a violation, on one a warning', () => {
    const items = report().items;
    expect(items.find((i) => i.id === 'generator-1')).toMatchObject({
      severity: 'violation',
      finding: 'Above Qmax',
      value: 30,
      limit: 15,
      unit: 'MVAr',
      name: 'PV_1',
    });
    expect(items.find((i) => i.id === 'generator-2')).toMatchObject({
      severity: 'warning',
      finding: 'At Qmax',
      name: 'Slack_2',
    });
  });

  it('points a generator finding at the symbol of its unit, whether or not a machine names the generator', () => {
    const items = report().items;
    // GENROU_1 names PV 1 in `gen`: the diagram draws the two as one node,
    // under the idx of the generator. No machine names Slack 2.
    expect(items.find((i) => i.id === 'generator-1')?.nodeId).toBe('generator-1');
    expect(items.find((i) => i.id === 'generator-2')?.nodeId).toBe('generator-2');
  });

  it('finds a generator past its lower limit', () => {
    const r = report({
      generator_outputs: { '1': { p: 40, q: -60, v: 1.0, bus: 1, q_min: -40, q_max: 15 } },
    });
    expect(r.items.find((i) => i.id === 'generator-1')).toMatchObject({
      finding: 'Below Qmin',
      severity: 'violation',
      value: -60,
      limit: -40,
    });
  });

  it('skips a generator the server sends no limits for, such as one switched off', () => {
    const r = report({
      generator_outputs: { '1': { p: 0, q: 0, v: 1.0, bus: 1, q_min: null, q_max: null } },
    });
    expect(r.items.some((i) => i.kind === 'generator-q')).toBe(false);
    expect(r.checked.generators).toBe(0);
  });

  it('reports a case that holds every limit as such', () => {
    const r = report({
      bus_voltages: { '1': 1.0, '2': 1.0, '3': 1.0 },
      line_flows: { L1: lineFlow(10, 1, { from: 1, to: 2 }, { rate_a: 100, loading_pct: 10 }) },
      generator_outputs: { '1': { p: 40, q: 5, v: 1.0, bus: 1, q_min: -40, q_max: 15 } },
    });
    expect(r.items).toEqual([]);
    expect(r.violationCount).toBe(0);
    expect(r.warningCount).toBe(0);
    expect(summarizeViolations(r)).toBe('No limit is violated');
  });

  it('does not count a line it has no flow for', () => {
    const r = report({ line_flows: {} });
    expect(r.checked.lines).toBe(0);
    expect(r.unratedLines).toBe(0);
  });
});

describe('summarizeViolations', () => {
  it('says how many violations and warnings there are', () => {
    expect(summarizeViolations(report())).toBe('4 violations and 3 warnings');
    expect(summarizeViolations({ ...report(), violationCount: 1, warningCount: 1 })).toBe(
      '1 violation and 1 warning',
    );
    expect(summarizeViolations({ ...report(), violationCount: 2, warningCount: 0 })).toBe(
      '2 violations',
    );
    expect(summarizeViolations({ ...report(), violationCount: 0, warningCount: 1 })).toBe(
      '1 warning',
    );
  });
});
