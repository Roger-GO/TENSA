/**
 * `generatorRowKey`: which row of the PF result's `generator_outputs` a
 * generator reads. The SLD readouts, the Inspector and the plots panel all
 * resolve a dynamic machine through it.
 */
import { describe, expect, it } from 'vitest';
import { generatorRowKey } from '@/lib/topology';
import type { TopologyEntry } from '@/api/types';

const entry = (
  idx: number | string,
  kind: string,
  params: Record<string, number | string | boolean> = {},
): TopologyEntry => ({ idx, name: `e-${idx}`, kind, params });

describe('generatorRowKey', () => {
  it('reads a static generator under its own idx', () => {
    expect(generatorRowKey(entry(2, 'PV'))).toBe('2');
    expect(generatorRowKey(entry('SL', 'Slack'))).toBe('SL');
  });

  it('reads a dynamic machine under the static generator named in gen', () => {
    expect(generatorRowKey(entry('GENROU_2', 'GENROU', { bus: 2, gen: 2 }))).toBe('2');
    expect(generatorRowKey(entry('GENCLS_1', 'GENCLS', { bus: 1, gen: 'PV_1' }))).toBe('PV_1');
  });

  it('falls back to the machine idx when gen is missing or not an idx', () => {
    expect(generatorRowKey(entry('GENROU_2', 'GENROU', { bus: 2 }))).toBe('GENROU_2');
    expect(generatorRowKey(entry('GENROU_2', 'GENROU', { bus: 2, gen: true }))).toBe('GENROU_2');
    expect(generatorRowKey({ idx: 7, name: 'm', kind: 'GENROU' })).toBe('7');
  });

  it('ignores gen on a static generator', () => {
    expect(generatorRowKey(entry(3, 'PV', { gen: 9 }))).toBe('3');
  });
});
