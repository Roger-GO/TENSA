/**
 * What the COMTRADE export sends the substrate: which columns of the run, in
 * which unit, under which names, and when it refuses to send at all. The record
 * itself is written (and tested) on the server.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_COMTRADE_VALUES,
  comtradeFileName,
  comtradeRequest,
  simulatedUnit,
} from '@/lib/comtrade';
import { ExportRefusedError } from '@/components/export/exportError';
import { useRunsStore } from '@/store/runs';
import type { RunRecord } from '@/store/runs';
import type { UnitBases } from '@/lib/units';

interface SeedOptions {
  runId?: string;
  bases?: UnitBases;
  scenario?: string;
  caseName?: string;
}

function seed(
  columns: Record<string, number[]>,
  t: number[],
  options: SeedOptions = {},
): RunRecord {
  const runId = options.runId ?? '1a2b3c4d5e6f';
  useRunsStore.getState().startRun({
    runId,
    tf: 10,
    columnNames: Object.keys(columns),
    ...(options.bases === undefined ? {} : { bases: options.bases }),
    ...(options.scenario === undefined ? {} : { scenario: options.scenario }),
    ...(options.caseName === undefined ? {} : { caseName: options.caseName }),
  });
  if (t.length > 0) {
    useRunsStore.getState().appendFrame(runId, {
      t: new Float64Array(t),
      columns: Object.fromEntries(
        Object.entries(columns).map(([name, values]) => [name, new Float64Array(values)]),
      ),
    });
  }
  return useRunsStore.getState().runs[runId]!;
}

beforeEach(() => {
  useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set(), runCount: 0 });
});

describe('simulatedUnit', () => {
  it('is the unit the run streams each quantity in', () => {
    expect(simulatedUnit('Bus_5_v')).toBe('pu');
    expect(simulatedUnit('Bus_5_a')).toBe('rad');
    expect(simulatedUnit('Gen_GENROU_1_omega')).toBe('pu');
    expect(simulatedUnit('Gen_GENROU_1_delta')).toBe('rad');
    expect(simulatedUnit('Gen_1_Pe')).toBe('MW');
    expect(simulatedUnit('Gen_1_Qe')).toBe('MVAr');
    expect(simulatedUnit('Line_Line_3_p')).toBe('MW');
    expect(simulatedUnit('Line_Line_3_q')).toBe('MVAr');
    expect(simulatedUnit('Load_PQ_2_p')).toBe('MW');
    expect(simulatedUnit('Load_PQ_2_q')).toBe('MVAr');
  });

  it('is unknown for an ANDES variable recorded by name, and for a column of no known shape', () => {
    expect(simulatedUnit('omega GENROU 1')).toBeUndefined();
    expect(simulatedUnit('mystery')).toBeUndefined();
  });
});

describe('comtradeFileName', () => {
  it("is the run's case and the start of its id", () => {
    expect(comtradeFileName({ runId: '1a2b3c4d5e6f7a8b', caseName: 'ieee14_full' })).toBe(
      'ieee14_full_1a2b3c4d',
    );
  });

  it('stands in for a run that has no case name', () => {
    expect(comtradeFileName({ runId: '1a2b3c4d5e6f' })).toBe('tds_1a2b3c4d');
  });

  it('is a name the substrate takes, whatever the case file is called', () => {
    // Letters, digits, ``.``, ``_`` and ``-``, a letter or digit first, 64 at most.
    const rule = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
    for (const caseName of [
      'My Case (v2)',
      '_private',
      '--',
      'Ñuñoa 220 kV',
      'c'.repeat(120),
      '../../etc/passwd',
      '',
    ]) {
      expect(comtradeFileName({ runId: '1a2b3c4d5e6f', caseName })).toMatch(rule);
    }
    expect(comtradeFileName({ runId: '1a2b3c4d', caseName: 'My Case (v2)' })).toBe(
      'My-Case-v2_1a2b3c4d',
    );
    expect(comtradeFileName({ runId: '1a2b3c4d', caseName: '_private' })).toBe('private_1a2b3c4d');
    expect(comtradeFileName({ runId: '1a2b3c4d', caseName: 'c'.repeat(120) })).toHaveLength(64);
  });
});

describe('comtradeRequest', () => {
  it("sends the named columns in the run's order, each with the unit it is streamed in", () => {
    const run = seed(
      {
        Bus_1_v: [1, 0.9, 1.01],
        Bus_1_a: [0, 0.1, 0.2],
        Gen_1_Pe: [80, 85, 82],
        'omega GENROU 1': [1, 1.001, 1],
      },
      [0, 0.5, 1],
    );

    const request = comtradeRequest(run, ['omega GENROU 1', 'Gen_1_Pe', 'Bus_1_v', 'Bus_9_v']);

    expect(request?.t).toEqual([0, 0.5, 1]);
    expect(request?.channels).toEqual([
      { name: 'Bus_1_v', unit: 'pu', values: [1, 0.9, 1.01] },
      { name: 'Gen_1_Pe', unit: 'MW', values: [80, 85, 82] },
      // No unit is sent for an ANDES variable: the run does not carry one.
      { name: 'omega GENROU 1', values: [1, 1.001, 1] },
    ]);
  });

  it('covers the rows the run has and not the over-allocated typed arrays', () => {
    const run = seed({ Bus_1_v: [1, 0.9, 0.8] }, [0, 1, 2]);
    expect(run.t.length).toBeGreaterThan(3);

    const request = comtradeRequest(run, ['Bus_1_v']);

    expect(request?.t).toHaveLength(3);
    expect(request?.channels[0]?.values).toEqual([1, 0.9, 0.8]);
  });

  it('names the record for the case and the run it is of', () => {
    const run = seed({ Bus_1_v: [1, 1] }, [0, 1], {
      runId: 'feedc0de12345678',
      caseName: 'kundur_full',
      scenario: 'fault bus 7',
      bases: { busKv: {}, freqHz: 50 },
    });

    const request = comtradeRequest(run, run.columnNames);

    expect(request).toMatchObject({
      name: 'kundur_full_feedc0de',
      station: 'kundur_full',
      device: 'TENSA TDS #1 - fault bus 7',
      frequency_hz: 50,
    });
  });

  it("uses the name the user gave the run, and ANDES's 60 Hz where the run has no frequency", () => {
    const run = seed({ Bus_1_v: [1, 1] }, [0, 1], { bases: { busKv: {}, freqHz: null } });
    const request = comtradeRequest({ ...run, displayName: 'base case' }, ['Bus_1_v']);

    expect(request).toMatchObject({
      name: 'tds_1a2b3c4d',
      // A run that kept no case name leaves the station blank: it is not
      // known to be of the case that is open now.
      station: '',
      device: 'TENSA base case',
      frequency_hz: 60,
    });
  });

  it('cuts a name longer than the route takes, of which the record holds 64 characters anyway', () => {
    const long = 'x'.repeat(300);
    const run = seed({ [`${long} GENROU 1`]: [1, 1] }, [0, 1], { caseName: long });

    const request = comtradeRequest({ ...run, displayName: long }, run.columnNames);

    expect(request?.station).toHaveLength(200);
    expect(request?.device).toHaveLength(200);
    expect(request?.channels[0]?.name).toHaveLength(200);
    expect(request?.name).toHaveLength(64);
  });

  it("dates the record when the run started, by this machine's clock and with no zone", () => {
    const run = seed({ Bus_1_v: [1, 1] }, [0, 1]);
    const started = new Date(2026, 9, 5, 14, 3, 22, 7);

    const request = comtradeRequest({ ...run, startedAt: started.getTime() }, ['Bus_1_v']);

    expect(request?.start_time).toBe('2026-10-05T14:03:22.007');
  });

  it('sends a value that is not a number as null, which the route takes as missing', () => {
    const run = seed({ Bus_1_v: [1, Number.NaN, Number.POSITIVE_INFINITY, 0.8] }, [0, 1, 2, 3]);

    const sent = JSON.parse(JSON.stringify(comtradeRequest(run, ['Bus_1_v']))) as {
      channels: { values: (number | null)[] }[];
    };

    expect(sent.channels[0]?.values).toEqual([1, null, null, 0.8]);
  });

  it('is nothing for a run with no rows yet, or when none of the names is a column of it', () => {
    expect(comtradeRequest(seed({ Bus_1_v: [] }, []), ['Bus_1_v'])).toBeNull();
    const run = seed({ Bus_1_v: [1, 1] }, [0, 1], { runId: 'other' });
    expect(comtradeRequest(run, [])).toBeNull();
    expect(comtradeRequest(run, ['Bus_2_v'])).toBeNull();
  });

  it('refuses more values than one export takes, and says what to do about it', () => {
    // Stands in for a long run of a large case without allocating one: the
    // limit is on columns times rows.
    const run = seed({ Bus_1_v: [1, 1], Bus_2_v: [1, 1], Bus_3_v: [1, 1] }, [0, 1]);
    const long: RunRecord = { ...run, seqCount: MAX_COMTRADE_VALUES / 2 };

    expect(() => comtradeRequest(long, ['Bus_1_v', 'Bus_2_v', 'Bus_3_v'])).toThrow(
      ExportRefusedError,
    );
    expect(() => comtradeRequest(long, ['Bus_1_v', 'Bus_2_v', 'Bus_3_v'])).toThrow(
      /3 variables of 2,500,000 samples are 7,500,000 values.*at most 5,000,000.*Export plot/,
    );
  });
});
