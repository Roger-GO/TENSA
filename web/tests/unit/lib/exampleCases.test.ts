/**
 * What the Example cases dialog reads off a catalog entry: the file a case opens as, how its
 * size and analyses are worded, what the citations copy as, and what the filter finds.
 */
import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_LABELS,
  CASE_CATEGORIES,
  citationsText,
  companionFileNames,
  hostOf,
  isLinkOnly,
  isWebUrl,
  matchesFilter,
  primaryFileName,
  sizeText,
} from '@/lib/exampleCases';
import { makeCatalog, makeExample } from '../helpers/exampleCatalog';

const [ieee14, wscc9, texas] = makeCatalog() as [
  ReturnType<typeof makeExample>,
  ReturnType<typeof makeExample>,
  ReturnType<typeof makeExample>,
];

describe('the file a case opens as', () => {
  it('is the name the file takes in the workspace: the last part of its path', () => {
    expect(primaryFileName(ieee14)).toBe('ieee14_full.xlsx');
    expect(primaryFileName(wscc9)).toBe('wscc9.xlsx');
  });

  it('is none for a case that is only links', () => {
    expect(isLinkOnly(texas)).toBe(true);
    expect(isLinkOnly(ieee14)).toBe(false);
    expect(primaryFileName(texas)).toBeNull();
  });

  it('lists the files it is opened together with, by name', () => {
    expect(companionFileNames(ieee14)).toEqual([]);
    const raw = makeExample({
      provenance: { kind: 'bundled', path: 'pegase/case89.raw' },
      extra_files: [{ path: 'pegase/case89.dyr', sha256: 'a'.repeat(64), role: 'dynamic data' }],
    });
    expect(primaryFileName(raw)).toBe('case89.raw');
    expect(companionFileNames(raw)).toEqual(['case89.dyr']);
  });
});

describe('how a case is described', () => {
  it('words the size with the right plural', () => {
    expect(sizeText(ieee14)).toBe('14 buses, 5 generators');
    expect(sizeText(makeExample({ size: { buses: 1, generators: 1 } }))).toBe('1 bus, 1 generator');
    expect(sizeText(texas)).toBeNull();
  });

  it('names each analysis as the Run menu does', () => {
    expect(ANALYSIS_LABELS).toEqual({
      pf: 'Power flow',
      tds: 'Time domain',
      eig: 'Eigenvalues',
    });
  });

  it('groups the dynamic cases before the steady-state ones', () => {
    expect(CASE_CATEGORIES.map((c) => c.value)).toEqual(['dynamic', 'steady-state']);
  });

  it('follows only http and https addresses', () => {
    expect(isWebUrl('https://doi.org/10.1109/59.119229')).toBe(true);
    expect(isWebUrl('HTTP://example.org')).toBe(true);
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      '//example.org',
      'ftp://x.org',
      '',
    ]) {
      expect(isWebUrl(bad)).toBe(false);
    }
  });

  it('reads the host of an address, and keeps text that is not one', () => {
    expect(hostOf('https://labs.ece.uw.edu/pstca/pf14/pg_tca14bus.htm')).toBe('labs.ece.uw.edu');
    expect(hostOf('not a url')).toBe('not a url');
  });
});

describe('the citations of a case as text to copy', () => {
  it('joins them with a blank line, as `tensa examples cite` prints them', () => {
    expect(citationsText(ieee14, 'text')).toBe(
      'IEEE 14 Bus Test Case, University of Washington.\n\n' +
        'H. Cui, F. Li and K. Tomsovic, ANDES, doi:10.1109/TPWRS.2020.3017019.',
    );
    expect(citationsText(ieee14, 'bibtex')).toBe(
      '@misc{uw_ieee14,\n  title = {{IEEE} 14 Bus Test Case}\n}\n\n@article{cui2021andes,\n  title = {ANDES}\n}',
    );
  });

  it('is empty for a case with none', () => {
    expect(citationsText(texas, 'text')).toBe('');
  });
});

describe('the filter', () => {
  it('matches every word typed, in any order, in the name, id, summary, tags or analyses', () => {
    expect(matchesFilter(ieee14, '')).toBe(true);
    expect(matchesFilter(ieee14, '  ')).toBe(true);
    expect(matchesFilter(ieee14, 'IEEE')).toBe(true);
    expect(matchesFilter(ieee14, 'bus ieee')).toBe(true);
    expect(matchesFilter(ieee14, '14-bus')).toBe(true);
    expect(matchesFilter(ieee14, 'eigenvalues')).toBe(true);
    expect(matchesFilter(ieee14, '14 buses')).toBe(true);
    expect(matchesFilter(wscc9, 'eigenvalues')).toBe(false);
    expect(matchesFilter(wscc9, 'ieee')).toBe(false);
    expect(matchesFilter(texas, 'texas')).toBe(true);
  });
});
