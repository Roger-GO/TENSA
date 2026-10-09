/**
 * The toast that confirms a changed value: it names the change the way Undo
 * does, says how to take it back and where the change is kept (through a
 * reload of the page, and in which file or none), and makes the toast of the
 * change before it go.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

import { announceEdit, whereEditIsKept } from '@/lib/announceEdit';
import { describeStep } from '@/lib/editSteps';
import { parseWorkspacePath } from '@/api/types';
import { useCaseStore } from '@/store/case';
import { useEditJournalStore } from '@/store/editJournal';

beforeEach(() => {
  vi.clearAllMocks();
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('cases/wscc9.xlsx'), addfiles: [] },
  });
  useEditJournalStore.getState().reset();
});

/** The id the nth toast of the test was sent with. */
function idOf(n: number): string | undefined {
  return (toastMock.success.mock.calls[n]?.[1] as { id?: string } | undefined)?.id;
}

describe('announceEdit', () => {
  it('names the value and its element, and points at Undo', () => {
    announceEdit('Line', 'Line_1', ['r']);
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    const [message, options] = toastMock.success.mock.calls[0] as [string, { description: string }];
    expect(message).toBe('Changed r of Line Line_1');
    expect(options.description).toMatch(/^Undo \(Ctrl\+Z or Edit > Undo\) takes it back\. /);
  });

  it('says that a reload keeps the change and that the case file does not hold it yet', () => {
    // Nothing said whether a value typed into a table was saved, and "saved"
    // is two things: kept by the tab, and written to the file.
    announceEdit('PQ', 'PQ_0', ['p0']);
    const [, options] = toastMock.success.mock.calls[0] as [
      string,
      { description: string; duration: number },
    ];
    expect(options.description).toBe(
      'Undo (Ctrl+Z or Edit > Undo) takes it back. A reload of the page keeps it, but it is not in wscc9.xlsx until you save the system (Workspace menu).',
    );
    // Three sentences are not read in the four seconds a toast has by default.
    expect(options.duration).toBeGreaterThanOrEqual(8000);
  });

  it('uses the words the Undo command has for the same edit', () => {
    announceEdit('Bus', '3', ['vmin']);
    const [message] = toastMock.success.mock.calls[0] as [string];
    const undo = describeStep({ op: 'edit', model: 'Bus', idx: '3', params: ['vmin'], also: 0 });
    expect(undo).toBe('change vmin of Bus 3');
    expect(message).toBe('Changed vmin of Bus 3');
  });

  it('dismisses the toast of the change before, so one is up at a time', () => {
    announceEdit('Line', 'Line_1', ['r']);
    const first = idOf(0);
    expect(first).toEqual(expect.any(String));
    toastMock.dismiss.mockClear();

    announceEdit('Line', 'Line_1', ['x']);
    expect(toastMock.dismiss).toHaveBeenCalledTimes(1);
    expect(toastMock.dismiss).toHaveBeenCalledWith(first);
    // The new toast is one of its own, not the old one with other words: a toast
    // that is on its way out would take the new words with it.
    expect(idOf(1)).toEqual(expect.any(String));
    expect(idOf(1)).not.toBe(first);
  });

  describe('whereEditIsKept', () => {
    it('says a system built here has no file yet', () => {
      useCaseStore.setState({ selection: { primaryPath: null, addfiles: [], blank: true } });
      expect(whereEditIsKept('system')).toBe(
        'A reload of the page keeps it. The system has no file yet: Workspace > Save system as writes one.',
      );
    });

    it('says a controller parameter of Edit mode is in the copy, not in the file', () => {
      expect(whereEditIsKept('copy')).toBe(
        'It is kept in a copy of the case, through a reload of the page too; the file you opened is not changed. Edit > Save parameter edits as case writes the copy out.',
      );
    });

    it('does not promise a reload keeps it once the tab cannot replay the system', () => {
      // A snapshot restore, a bundle import, a PMU or a profile: the journal
      // gives up on replaying, and a reload opens the file as it is.
      useEditJournalStore.setState({ replayable: false });
      for (const target of ['system', 'copy'] as const) {
        expect(whereEditIsKept(target)).toBe(
          'It is not saved: a reload of the page would lose it. Save the system (Workspace menu) to keep it.',
        );
      }
    });
  });
});
