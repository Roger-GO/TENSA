/**
 * Which files the workspace takes, and what to open once a group was stored. The
 * extension list and the size cap mirror the server's (`routes/workspace.py`).
 */
import { describe, expect, it } from 'vitest';

import {
  CASE_FILE_ACCEPT,
  CASE_FILE_EXTENSIONS,
  MAX_CASE_UPLOAD_BYTES,
  fileExtension,
  planOpen,
  uploadProblem,
} from '@/lib/caseUpload';

describe('fileExtension', () => {
  it('is the last extension, lower case, with its dot', () => {
    expect(fileExtension('ieee14.raw')).toBe('.raw');
    expect(fileExtension('IEEE14.RAW')).toBe('.raw');
    expect(fileExtension('case.v2.xlsx')).toBe('.xlsx');
    expect(fileExtension('case.raw.layout.json')).toBe('.json');
  });

  it('is empty for a name with no extension, and a leading dot alone is no extension', () => {
    expect(fileExtension('case')).toBe('');
    expect(fileExtension('.raw')).toBe('');
  });
});

describe('the formats the workspace holds', () => {
  it('are the five case formats, as an accept list too', () => {
    expect([...CASE_FILE_EXTENSIONS].sort()).toEqual(['.dyr', '.json', '.m', '.raw', '.xlsx']);
    expect(CASE_FILE_ACCEPT.split(',').sort()).toEqual(['.dyr', '.json', '.m', '.raw', '.xlsx']);
  });

  it('are capped at 32 MiB, as on the server', () => {
    expect(MAX_CASE_UPLOAD_BYTES).toBe(33_554_432);
  });
});

describe('uploadProblem', () => {
  it.each(['a.raw', 'a.dyr', 'a.m', 'a.xlsx', 'a.json', 'A.RAW', 'a b (2).raw'])(
    'lets %s be tried',
    (name) => {
      expect(uploadProblem({ name, size: 10 })).toBeNull();
    },
  );

  it.each(['ieee14.raw.layout.json', 'a.layout.json', 'A.Layout.JSON'])(
    'turns the layout sidecar %s away, since the server writes those itself',
    (name) => {
      const problem = uploadProblem({ name, size: 10 });
      expect(problem).toContain(name);
      expect(problem).toContain('diagram layout');
    },
  );

  it('does not take a case for a sidecar because of its name', () => {
    expect(uploadProblem({ name: 'layout.json', size: 10 })).toBeNull();
    expect(uploadProblem({ name: 'my-layout.json', size: 10 })).toBeNull();
  });

  it('accepts a file of exactly the cap', () => {
    expect(uploadProblem({ name: 'a.raw', size: MAX_CASE_UPLOAD_BYTES })).toBeNull();
  });

  it.each(['notes.txt', 'case', 'a.raw.bak', 'a.zip', '.raw', 'a.raw.'])(
    'turns %s away as not a case file, naming it and what is held',
    (name) => {
      const problem = uploadProblem({ name, size: 10 });
      expect(problem).toContain(name);
      expect(problem).toContain('not a case file');
      expect(problem).toContain('.raw, .dyr, .m, .xlsx, .json');
    },
  );

  it('turns away an empty file and one past the cap', () => {
    expect(uploadProblem({ name: 'a.raw', size: 0 })).toBe('a.raw is empty.');
    expect(uploadProblem({ name: 'big.raw', size: MAX_CASE_UPLOAD_BYTES + 1 })).toBe(
      'big.raw is larger than 32 MiB.',
    );
  });
});

describe('planOpen', () => {
  it('opens a lone case', () => {
    expect(planOpen(['ieee14.xlsx'])).toEqual({ primary: 'ieee14.xlsx', addfiles: [] });
    expect(planOpen(['kundur.m'])).toEqual({ primary: 'kundur.m', addfiles: [] });
    expect(planOpen(['case.json'])).toEqual({ primary: 'case.json', addfiles: [] });
  });

  it('pairs a .raw with the .dyr files that came with it, whatever the order', () => {
    expect(planOpen(['ieee14.dyr', 'ieee14.raw'])).toEqual({
      primary: 'ieee14.raw',
      addfiles: ['ieee14.dyr'],
    });
    expect(planOpen(['a.raw', 'a.dyr', 'b.dyr'])).toEqual({
      primary: 'a.raw',
      addfiles: ['a.dyr', 'b.dyr'],
    });
  });

  it('leaves a .dyr out of any other case, which has nothing to pair it with', () => {
    expect(planOpen(['ieee14.xlsx', 'ieee14.dyr'])).toEqual({
      primary: 'ieee14.xlsx',
      addfiles: [],
    });
  });

  it('opens nothing when there is no case, or more than one so that none is the one', () => {
    expect(planOpen([])).toBeNull();
    expect(planOpen(['ieee14.dyr'])).toBeNull();
    expect(planOpen(['a.raw', 'b.xlsx'])).toBeNull();
  });

  it('does not take a layout sidecar for a case', () => {
    expect(planOpen(['a.raw.layout.json'])).toBeNull();
    expect(planOpen(['a.raw', 'a.raw.layout.json'])).toEqual({ primary: 'a.raw', addfiles: [] });
  });
});
