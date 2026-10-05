/**
 * `generatorRowKey`: which row of the PF result's `generator_outputs` a
 * generator reads. The SLD readouts, the Inspector and the plots panel all
 * resolve a dynamic machine through it.
 */
import { describe, expect, it } from 'vitest';
import { findTopologyEntry, generatorRowKey } from '@/lib/topology';
import type { TopologyEntry, TopologySummary } from '@/api/types';

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

describe('findTopologyEntry', () => {
  const topology = (generators: TopologyEntry[]): TopologySummary => ({
    state: 'pre-setup',
    buses: [],
    lines: [],
    transformers: [],
    generators,
    loads: [],
  });
  const generators = [entry('1', 'Slack'), entry('1', 'GENROU', { bus: 1, gen: 1 })];

  it('finds the first element with the idx when the selection names no model', () => {
    expect(findTopologyEntry(topology(generators), { kind: 'generator', idx: '1' })?.kind).toBe(
      'Slack',
    );
  });

  it('finds the element of the model the selection names, among those sharing an idx', () => {
    const t = topology(generators);
    expect(findTopologyEntry(t, { kind: 'generator', idx: '1', modelClass: 'GENROU' })?.kind).toBe(
      'GENROU',
    );
    expect(findTopologyEntry(t, { kind: 'generator', idx: '1', modelClass: 'Slack' })?.kind).toBe(
      'Slack',
    );
  });

  it('falls back to the idx when no element of that model has it', () => {
    expect(
      findTopologyEntry(topology(generators), { kind: 'generator', idx: '1', modelClass: 'PV' })
        ?.kind,
    ).toBe('Slack');
  });

  it('finds nothing for an idx that is not there', () => {
    expect(findTopologyEntry(topology(generators), { kind: 'generator', idx: '9' })).toBeNull();
  });
});
