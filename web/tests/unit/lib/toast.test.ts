/**
 * Tests for the typed `toast` wrapper around sonner.
 *
 * The wrapper is a thin shim — its job is to (a) forward the right
 * options to sonner per kind (success / error / warning / info), (b)
 * normalise the returned id to a string, and (c) keep the option
 * surface narrow enough that callers can't accidentally couple to
 * sonner internals.
 *
 * We mock `sonner` at the module boundary so these tests don't depend
 * on the real provider being mounted (sonner needs a Toaster in the
 * DOM to render; here we only care that the wrapper called the API
 * with the right shape).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const successMock = vi.fn<(msg: string, opts: Record<string, unknown>) => string | number>();
const errorMock = vi.fn<(msg: string, opts: Record<string, unknown>) => string | number>();
const warningMock = vi.fn<(msg: string, opts: Record<string, unknown>) => string | number>();
const infoMock = vi.fn<(msg: string, opts: Record<string, unknown>) => string | number>();
const dismissMock = vi.fn<(id?: string) => void>();

vi.mock('sonner', () => ({
  toast: {
    success: (msg: string, opts?: unknown) =>
      successMock(msg, (opts as Record<string, unknown>) ?? {}),
    error: (msg: string, opts?: unknown) => errorMock(msg, (opts as Record<string, unknown>) ?? {}),
    warning: (msg: string, opts?: unknown) =>
      warningMock(msg, (opts as Record<string, unknown>) ?? {}),
    info: (msg: string, opts?: unknown) => infoMock(msg, (opts as Record<string, unknown>) ?? {}),
    dismiss: (id?: string) => dismissMock(id),
  },
  Toaster: () => null,
}));

import { toast } from '@/lib/toast';

beforeEach(() => {
  successMock.mockReset();
  successMock.mockReturnValue('sonner-id-1');
  errorMock.mockReset();
  errorMock.mockReturnValue('sonner-id-2');
  warningMock.mockReset();
  warningMock.mockReturnValue('sonner-id-3');
  infoMock.mockReset();
  infoMock.mockReturnValue(4);
  dismissMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('toast.success', () => {
  it('forwards a plain message with no options', () => {
    const id = toast.success('Snapshot saved');
    expect(successMock).toHaveBeenCalledTimes(1);
    expect(successMock).toHaveBeenCalledWith('Snapshot saved', {});
    expect(id).toBe('sonner-id-1');
  });

  it('forwards duration when supplied', () => {
    toast.success('Quick note', { duration: 1500 });
    expect(successMock).toHaveBeenCalledWith('Quick note', { duration: 1500 });
  });

  it('forwards description when supplied', () => {
    toast.success('Bundle exported', {
      description: 'andes-bundle-abc.zip — 1.2 MB',
    });
    expect(successMock).toHaveBeenCalledWith('Bundle exported', {
      description: 'andes-bundle-abc.zip — 1.2 MB',
    });
  });

  it('forwards an action button object verbatim', () => {
    const onClick = vi.fn();
    toast.success('Saved', { action: { label: 'Undo', onClick } });
    expect(successMock).toHaveBeenCalledWith('Saved', {
      action: { label: 'Undo', onClick },
    });
  });
});

describe('toast.error', () => {
  it('forwards the message + options for the error kind', () => {
    const onRetry = vi.fn();
    const id = toast.error('Snapshot save failed: disk full', {
      action: { label: 'Retry', onClick: onRetry },
    });
    expect(errorMock).toHaveBeenCalledWith('Snapshot save failed: disk full', {
      action: { label: 'Retry', onClick: onRetry },
    });
    expect(id).toBe('sonner-id-2');
  });

  it('keeps the success path untouched when only error is called', () => {
    toast.error('boom');
    expect(successMock).not.toHaveBeenCalled();
    expect(errorMock).toHaveBeenCalledTimes(1);
  });
});

describe('toast.warning', () => {
  it('routes to sonner.warning with the right message', () => {
    toast.warning('Connection dropped — partial buffer retained.');
    expect(warningMock).toHaveBeenCalledWith('Connection dropped — partial buffer retained.', {});
  });
});

describe('toast.info', () => {
  it('coerces a numeric id from sonner to a string', () => {
    const id = toast.info('Pinned to overlay');
    expect(infoMock).toHaveBeenCalledWith('Pinned to overlay', {});
    expect(id).toBe('4');
    expect(typeof id).toBe('string');
  });
});

describe('toast.dismiss', () => {
  it('forwards the id to sonner.dismiss', () => {
    toast.dismiss('sonner-id-1');
    expect(dismissMock).toHaveBeenCalledWith('sonner-id-1');
  });

  it('forwards undefined to dismiss-all when no id supplied', () => {
    toast.dismiss();
    expect(dismissMock).toHaveBeenCalledWith(undefined);
  });
});

describe('option mapping', () => {
  it('omits keys that the caller did not supply', () => {
    toast.success('hello', { description: 'world' });
    // No `duration` or `action` key in the forwarded options.
    expect(successMock.mock.calls[0]![1]).toEqual({ description: 'world' });
  });

  it('preserves all three opts when supplied together', () => {
    const onClick = vi.fn();
    toast.success('all-set', {
      duration: 8000,
      description: 'with detail',
      action: { label: 'Act', onClick },
    });
    expect(successMock.mock.calls[0]![1]).toEqual({
      duration: 8000,
      description: 'with detail',
      action: { label: 'Act', onClick },
    });
  });
});
