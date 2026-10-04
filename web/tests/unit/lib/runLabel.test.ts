/**
 * Run labels: what the legend, the plot and the history list call a run.
 */
import { describe, expect, it } from 'vitest';
import type { AlterSpec, DisturbanceSpec, FaultSpec, ToggleSpec } from '@/api/types';
import { autoRunLabel, describeScenario, runLabel, shortRunId } from '@/lib/runLabel';

const fault = (bus_idx: string | number, tf = 1): FaultSpec => ({
  kind: 'fault',
  bus_idx,
  tf,
  tc: tf + 0.1,
  xf: 0.05,
  rf: 0,
});
const toggle = (dev_idx: string | number, t = 1): ToggleSpec => ({
  kind: 'toggle',
  model: 'Line',
  dev_idx,
  t,
});
const alter = (dev_idx: string | number, t = 1): AlterSpec => ({
  kind: 'alter',
  model: 'PQ',
  dev_idx,
  src: 'p0',
  t,
  method: '*',
  amount: 1.2,
});

describe('describeScenario', () => {
  it('is undefined when nothing is scheduled', () => {
    expect(describeScenario([])).toBeUndefined();
  });

  it('names a fault by its bus', () => {
    expect(describeScenario([fault(7)])).toBe('fault bus 7');
  });

  it('names a toggle by its model and device', () => {
    expect(describeScenario([toggle('Line_3')])).toBe('toggle Line Line_3');
  });

  it('names an alter by its model and device', () => {
    expect(describeScenario([alter(4)])).toBe('alter PQ 4');
  });

  it('shows a ? for an index that is blank', () => {
    expect(describeScenario([fault('')])).toBe('fault bus ?');
  });

  it('names the earliest disturbance and counts the rest', () => {
    const specs: DisturbanceSpec[] = [toggle('Line_3', 4), fault(7, 1), alter(2, 2)];
    expect(describeScenario(specs)).toBe('fault bus 7 +2 more');
  });

  it('keeps the order of two disturbances at the same time', () => {
    expect(describeScenario([fault(2, 1), fault(9, 1)])).toBe('fault bus 2 +1 more');
  });

  it('leaves the list it is given as it was', () => {
    const specs: DisturbanceSpec[] = [toggle('Line_3', 4), fault(7, 1)];
    describeScenario(specs);
    expect(specs.map((s) => s.kind)).toEqual(['toggle', 'fault']);
  });
});

describe('autoRunLabel', () => {
  it('numbers the run and says what it did', () => {
    expect(autoRunLabel({ runId: 'abcdef1234567890', ordinal: 3, scenario: 'fault bus 7' })).toBe(
      'TDS #3 - fault bus 7',
    );
  });

  it('is just the number for a run that scheduled nothing', () => {
    expect(autoRunLabel({ runId: 'abcdef1234567890', ordinal: 2 })).toBe('TDS #2');
  });

  it('falls back to the first characters of the id for a record with no number', () => {
    expect(autoRunLabel({ runId: 'abcdef1234567890' })).toBe('abcdef12');
    expect(autoRunLabel({ runId: 'r1' })).toBe('r1');
  });
});

describe('runLabel', () => {
  it('is the default label until the researcher names the run', () => {
    const run = { runId: 'r1', ordinal: 1, scenario: 'fault bus 7' };
    expect(runLabel(run)).toBe('TDS #1 - fault bus 7');
    expect(runLabel({ ...run, displayName: 'Baseline' })).toBe('Baseline');
  });
});

describe('shortRunId', () => {
  it('cuts a long id to 8 characters and leaves a short one alone', () => {
    expect(shortRunId('abcdef1234567890')).toBe('abcdef12');
    expect(shortRunId('abc')).toBe('abc');
    expect(shortRunId('abcdef1234567890', 12)).toBe('abcdef123456');
  });
});
