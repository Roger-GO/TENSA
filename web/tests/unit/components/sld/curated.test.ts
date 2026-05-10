import { describe, it, expect } from 'vitest';
import { curatedLayoutFor, basenameWithoutExt, listCuratedKeys } from '@/components/sld/curated';

describe('curated layouts', () => {
  it('ships layouts for IEEE 14 and IEEE 39', () => {
    expect(listCuratedKeys().sort()).toEqual(['ieee14', 'ieee39']);
  });

  it('returns a layout with all 14 bus coords for IEEE 14', () => {
    const layout = curatedLayoutFor('ieee14.raw');
    expect(layout).not.toBeNull();
    expect(Object.keys(layout!.coordinates).sort((a, b) => Number(a) - Number(b))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
      '12',
      '13',
      '14',
    ]);
    for (const c of Object.values(layout!.coordinates)) {
      expect(Number.isFinite(c.x)).toBe(true);
      expect(Number.isFinite(c.y)).toBe(true);
    }
  });

  it('returns a layout with all 39 bus coords for IEEE 39', () => {
    const layout = curatedLayoutFor('ieee39.raw');
    expect(layout).not.toBeNull();
    expect(Object.keys(layout!.coordinates).length).toBe(39);
  });

  it('matches case-insensitively on basename', () => {
    expect(curatedLayoutFor('IEEE14.RAW')).not.toBeNull();
    expect(curatedLayoutFor('Ieee14.raw')).not.toBeNull();
    expect(curatedLayoutFor('subdir/ieee14.xlsx')).not.toBeNull();
  });

  it('returns null for missing cases', () => {
    expect(curatedLayoutFor('ieee57.raw')).toBeNull();
    expect(curatedLayoutFor('')).toBeNull();
    expect(curatedLayoutFor('kundur.xlsx')).toBeNull();
  });
});

describe('basenameWithoutExt', () => {
  it('strips directory + extension', () => {
    expect(basenameWithoutExt('a/b/c.raw')).toBe('c');
    expect(basenameWithoutExt('c.RAW')).toBe('c');
    expect(basenameWithoutExt('c')).toBe('c');
    expect(basenameWithoutExt('a\\b\\c.json')).toBe('c');
  });

  it('preserves dotfile names', () => {
    expect(basenameWithoutExt('.gitignore')).toBe('.gitignore');
  });
});
