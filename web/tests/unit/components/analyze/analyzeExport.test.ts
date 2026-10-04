/**
 * Tests for the Analyze panel's CSV builders: the file each result becomes,
 * checked line by line.
 */
import { describe, expect, it } from 'vitest';
import {
  cpfResultToCsv,
  eigResultToCsv,
  participationToCsv,
  seResidualsToCsv,
} from '@/components/analyze/analyzeExport';
import { readBlob } from '../../helpers/downloads';
import type { CpfResult, EigResult, SeResult } from '@/api/types';

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
});
