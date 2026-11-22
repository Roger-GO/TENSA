/**
 * Tests for the Analyze panel's CSV builders: the file each result becomes,
 * checked line by line.
 */
import { describe, expect, it } from 'vitest';
import {
  cpfGeneratorsToCsv,
  cpfResultToCsv,
  eigResultToCsv,
  eigSweepResultToCsv,
  participationToCsv,
  seResidualsToCsv,
} from '@/components/analyze/analyzeExport';
import { readBlob } from '../../helpers/downloads';
import type { CpfResult, EigResult, SeResult } from '@/api/types';
import type { EigSweepResponse } from '@/api/types';

describe('eigSweepResultToCsv', () => {
  const result: EigSweepResponse = {
    model: 'GENROU',
    idx: '1',
    param: 'M',
    points: [
      {
        value: 1,
        eigenvalues: [
          { real: -0.2, imag: 3 },
          { real: -1, imag: 0 },
        ],
        damping_ratios: [0.066, 1],
        frequencies_hz: [0.477, 0],
      },
      {
        value: 3,
        eigenvalues: [
          { real: 0.05, imag: 2.5 },
          { real: -0.9, imag: 0 },
        ],
        damping_ratios: [-0.02, 1],
        frequencies_hz: [0.398, 0],
      },
    ],
    mode_count: 2,
    tds_initialized: false,
    job_id: null,
  };

  it('writes one row per (point, mode) at full precision and names the run', async () => {
    const text = await readBlob(eigSweepResultToCsv(result));
    expect(text.split('\n')).toEqual([
      '# sweep of M of GENROU 1, 2 points, 2 modes per point',
      'point,value,mode,real,imag,damping_ratio,frequency_hz',
      '0,1,0,-0.2,3,0.066,0.477',
      '0,1,1,-1,0,1,0',
      '1,3,0,0.05,2.5,-0.02,0.398',
      '1,3,1,-0.9,0,1,0',
      '',
    ]);
  });
});

describe('eigResultToCsv', () => {
  const result: EigResult = {
    eigenvalues: [
      { real: -0.1, imag: 2.0 },
      { real: -0.5, imag: 0 },
      { real: 0.02, imag: -3.5 },
    ],
    damping_ratios: [0.0499, 1, -0.0057],
    frequencies_hz: [0.3183, 0, 0.557],
    mode_count: 3,
    state_count: 4,
    state_names: ['a', 'b', 'c', 'd'],
    tds_initialized: true,
  };

  it('writes every mode with its index, eigenvalue, damping and frequency', async () => {
    const text = await readBlob(eigResultToCsv(result));
    expect(text.split('\n')).toEqual([
      '# 3 modes, 4 states',
      'mode,real,imag,damping_ratio,frequency_hz',
      '0,-0.1,2,0.0499,0.3183',
      '1,-0.5,0,1,0',
      '2,0.02,-3.5,-0.0057,0.557',
      '',
    ]);
  });
});

describe('participationToCsv', () => {
  const rows = [
    { state_name: 'delta_1', factor: 0.92 },
    { state_name: 'omega_2', factor: -0.05 },
  ];

  it('writes the rows in the order given and names the mode', async () => {
    const text = await readBlob(participationToCsv(rows, 3, ''));
    expect(text.split('\n')).toEqual([
      '# participation factors of mode 3',
      'state,factor',
      'delta_1,0.92',
      'omega_2,-0.05',
      '',
    ]);
  });

  it('says so when a filter narrowed the rows', async () => {
    const text = await readBlob(participationToCsv(rows.slice(0, 1), 3, ' delta '));
    expect(text.split('\n')[1]).toBe('# filtered to states matching "delta"');
  });

  it('has no mode line when no mode is selected', async () => {
    const text = await readBlob(participationToCsv(rows, null, ''));
    expect(text.startsWith('state,factor\n')).toBe(true);
  });
});

describe('cpfResultToCsv', () => {
  const pv: CpfResult = {
    lambdas: [0, 0.5, 1],
    voltages_per_bus: { '1': [1.06, 1.05, 1.0], '2': [1.04, 1.02, 0.9] },
    bus_idxes: ['1', '2'],
    nose_idx: 2,
    max_lam: 1,
    truncated: false,
    done_msg: 'Nose point at lambda=1.000000',
    mode: 'pv',
  };

  it('writes lambda and the voltage of every bus at each step', async () => {
    const text = await readBlob(cpfResultToCsv(pv));
    expect(text.split('\n')).toEqual([
      '# CPF PV curve, bus voltages in pu',
      '# max lambda = 1',
      '# Nose point at lambda=1.000000',
      'lambda,bus_1_v,bus_2_v',
      '0,1.06,1.04',
      '0.5,1.05,1.02',
      '1,1,0.9',
      '',
    ]);
  });

  it('names the first column q_injection for a QV curve', async () => {
    const qv: CpfResult = {
      lambdas: [0, 2],
      voltages_per_bus: { '5': [1, 0.8] },
      bus_idxes: ['5'],
      nose_idx: 1,
      max_lam: 2,
      truncated: false,
      done_msg: '',
      mode: 'qv',
    };
    const lines = (await readBlob(cpfResultToCsv(qv))).split('\n');
    expect(lines[0]).toBe('# CPF QV curve, bus voltages in pu');
    expect(lines[1]).toBe('# max Q = 2');
    expect(lines[2]).toBe('q_injection,bus_5_v');
  });

  it('notes a truncated run', async () => {
    const text = await readBlob(
      cpfResultToCsv({ ...pv, truncated: true, nose_idx: -1, done_msg: 'Reached max steps (3)' }),
    );
    expect(text).toContain('# truncated: no nose point was reached\n# Reached max steps (3)\n');
  });

  it('leaves out a bus the run has no voltages for', async () => {
    const text = await readBlob(cpfResultToCsv({ ...pv, bus_idxes: ['1', '9', '2'] }));
    expect(text).toContain('\nlambda,bus_1_v,bus_2_v\n');
  });

  const withGenerators: CpfResult = {
    ...pv,
    direction: 'load-only',
    stop_at: 'nose',
    complete: true,
    q_limits_enforced: true,
    generators: [
      { idx: '2', model: 'PV', bus: '2', q: [10, 15, 15], q_min: -40, q_max: 15 },
      { idx: '1', model: 'Slack', bus: '1', q: [-5, 20, 100], q_min: null, q_max: 100 },
    ],
    limit_events: [
      { step: 1, lam: 0.5, idx: '2', model: 'PV', bus: '2', limit: 'qmax', at_nose: false },
      { step: 2, lam: 1, idx: '1', model: 'Slack', bus: '1', limit: 'qmax', at_nose: true },
    ],
  };

  it("adds each generator's reactive power, and says what the run was and found", async () => {
    const text = await readBlob(cpfResultToCsv(withGenerators));
    expect(text.split('\n')).toEqual([
      '# CPF PV curve, bus voltages in pu, generator reactive power in MVAr',
      '# max lambda = 1',
      '# Nose point at lambda=1.000000',
      '# direction: Loads only (lambda = 1 is twice the base load)',
      '# generator Q limits enforced along the path',
      '# PV 2 on bus 2 held at Qmax from step 1 (lambda = 0.5)',
      '# Slack 1 on bus 1 held at Qmax from step 2 (lambda = 1): the nose is where it reached the limit',
      'lambda,bus_1_v,bus_2_v,pv_2_q_mvar,slack_1_q_mvar',
      '0,1.06,1.04,10,-5',
      '0.5,1.05,1.02,15,20',
      '1,1,0.9,15,100',
      '',
    ]);
  });

  it('says where the lower branch starts, when one broke off, and where a generator would have left its limit', async () => {
    const text = await readBlob(
      cpfResultToCsv({
        ...withGenerators,
        lambdas: [0, 1, 0.5],
        nose_idx: 1,
        stop_at: 'full',
        complete: false,
        q_limits_enforced: false,
        limit_events: [
          {
            step: 0,
            lam: 0,
            idx: '2',
            model: 'PV',
            bus: '2',
            limit: 'qmin',
            at_nose: false,
            would_release_step: 1,
          },
        ],
      }),
    );
    expect(text).toContain('# generator Q limits not enforced along the path\n');
    expect(text).toContain(
      '# PV 2 on bus 2 held at Qmin from the start (held by the power flow); from step 1 its voltage is back across the set-point and a real exciter would leave the limit\n',
    );
    expect(text).toContain(
      '# full curve: steps 0 to 1 are the upper branch, the rest the lower branch\n',
    );
    expect(text).toContain('# the lower branch stops before it is back at the base load\n');
  });

  it('says a run to a target stopped there, or met the nose first, and calls neither truncated', async () => {
    const reached = await readBlob(
      cpfResultToCsv({
        ...pv,
        truncated: true,
        nose_idx: -1,
        complete: true,
        stop_at: 'nose',
        done_msg: 'Reached target lambda=1',
        stop_at_lambda: 1,
      }),
    );
    expect(reached).not.toContain('truncated');
    expect(reached).toContain(
      '# Reached target lambda=1\n# stopped at the target lambda = 1, as asked, before any nose\n',
    );

    const short = await readBlob(
      cpfResultToCsv({
        ...pv,
        complete: false,
        stop_at: 'nose',
        done_msg: 'Nose point at lambda=1.000000, short of the target lambda=3',
        stop_at_lambda: 3,
      }),
    );
    expect(short).toContain(
      '# the nose came before the target lambda = 3, and the run ended there\n',
    );
    expect(short).not.toContain('lower branch');
  });
});

describe('cpfGeneratorsToCsv', () => {
  const result: CpfResult = {
    lambdas: [0, 0.5],
    voltages_per_bus: { '1': [1.06, 1.05] },
    bus_idxes: ['1'],
    nose_idx: 1,
    max_lam: 0.5,
    truncated: false,
    done_msg: 'Nose point at lambda=0.500000',
    mode: 'pv',
    direction: 'load',
    q_limits_enforced: false,
    generators: [
      { idx: '2', model: 'PV', bus: '2', q: [10, 30], q_min: -40, q_max: 15 },
      { idx: '1', model: 'Slack', bus: '1', q: [-5, 20], q_min: null, q_max: 100 },
    ],
    limit_events: [],
  };

  it("writes each generator's reactive power per step, with its limits in the header", async () => {
    const blob = cpfGeneratorsToCsv(result);
    expect(blob).not.toBeNull();
    expect((await readBlob(blob!)).split('\n')).toEqual([
      '# CPF PV curve, generator reactive power in MVAr',
      '# direction: Loads and generation (lambda = 1 is twice the base load and PV generation)',
      '# generator Q limits not enforced along the path',
      '# PV 2 on bus 2: Qmin -40, Qmax 15 MVAr',
      '# Slack 1 on bus 1: Qmin none, Qmax 100 MVAr',
      'lambda,pv_2_q_mvar,slack_1_q_mvar',
      '0,10,-5',
      '0.5,30,20',
      '',
    ]);
  });

  it('names the axis of a QV curve and has nothing to write without generators', async () => {
    const qv = await readBlob(cpfGeneratorsToCsv({ ...result, mode: 'qv', direction: null })!);
    expect(qv).toContain('# CPF QV curve, generator reactive power in MVAr\n');
    expect(qv).toContain('\nq_injection,pv_2_q_mvar,slack_1_q_mvar\n');
    expect(qv).not.toContain('direction:');
    expect(cpfGeneratorsToCsv({ ...result, generators: [] })).toBeNull();
    expect(cpfGeneratorsToCsv({ ...result, generators: undefined })).toBeNull();
  });
});

describe('seResidualsToCsv', () => {
  it('writes each residual with whether it was flagged', async () => {
    const result: SeResult = {
      converged: true,
      iterations: 3,
      mismatch: 12.345,
      residuals: [0.01, -0.5, 0.02],
      measurement_count: 3,
      flagged_indices: [1],
    };
    const text = await readBlob(seResidualsToCsv(result));
    expect(text.split('\n')).toEqual([
      '# SE converged in 3 iterations, J = 12.345',
      'measurement,residual,flagged',
      '0,0.01,false',
      '1,-0.5,true',
      '2,0.02,false',
      '',
    ]);
  });

  it('says which estimator ran, with what, and what the bad-data test found', async () => {
    const base: SeResult = {
      converged: true,
      iterations: 4,
      mismatch: 31.5,
      residuals: [0.01],
      measurement_count: 1,
      flagged_indices: [],
    };
    const wls = await readBlob(
      seResidualsToCsv({
        ...base,
        algorithm: 'wls',
        settings: { tol: 0.0001, max_iter: 100, noise_seed: null },
        chi_squared: { passed: false, J: 31.5, threshold: 25.0, dof: 15, confidence: 0.95 },
      }),
    );
    expect(wls.split('\n').slice(0, 3)).toEqual([
      '# SE converged in 4 iterations, J = 31.5',
      '# Estimator: WLS, tol = 0.0001, max_iter = 100',
      '# Bad-data test (chi-squared, confidence 0.95): failed, J = 31.5, threshold = 25, 15 degrees of freedom',
    ]);
    const lav = await readBlob(
      seResidualsToCsv({
        ...base,
        algorithm: 'lav',
        settings: { tol: 0.0001, max_iter: 400, noise_seed: 7 },
        chi_squared: null,
      }),
    );
    expect(lav.split('\n').slice(1, 3)).toEqual([
      '# Estimator: LAV, tol = 0.0001, max_iter = 400, noise drawn for this run with seed 7',
      '# No bad-data test: it needs weighted least squares and more measurements than states.',
    ]);
  });
});
