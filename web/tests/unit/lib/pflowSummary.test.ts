import { describe, expect, it } from 'vitest';
import { lossShare, summaryRows } from '@/lib/pflowSummary';
import type { PflowSummary } from '@/api/types';

const SUMMARY: PflowSummary = {
  generation_p: 226.43,
  generation_q: 49.8,
  load_p: 223.7,
  load_q: 95.4,
  shunt_p: 0,
  shunt_q: -35.33,
  loss_p: 2.73,
  loss_q: -10.27,
  slack_p: 81.43,
  slack_q: -21.62,
};

describe('summaryRows', () => {
  it('lists the rows in the order they add up, with the slack last', () => {
    expect(summaryRows(SUMMARY).map((r) => r.id)).toEqual([
      'generation',
      'load',
      'shunt',
      'loss',
      'slack',
    ]);
  });

  it('carries each figure under its row', () => {
    const rows = Object.fromEntries(summaryRows(SUMMARY).map((r) => [r.id, [r.p, r.q]]));
    expect(rows).toEqual({
      generation: [226.43, 49.8],
      load: [223.7, 95.4],
      shunt: [0, -35.33],
      loss: [2.73, -10.27],
      slack: [81.43, -21.62],
    });
  });

  it('leaves the slack row empty when the case has no slack in service', () => {
    const slack = summaryRows({ ...SUMMARY, slack_p: null, slack_q: null }).find(
      (r) => r.id === 'slack',
    );
    expect(slack).toMatchObject({ p: null, q: null });
    const absent = summaryRows({ ...SUMMARY, slack_p: undefined, slack_q: undefined }).find(
      (r) => r.id === 'slack',
    );
    expect(absent).toMatchObject({ p: null, q: null });
  });

  it('balances: generation is load plus shunts plus losses, in P and in Q', () => {
    const [gen, load, shunt, loss] = summaryRows(SUMMARY);
    expect(gen!.p! - load!.p! - shunt!.p! - loss!.p!).toBeCloseTo(0, 1);
    expect(gen!.q! - load!.q! - shunt!.q! - loss!.q!).toBeCloseTo(0, 1);
  });
});

describe('lossShare', () => {
  it('is the active loss as a percentage of the active generation', () => {
    expect(lossShare(SUMMARY)).toBeCloseTo(1.2, 1);
  });

  it('is null when nothing is generated', () => {
    expect(lossShare({ ...SUMMARY, generation_p: 0 })).toBeNull();
    expect(lossShare({ ...SUMMARY, generation_p: -5 })).toBeNull();
  });
});
