import { describe, expect, it } from 'vitest';
import { paramNumber, paramString } from '@/components/data-grid/entryParams';
import type { TopologyEntry } from '@/api/types';

const entry = {
  idx: 1,
  name: 'Bus1',
  kind: 'Bus',
  params: { Vn: 230, area: 2, owner: 'north', u: true, note: null, bad: Number.NaN },
} as unknown as TopologyEntry;

describe('paramString', () => {
  it('gives a param as text, whatever it is held as', () => {
    expect(paramString(entry, 'owner')).toBe('north');
    expect(paramString(entry, 'area')).toBe('2');
    expect(paramString(entry, 'u')).toBe('true');
  });

  it('gives null for a param that is absent or null', () => {
    expect(paramString(entry, 'zone')).toBeNull();
    expect(paramString(entry, 'note')).toBeNull();
    expect(
      paramString({ ...entry, params: undefined } as unknown as TopologyEntry, 'Vn'),
    ).toBeNull();
  });
});

describe('paramNumber', () => {
  it('gives a finite number, and null for anything else', () => {
    expect(paramNumber(entry, 'Vn')).toBe(230);
    expect(paramNumber(entry, 'owner')).toBeNull();
    expect(paramNumber(entry, 'u')).toBeNull();
    expect(paramNumber(entry, 'bad')).toBeNull();
    expect(paramNumber(entry, 'zone')).toBeNull();
  });
});
