import { describe, expect, it } from 'vitest';
import { baseName, extensionOf, stemOf } from '@/lib/paths';

describe('baseName', () => {
  it('drops the directory, whichever slash separates it', () => {
    expect(baseName('cases/ieee14.raw')).toBe('ieee14.raw');
    expect(baseName('a/b/c.json')).toBe('c.json');
    expect(baseName('a\\b\\c.json')).toBe('c.json');
    expect(baseName('a/b\\c.xlsx')).toBe('c.xlsx');
  });

  it('leaves a bare name alone', () => {
    expect(baseName('ieee14.raw')).toBe('ieee14.raw');
    expect(baseName('')).toBe('');
  });

  it('is empty for a path that ends in a slash', () => {
    expect(baseName('cases/')).toBe('');
  });
});

describe('extensionOf', () => {
  it('gives the extension with its dot, as written', () => {
    expect(extensionOf('cases/ieee14.raw')).toBe('.raw');
    expect(extensionOf('c.RAW')).toBe('.RAW');
    expect(extensionOf('a.b.xlsx')).toBe('.xlsx');
  });

  it('is empty when the name has none', () => {
    expect(extensionOf('cases/ieee14')).toBe('');
    expect(extensionOf('')).toBe('');
  });

  it('does not take a dot in a directory for the extension', () => {
    expect(extensionOf('v1.2/ieee14')).toBe('');
    expect(extensionOf('v1.2\\ieee14')).toBe('');
  });

  it('counts a leading dot as part of the name, not an extension', () => {
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('cases/.hidden.raw')).toBe('.raw');
  });
});

describe('stemOf', () => {
  it('strips the directory and the extension', () => {
    expect(stemOf('a/b/c.raw')).toBe('c');
    expect(stemOf('c.RAW')).toBe('c');
    expect(stemOf('c')).toBe('c');
    expect(stemOf('a\\b\\c.json')).toBe('c');
    expect(stemOf('ieee14.raw')).toBe('ieee14');
  });

  it('strips only the last extension', () => {
    expect(stemOf('case.v2.xlsx')).toBe('case.v2');
  });

  it('keeps a dotfile name whole, and the stem of one that has an extension', () => {
    expect(stemOf('.gitignore')).toBe('.gitignore');
    expect(stemOf('cases/.hidden.raw')).toBe('.hidden');
  });

  it('does not take a dot in a directory for the extension', () => {
    expect(stemOf('v1.2/ieee14')).toBe('ieee14');
  });
});
