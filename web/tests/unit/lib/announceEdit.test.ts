/**
 * The toast that confirms a changed value: it names the change the way Undo
 * does, says how to take it back, and makes the toast of the change before it
 * go.
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

import { announceEdit } from '@/lib/announceEdit';
import { describeStep } from '@/lib/editSteps';

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(options.description).toBe('Undo (Ctrl+Z or Edit > Undo) takes it back.');
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
});
