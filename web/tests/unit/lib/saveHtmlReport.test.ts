/**
 * `saveHtmlReport`: the one path behind every control that saves the HTML
 * report, and what it tells the user about how it went.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastSuccess = vi.fn();
const toastWarning = vi.fn();
const toastError = vi.fn();
vi.mock('@/lib/toast', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    warning: (...args: unknown[]) => toastWarning(...args),
    error: (...args: unknown[]) => toastError(...args),
    info: vi.fn(),
  },
}));

const exportHtmlReport = vi.fn<() => Promise<string | null>>();
vi.mock('@/lib/exportHtmlReport', () => ({
  exportHtmlReport: () => exportHtmlReport(),
}));

import { saveHtmlReport } from '@/lib/saveHtmlReport';

beforeEach(() => {
  toastSuccess.mockReset();
  toastWarning.mockReset();
  toastError.mockReset();
  exportHtmlReport.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe('saveHtmlReport', () => {
  it('names the file it saved', async () => {
    exportHtmlReport.mockResolvedValue('ieee14_report_2026-10-05T14-02-00.html');
    await saveHtmlReport();
    expect(toastSuccess).toHaveBeenCalledWith('Exported ieee14_report_2026-10-05T14-02-00.html');
    expect(toastWarning).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('says what to do first when there is nothing to report', async () => {
    exportHtmlReport.mockResolvedValue(null);
    await saveHtmlReport();
    expect(toastWarning).toHaveBeenCalledWith('Nothing to report yet', {
      description: 'Run a power flow or a time-domain simulation first.',
    });
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('says so, with the reason, when the report cannot be saved, and does not throw', async () => {
    exportHtmlReport.mockRejectedValue(new Error('Blob URLs are blocked'));
    await expect(saveHtmlReport()).resolves.toBeUndefined();
    expect(toastError).toHaveBeenCalledWith('The report could not be saved', {
      description: 'Blob URLs are blocked',
    });
  });
});
