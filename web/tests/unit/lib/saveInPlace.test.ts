/**
 * When Save may write the open case over its own file, and what it says when not.
 */
import { describe, expect, it } from 'vitest';

import { saveInPlaceTarget } from '@/lib/saveInPlace';
import type { SaveInPlaceState } from '@/lib/saveInPlace';
import type { CaseSelection } from '@/store/case';
import { parseWorkspacePath } from '@/api/types';

const CLEAN: SaveInPlaceState = { cloneInitialized: false, replaced: false };

function file(path: string, addfiles: string[] = []): CaseSelection {
  return { primaryPath: parseWorkspacePath(path), addfiles: addfiles.map(parseWorkspacePath) };
}

describe('saveInPlaceTarget: where Save writes the open file', () => {
  it('writes an xlsx case back to its own path, as xlsx', () => {
    expect(saveInPlaceTarget(file('ieee14_full.xlsx'), CLEAN)).toEqual({
      ok: true,
      filename: 'ieee14_full.xlsx',
      format: 'xlsx',
    });
  });

  it('writes a json case back as json, and keeps a folder in the path', () => {
    expect(saveInPlaceTarget(file('cases/kundur.json'), CLEAN)).toEqual({
      ok: true,
      filename: 'cases/kundur.json',
      format: 'json',
    });
  });
});

describe('saveInPlaceTarget: where Save asks for a name instead', () => {
  it('has no file for a system built here', () => {
    const blank: CaseSelection = { primaryPath: null, addfiles: [], blank: true };
    const target = saveInPlaceTarget(blank, CLEAN);
    expect(target).toEqual({ ok: false, reason: expect.stringContaining('no file yet') });
  });

  it('has nothing to write with no case open', () => {
    expect(saveInPlaceTarget(null, CLEAN).ok).toBe(false);
  });

  it('never replaces a raw case: the raw writer leaves parts of a PSS/E case out', () => {
    const target = saveInPlaceTarget(file('ieee14.raw', ['ieee14.dyr']), CLEAN);
    expect(target).toEqual({
      ok: false,
      reason: expect.stringContaining('ieee14.raw is a .raw case'),
    });
  });

  it('never replaces a MATPOWER case, which cannot be written at all', () => {
    const target = saveInPlaceTarget(file('case9.m'), CLEAN);
    expect(target).toEqual({ ok: false, reason: expect.stringContaining('.m case') });
  });

  it('takes the extension as written, as the server does (it only accepts lower case)', () => {
    expect(saveInPlaceTarget(file('CASE.XLSX'), CLEAN).ok).toBe(false);
  });

  it('says so for a file with no extension, and does not read a dot in a folder name as one', () => {
    for (const path of ['cases.v2/ieee14', 'ieee14']) {
      const target = saveInPlaceTarget(file(path), CLEAN);
      expect(target).toEqual({
        ok: false,
        reason: expect.stringContaining('a file with no extension'),
      });
    }
  });

  it('does not replace a case that comes with companion files a save would not carry', () => {
    const target = saveInPlaceTarget(file('wscc9.xlsx', ['wscc9.dyr', 'extra.json']), CLEAN);
    expect(target).toEqual({
      ok: false,
      reason: expect.stringMatching(/wscc9\.xlsx comes with wscc9\.dyr, extra\.json/),
    });
  });

  it('does not replace a case whose parameter edits live in a copy of it', () => {
    const target = saveInPlaceTarget(file('kundur_full.xlsx'), {
      ...CLEAN,
      cloneInitialized: true,
    });
    expect(target).toEqual({
      ok: false,
      reason: expect.stringContaining('Save parameter edits as case'),
    });
  });

  it('does not replace a case after a snapshot or bundle replaced the system', () => {
    const target = saveInPlaceTarget(file('kundur_full.xlsx'), { ...CLEAN, replaced: true });
    expect(target).toEqual({
      ok: false,
      reason: expect.stringMatching(/no longer kundur_full\.xlsx with your edits/),
    });
  });
});
