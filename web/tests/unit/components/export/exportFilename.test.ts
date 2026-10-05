/**
 * The name an exported file is saved under: one convention for every export.
 */
import { describe, expect, it } from 'vitest';
import { buildFilename, makeTimestamp, slugify } from '@/components/export/exportFilename';

describe('slugify', () => {
  it('keeps letters, digits, underscores and dashes, and turns the rest into single dashes', () => {
    expect(slugify('ieee14_full', 'case')).toBe('ieee14_full');
    expect(slugify('My Case (v2).raw', 'case')).toBe('My-Case-v2-raw');
    expect(slugify('../../etc/passwd', 'case')).toBe('etc-passwd');
  });

  it('falls back when nothing usable is left', () => {
    expect(slugify('', 'case')).toBe('case');
    expect(slugify('///', 'panel')).toBe('panel');
  });
});

describe('makeTimestamp', () => {
  it('writes a local time that is safe in a file name', () => {
    expect(makeTimestamp(new Date(2026, 4, 9, 13, 45, 22))).toBe('2026-05-09T13-45-22');
  });
});

describe('buildFilename', () => {
  const timestamp = '2026-05-09T13-45-22';

  it('joins the case, the panel, the time and the extension', () => {
    expect(
      buildFilename({
        caseName: 'ieee14',
        runId: undefined,
        panel: 'report',
        ext: 'html',
        timestamp,
      }),
    ).toBe('ieee14_report_2026-05-09T13-45-22.html');
  });

  it('puts the first eight characters of a run id after the case', () => {
    expect(
      buildFilename({
        caseName: 'kundur full',
        runId: 'abcdef1234567890',
        panel: 'time-series',
        ext: 'csv',
        timestamp,
      }),
    ).toBe('kundur-full_abcdef12_time-series_2026-05-09T13-45-22.csv');
  });
});
